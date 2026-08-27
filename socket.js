// socket.js
	const { Server } = require('socket.io');
	const {
  isGstApplicable,
  roundedRupeesFromPaise,
  computeBaseFareINR,  // ← add
  isEvVehicle,         // ← add
} = require('./utils/tax');
	const { sendNotificationToUser } = require('./services/notification_sender');
	const SafetyService = require('./services/safety.service');
	const { getPassengerBadge } = require('./utils/ratingUtils');
	const { logRide, logPayment } = require('./services/logService');
	const { socketLogger, fcmLogger, rideLogger } = require('./services/logger');


	const activeDrivers = {};     // { [driverId]: { socketId, latitude, longitude, vehicleType, lastSeen } }
	const activePassengers = {};  // { [passengerId]: { socketId, isForeground } }
	const rideNotifiedDrivers = {};
	const rideBlockedDrivers = {};
	const waitingTimers = {};  
	const graceTimers = {}; 
	const lastRouteSnapshotAt = {};
	global.routeDeviationConsent = {}; 
	const sosTimers = {};
	const extraDistanceTrackers = {};

	let io = null;

const STALE_SCHEDULED_RIDE_CANCEL_INTERVAL_MS = 60 * 60 * 1000;
const ACTIVE_DRIVER_GRACE_MS = 2 * 60 * 1000;
let staleScheduledRideCancelTimer = null;

function isDriverLiveOnActiveRide(driverId) {
  const d = activeDrivers[String(driverId)];
  return !!(
    d &&
    d.socketId &&
    d.isOnActiveRide === true &&
    d.lastSeen &&
    Date.now() - d.lastSeen < ACTIVE_DRIVER_GRACE_MS
  );
}

function hasPaymentOrInvoice(row) {
  const ps = String(row.payment_status || '').toUpperCase();
  const pm = String(row.payment_mode || '').toUpperCase();

  return row.invoice_id != null ||
    row.final_fare != null ||
    row.completed_at != null ||
    ['PAID', 'CASH', 'PAID_ONLINE', 'PAID_CASH'].includes(ps) ||
    ['CASH', 'ONLINE'].includes(pm);
}

async function cancelStaleScheduledRides(pool) {
  const { rows } = await pool.query(`
    SELECT
      sr.external_id,
      sr.passenger_id,
      sr.driver_id,
      sr.status,
      r.status AS ride_status,
      r.started_at,
      r.completed_at,
      r.final_fare,
      r.payment_status,
      r.payment_mode,
      ri.id AS invoice_id
    FROM scheduled_rides sr
    LEFT JOIN rides r ON r.external_id = sr.external_id
    LEFT JOIN ride_invoices ri ON ri.ride_external_id = sr.external_id
    WHERE sr.status IN ('SEARCHING', 'IN_TRANSIT')
      AND sr.scheduled_pickup_time < NOW() - INTERVAL '1 day'
  `);

  for (const row of rows) {
    const rideId = row.external_id;
    const status = String(row.status || '').toUpperCase();
    const rideStatus = String(row.ride_status || '').toUpperCase();

    if (status === 'IN_TRANSIT') {
      if (isDriverLiveOnActiveRide(row.driver_id)) continue;
      if (hasPaymentOrInvoice(row)) continue;
      if (rideStatus === 'COMPLETED') continue;
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await client.query(`
        UPDATE scheduled_rides
        SET status = 'CANCELLED',
            cancelled_at = NOW(),
            cancellation_reason = 'AUTO_CANCEL_STALE_T_PLUS_1',
            is_locked = FALSE,
            locked_until = NULL
        WHERE external_id = $1
          AND status IN ('SEARCHING', 'IN_TRANSIT')
      `, [rideId]);

      await client.query(`
        UPDATE rides
        SET status = 'CANCELLED',
            cancelled_at = NOW()
        WHERE external_id = $1
          AND status = 'IN_TRANSIT'
          AND final_fare IS NULL
          AND completed_at IS NULL
      `, [rideId]);

      await client.query('COMMIT');

      const pSock = activePassengers[String(row.passenger_id)]?.socketId;
      const dSock = row.driver_id ? activeDrivers[String(row.driver_id)]?.socketId : null;

      if (pSock) {
        io.to(pSock).emit('ride-status-update', {
          rideId,
          status: 'CANCELLED',
          reason: 'AUTO_CANCEL_STALE_T_PLUS_1',
        });
      }

      if (dSock) {
        io.to(dSock).emit('rideCancelledByPassenger', {
          rideId,
          type: 'SCHEDULED',
          message: 'Ride auto-cancelled because it was stale for more than 1 day.',
        });
      }

      console.log(`Auto-cancelled stale scheduled ride ${rideId} (${status})`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`stale auto-cancel failed for ${rideId}:`, e.message);
    } finally {
      client.release();
    }
  }
}

function startStaleScheduledRideAutoCancel(pool) {
  if (staleScheduledRideCancelTimer) return;

  const run = () => cancelStaleScheduledRides(pool).catch((e) => {
    console.error('stale auto-cancel job failed:', e.message);
  });

  staleScheduledRideCancelTimer = setInterval(
    run,
    STALE_SCHEDULED_RIDE_CANCEL_INTERVAL_MS
  );

  setTimeout(run, 10000);
}

	// distance helper
	function haversineDistanceKm(lat1, lon1, lat2, lon2) {
	  const R = 6371;
	  const dLat = (lat2 - lat1) * Math.PI / 180;
	  const dLon = (lon2 - lon1) * Math.PI / 180;
	  const a = Math.sin(dLat/2)**2 +
				Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
				Math.sin(dLon/2)**2;
	  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	  return R * c;
	}
		function buildRidePayload(ride) {
  return {
    externalId: ride.external_id,
    passengerId: ride.passenger_id,
    otp: ride.otp,
    vehicleType: ride.vehicle_type,
    distanceKm: ride.distance_km,
    sentAt: ride.requested_at || new Date().toISOString(),
    pricing: {
      final_amount: ride.estimated_fare,
      surge_multiplier: ride.surge_multiplier,
    },
    pickup: {
      latitude: ride.pickup_location.y,
      longitude: ride.pickup_location.x,
      address: ride.pickup_address,
    },
    destination: ride.dropoff_address,
  };
}


	//const roundHalfUpToInt = (v)=>{const n=Number(v)||0, f=Math.floor(n);return (n-f)>=0.5?f+1:f};
	function roundHalfUpToInt(n) {
	  const num = Number(n) || 0;
	  const f = Math.floor(num);
	  return (num - f) >= 0.5 ? f + 1 : f;
	}
	
	const path = require('path');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://jaylynn-nonsculptural-christopher.ngrok-free.dev';

function toPublicUrl(filePath) {
  if (!filePath) return null;

  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.indexOf('/uploads/');
  if (idx === -1) return null;

  return BASE_URL + normalized.substring(idx);
}


	function initSocketServer(server, pool) {
	  if (io) return io;

	  io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
	  
	  // ✅ ADD THIS BLOCK RIGHT HERE
io.use((socket, next) => {
  socket.dbPool = pool;
  socket.routeDeviationConsent = global.routeDeviationConsent;
  next();
});

startStaleScheduledRideAutoCancel(pool);

	  //
	  // Helper: fetch driver stats for given driver ids (accepted_count, rejected_count)
	  // Returns map { driverId: { accepted_count, rejected_count } }
	  //
	  async function fetchDriverStats(driverIds = []) {
		if (!driverIds.length) return {};
		try {
		  const q = await pool.query(
			`SELECT user_id::text AS user_id, accepted_count, rejected_count
			   FROM drivers
			  WHERE user_id = ANY($1::int[])`,
			[driverIds.map(id => Number(id))]
		  );
		  const map = {};
		  for (const r of q.rows) {
			map[String(r.user_id)] = { accepted_count: Number(r.accepted_count || 0), rejected_count: Number(r.rejected_count || 0) };
		  }
		  return map;
		} catch (e) {
		  console.warn('fetchDriverStats failed:', e.message);
		  return {};
		}
	  }
	  
	  function stopWaitingChargeTimer(rideId) {
  const rIdStr = String(rideId || '');
  if (!rIdStr) return false;

  if (waitingTimers[rIdStr]) {
    clearInterval(waitingTimers[rIdStr]);
    delete waitingTimers[rIdStr];
    return true;
  }

  if (waitingTimers[rideId]) {
    clearInterval(waitingTimers[rideId]);
    delete waitingTimers[rideId];
    return true;
  }

  return false;
}

	  
	  // 🧪 TESTING VERSION (Seconds based)
// function startWaitingChargeTimer(rideId, passengerId, driverId) {
    // if (!rideId || waitingTimers[rideId]) return;

    // let elapsedSeconds = 0;
    // const rIdStr = String(rideId);
    // const tableName = rIdStr.startsWith('sched_') ? 'scheduled_rides' : 'rides';
    
    // // Testing Limits
    // const FREE_LIMIT = 30; // 30 seconds free time
    // const CHARGE_PER_SECOND = 1; // ₹1 per second for testing

    // waitingTimers[rideId] = setInterval(async () => {
        // elapsedSeconds++;
        // try {
            // // 🛑 SAFETY: Check status
            // const statusCheck = await pool.query(`SELECT status FROM ${tableName} WHERE external_id = $1`, [rIdStr]);
            
            // if (statusCheck.rows.length === 0 || !['ACCEPTED', 'ARRIVED'].includes(statusCheck.rows[0].status)) {
                // console.log(`⏱️ Timer self-stopped for ${rIdStr}`);
                // clearInterval(waitingTimers[rideId]);
                // delete waitingTimers[rideId];
                // return;
            // }

            // const pSockId = activePassengers[passengerId]?.socketId;
            // const dSockId = activeDrivers[driverId]?.socketId;

            // if (elapsedSeconds > FREE_LIMIT) { 
                // // Charges start after 30 seconds
                // const totalWaitingCharge = (elapsedSeconds - FREE_LIMIT) * CHARGE_PER_SECOND;

               // await pool.query(
  // `UPDATE ${tableName} 
   // SET waiting_amount = COALESCE(waiting_amount, 0) + $1 
   // WHERE external_id = $2`,
  // [CHARGE_PER_SECOND, rIdStr]
// );

                // const updateData = { 
                    // rideId: rIdStr, 
                    // minutes: elapsedSeconds - FREE_LIMIT, 
                    // charge: totalWaitingCharge,
                    // rate: 10 // ₹10/min equivalent
                // };

                // // Pehli baar jab charge shuru ho (at 31st second)
                // if (elapsedSeconds === FREE_LIMIT + 1) {
                   // io.to(`passenger:${passengerId}`).emit('waitingStarted', updateData);
                    // io.to(`driver:${driverId}`).emit('waitingStarted', updateData);
                // } else {
                 // io.to(`passenger:${passengerId}`).emit('waitingUpdate', updateData);
				// io.to(`driver:${driverId}`).emit('waitingUpdate', updateData);
                // }
            // } else {
                // // Countdown Tick (30 down to 0)
                // const remaining = FREE_LIMIT - elapsedSeconds;
                // const tickData = { rideId: rIdStr, remainingSeconds: remaining };
                
                // io.to(`passenger:${passengerId}`).emit('waitingTick', tickData);
               // io.to(`driver:${driverId}`).emit('waitingTick', tickData);
            // }
        // } catch (err) {
            // console.error("Error in testing timer:", err);
        // }
    // }, 1000); // 🚀 1 SECOND INTERVAL FOR TESTING
// }
	  
	  //prod version
	function startWaitingChargeTimer(rideId, passengerId, driverId, startFromMinutes = 0) {
  if (!rideId) return;
  if (waitingTimers[rideId]) {
    clearInterval(waitingTimers[rideId]);
    delete waitingTimers[rideId];
  }

  let elapsedMinutes = startFromMinutes;
  const rIdStr = String(rideId);
  const tableName = rIdStr.startsWith('sched_') ? 'scheduled_rides' : 'rides';
  const FREE_MINUTES = 5;      // testing: 0, production: 5
  const CHARGE_PER_MIN = 10;
  const INTERVAL_MS = 60000;   // testing: 10000, production: 60000

  waitingTimers[rideId] = setInterval(async () => {
    elapsedMinutes++;
    try {
      const statusCheck = await pool.query(
        `SELECT status FROM ${tableName} WHERE external_id = $1`, [rIdStr]
      );
      if (statusCheck.rows.length === 0 || !['ACCEPTED', 'ARRIVED'].includes(statusCheck.rows[0].status)) {
        console.log(`⏹️ Timer auto-stopped for ${rIdStr}`);
        clearInterval(waitingTimers[rideId]);
        delete waitingTimers[rideId];
        return;
      }

      const pSockId = activePassengers[passengerId]?.socketId;
      const dSockId = activeDrivers[driverId]?.socketId;

      if (elapsedMinutes > FREE_MINUTES) {
        const chargedMinutes = elapsedMinutes - FREE_MINUTES;
        const totalCharge = chargedMinutes * CHARGE_PER_MIN;

        await pool.query(
          `UPDATE ${tableName} SET waiting_amount = COALESCE(waiting_amount, 0) + $1 WHERE external_id = $2`,
          [CHARGE_PER_MIN, rIdStr]
        );
        console.log(`💰 ₹${CHARGE_PER_MIN} added for ${rIdStr} — total ₹${totalCharge}`);

        const updateData = { rideId: rIdStr, minutes: chargedMinutes, charge: totalCharge, rate: CHARGE_PER_MIN };

        if (chargedMinutes === 1) {
          if (pSockId) io.to(pSockId).emit('waitingStarted', updateData);
          if (dSockId) io.to(dSockId).emit('waitingStarted', updateData);
          console.log(`🚨 waitingStarted emitted for ${rIdStr}`);
        } else {
          if (pSockId) io.to(pSockId).emit('waitingUpdate', updateData);
          if (dSockId) io.to(dSockId).emit('waitingUpdate', updateData);
        }
      } else {
        const remaining = Math.max(0, (FREE_MINUTES * 60) - (elapsedMinutes * 60));
        const tickData = { rideId: rIdStr, remainingSeconds: remaining };
        if (pSockId) io.to(pSockId).emit('waitingTick', tickData);
        if (dSockId) io.to(dSockId).emit('waitingTick', tickData);
        console.log(`⏱️ tick for ${rIdStr} — remaining: ${remaining}s`);
      }
    } catch (err) {
      console.error('Waiting charge error:', err.message);
    }
  }, INTERVAL_MS);
}
//prod version 

	  async function findCandidateDrivers(passengerLat, passengerLng, vehicleType, excludeSet = new Set(), radiusKm = 3.0) {
		const simpleCandidates = [];
		for (const [driverId, d] of Object.entries(activeDrivers)) {
		  if (!d) continue;
		    if (d.isOnActiveRide === true) {
    if (!d.canReceiveQueuedRide) continue;
    if (d.queuedRideId) continue;
  }
		  if (!d.vehicleType || d.vehicleType !== vehicleType) continue;
		  if (d.latitude == null || d.longitude == null) continue;
		  if (!d.lastSeen || (Date.now() - d.lastSeen) > 60 * 1000) continue; // stale
		  if (excludeSet.has(String(driverId))) continue;

		  const dist = haversineDistanceKm(passengerLat, passengerLng, d.latitude, d.longitude);
		  const distM = dist * 1000; // km → metres

		  // ── Priority bands (metres) ──────────────────────────────
		  // 0–300m   → Priority 1  (nearest, highest priority)
		  // 301–700m → Priority 2
		  // 701–1000m→ Priority 3
		  // 1001–4000m→ Priority 4
		  // >4000m   → reject, don't even add
		  let priorityBand;
		  if      (distM <= 300)  priorityBand = 1;
		  else if (distM <= 700)  priorityBand = 2;
		  else if (distM <= 1000) priorityBand = 3;
		  else if (distM <= 4000) priorityBand = 4;
		  else continue; // beyond 4km → skip entirely

		  simpleCandidates.push({ driverId: String(driverId), socketId: d.socketId, distance: dist, distM, priorityBand });
		}

		if (!simpleCandidates.length) return [];

		// fetch stats for these drivers
		const driverIds = simpleCandidates.map(c => c.driverId);
		const stats = await fetchDriverStats(driverIds);

		// compute acceptance metric
		const enhanced = simpleCandidates.map(c => {
		  const s = stats[c.driverId] || { accepted_count: 0, rejected_count: 0 };
		  const accepted = Number(s.accepted_count || 0);
		  const rejected = Number(s.rejected_count || 0);
		  // +1 in denominator to avoid divide-by-zero; this biases new drivers slightly
		  const acceptRate = accepted / (accepted + rejected + 1);
		  return { ...c, accepted, rejected, acceptRate };
		});

		// ── Sort: priority band first, then acceptRate within same band ──
		enhanced.sort((a, b) => {
		  if (a.priorityBand !== b.priorityBand) return a.priorityBand - b.priorityBand; // lower band = closer = first
		  return b.acceptRate - a.acceptRate; // within same band: higher acceptance rate first
		});

		return enhanced;
	  }
	  async function startRematchRounds(rideId, passengerSocketId, vehicleType, passengerLat, passengerLng, initialExclude = []) {
		try {
		  const excludeSet = new Set((initialExclude || []).map(String));
		  const rounds = [
			{ radiusKm: 3.0, waitMs: 6000 },
			{ radiusKm: 6.0, waitMs: 6000 },
		  ];

		  if (passengerSocketId) io.to(passengerSocketId).emit('rematchInitiated', { rideId, rounds: rounds.length });

		  for (let i = 0; i < rounds.length; i++) {
			const { radiusKm, waitMs } = rounds[i];
			const candidates = await findCandidateDrivers(passengerLat, passengerLng, vehicleType, excludeSet, radiusKm);

			if (passengerSocketId) io.to(passengerSocketId).emit('rematchRound', { rideId, round: i+1, radiusKm, candidatesCount: candidates.length });

			if (candidates.length === 0) {
			  // no candidates this round: wait and then check if ride has been assigned meanwhile
			  await new Promise(r => setTimeout(r, waitMs));
			  const s = await pool.query(`SELECT driver_id, status FROM rides WHERE external_id = $1 LIMIT 1`, [rideId]);
			  if (!s.rows.length) return;
			  if (s.rows[0].driver_id && s.rows[0].status !== 'PENDING') {
				if (passengerSocketId) io.to(passengerSocketId).emit('rematchSucceeded', { rideId, driverId: s.rows[0].driver_id });
				return;
			  }
			  continue;
			}

			// Offer to batch of candidates; exclude them for next rounds
			// Limit the number offered per round to avoid flooding
			const BATCH = 6;
			const selected = candidates.slice(0, BATCH);
			selected.forEach(c => excludeSet.add(String(c.driverId)));

			// Notify passenger how many offered
			if (passengerSocketId) io.to(passengerSocketId).emit('rematchOffered', { rideId, round: i+1, offered: selected.length });

			// Send offers with small delay strategy based on acceptRate (higher acceptRate => earlier)
			const MAX_DELAY_MS = 4000;
			const IMMEDIATE_BATCH = 3;
			selected.forEach((c, idx) => {
			  const rate = Math.max(0, Math.min(1, c.acceptRate || 0));
			  const baseDelay = (idx < IMMEDIATE_BATCH) ? 0 : Math.round((1 - rate) * MAX_DELAY_MS);
	setTimeout(() => {
  if (!rideNotifiedDrivers[rideId]) {
    rideNotifiedDrivers[rideId] = new Set();
  }

  if (rideNotifiedDrivers[rideId].has(String(c.driverId))) return;

  const cur = activeDrivers[c.driverId];
  cur.queuedRideId = cur.queuedRideId || [];
cur.queuedRideId.push(rideId);

if (cur.isOnActiveRide === true) {
  cur.queuedRideId = rideId;
}
  io.to(cur.socketId).emit('newRideRequest', {
    rideId,
    vehicleType,
    rematch: true,
    round: i + 1,
    distanceToPickup: c.distance?.toFixed(2) ?? '0.00',
  });

  rideNotifiedDrivers[rideId].add(String(c.driverId));
}, baseDelay);

			});

			// wait window for responses
			await new Promise(r => setTimeout(r, waitMs));

			// check assignment
			const s = await pool.query(`SELECT driver_id, status FROM rides WHERE external_id = $1 LIMIT 1`, [rideId]);
			if (!s.rows.length) return;
			if (s.rows[0].driver_id && s.rows[0].status !== 'PENDING') {
			  if (passengerSocketId) io.to(passengerSocketId).emit('rematchSucceeded', { rideId, driverId: s.rows[0].driver_id });
			  return;
			}
			// otherwise continue to next round
		  }
		  
rideLogger.noDriverFound(pool, {
  rideId: extId,
  passengerId,
  vehicleType: requestedVehicleType,
  searchedCount: notified,
});
		  // all rounds exhausted
		  if (passengerSocketId) io.to(passengerSocketId).emit('rematchFailed', { rideId, message: 'No drivers available right now' });
		  return;
		} catch (err) {
		  console.warn('startRematchRounds error:', err);
		  try { if (passengerSocketId) io.to(passengerSocketId).emit('rematchFailed', { rideId, message: 'Rematch error' }); } catch {}
		}
	  }


	  io.on('connection', (socket) => {
		console.log(`🔌 Socket connected: ${socket.id}`);
		
		 // 🛡️ ADMIN JOIN ROOM (SOS)
  socket.on('join_admin', ({ adminId }) => {
    socket.join('admin_room');
    console.log(`👮 Admin ${adminId || 'unknown'} joined admin_room`);
  });

		/* ---------- join ---------- */
		socket.on('join', async (payload = {}) => {
		  try {
			const userId = payload.userId?.toString();
			const role = payload.role?.toString();
			const prev = activeDrivers[userId] || {};
			let vehicleType = payload.vehicleType ? String(payload.vehicleType).toUpperCase() : null;
			if (!userId || !role) return;

			if (role === 'driver') {
			  try {
				const { rows } = await pool.query(
				  `SELECT vehicle_type FROM drivers WHERE user_id = $1`,
				  [userId]
				);
				if (rows.length && rows[0].vehicle_type) {
				  vehicleType = String(rows[0].vehicle_type).toUpperCase();
				}
			  } catch (e) { console.warn('vehicle_type fetch failed:', e.message); }

			  if (!vehicleType && payload.vehicleType) vehicleType = String(payload.vehicleType).toUpperCase();
			  
activeDrivers[userId] = {
  ...(activeDrivers[userId] || {}), // 🧠 preserve existing state
  socketId: socket.id,              // 🔌 update socket
  vehicleType,                      // 🚗 ensure vehicle type is set
  lastSeen: Date.now(),             // ⏱️ heartbeat
  isForeground: true,               // 📱 app visible
  isOnActiveRide: activeDrivers[userId]?.isOnActiveRide ?? false,
canReceiveQueuedRide: activeDrivers[userId]?.canReceiveQueuedRide ?? false,
//queuedRideId: activeDrivers[userId]?.queuedRideId ?? null,
queuedRideId: activeDrivers[userId]?.queuedRideId ?? [],
};
socket.join(`driver:${userId}`);
try {
  const rideCheck = await pool.query(
    `SELECT external_id FROM rides WHERE driver_id = $1 AND status = 'IN_TRANSIT' LIMIT 1`,
    [userId]
  );
  activeDrivers[userId].isOnActiveRide = rideCheck.rowCount > 0;
  if (rideCheck.rowCount === 0) {
    activeDrivers[userId].canReceiveQueuedRide = false;
    activeDrivers[userId].queuedRideId = [];
  }
} catch(e) { 
  activeDrivers[userId].isOnActiveRide = false; 
  
}

		if (!socket._joinedScheduledRoom) {
  socket.join('available_drivers');
  socket._joinedScheduledRoom = true;

  console.log(
    `✅ Driver ${userId} joined 'available_drivers' room (first time)`
  );
}
			  if (vehicleType) {
				socket.join(`drivers:${vehicleType}`);
				console.log(`✅ Driver ${userId} joined drivers:${vehicleType}`);
			  } else {
				console.warn(`⚠️ Driver ${userId} joined without vehicleType`);
			  }

			  try { await pool.query(`UPDATE drivers SET is_online = TRUE WHERE user_id = $1`, [userId]); }
			  catch (e) { console.warn('set is_online TRUE failed:', e.message); }
			} else if (role === 'passenger') {
			activePassengers[userId] = {
  socketId: socket.id,
  isForeground: true,
};
  socketLogger.connected(socket.id, userId, 'passenger');
			  socket.join('passengers');
			  socket.join(`passenger:${userId}`);  
			  console.log(`✅ Passenger ${userId} registered`);
			}
		  } catch (e) { console.warn('join error:', e); }
		});

// socket.on('passengerComing', async ({ rideId }) => {
  // const rIdStr = String(rideId || '');
  // if (!rIdStr) return;

  // const tableName = rIdStr.startsWith('sched_') ? 'scheduled_rides' : 'rides';

  // try {
    // const { rows } = await pool.query(
      // `SELECT driver_id, passenger_id FROM ${tableName} WHERE external_id=$1 LIMIT 1`,
      // [rIdStr]
    // );

    // const ride = rows[0];
    // stopWaitingChargeTimer(rIdStr);

    // if (ride) {
      // const pSockId = activePassengers[String(ride.passenger_id)]?.socketId;
      // const dSockId = activeDrivers[String(ride.driver_id)]?.socketId;

      // const payload = {
        // rideId: rIdStr,
        // reason: 'passenger_coming',
      // };

      // if (pSockId) io.to(pSockId).emit('waitingStopped', payload);
      // if (dSockId) io.to(dSockId).emit('waitingStopped', payload);
    // }
  // } catch (e) {
    // console.error('passengerComing failed:', e.message);
  // }
// });

socket.on('passengerComing', async ({ rideId }) => {
  const rIdStr = String(rideId || '');
  if (!rIdStr) return;

  const tableName = rIdStr.startsWith('sched_') ? 'scheduled_rides' : 'rides';

  try {
    const { rows } = await pool.query(
      `SELECT driver_id, passenger_id FROM ${tableName} WHERE external_id=$1 LIMIT 1`,
      [rIdStr]
    );

    const ride = rows[0];
    if (!ride) return;

    const passengerId = String(ride.passenger_id);
    const driverId    = String(ride.driver_id);

    // ⏸️ Waiting timer temporarily pause
    stopWaitingChargeTimer(rIdStr);

    // UI update — dono sides ko waitingStopped bhejo
    const pSockId = activePassengers[passengerId]?.socketId;
    const dSockId = activeDrivers[driverId]?.socketId;
if (pSockId) io.to(pSockId).emit('graceStarted', { rideId: rIdStr, graceSeconds: 180 }); // 3 min grace
if (dSockId) io.to(dSockId).emit('graceStarted', { rideId: rIdStr, graceSeconds: 180 });

    // 🔔 Driver screen pe "Passenger on the way" dikhao
    if (dSockId) io.to(dSockId).emit('passengerComingNotified', { rideId: rIdStr });

    // ⏳ 3 min grace — agar OTP scan nahi hua to charges restart
    const GRACE_MS = 3 * 60 * 1000;
    if (graceTimers[rIdStr]) clearTimeout(graceTimers[rIdStr]); // double-press safe

    graceTimers[rIdStr] = setTimeout(async () => {
      delete graceTimers[rIdStr];
      try {
        const { rows: statusRows } = await pool.query(
          `SELECT status FROM ${tableName} WHERE external_id=$1 LIMIT 1`,
          [rIdStr]
        );
        const currentStatus = statusRows[0]?.status;

        // Ride abhi bhi ARRIVED hai = passenger nahi aaya, OTP nahi hua
        if (currentStatus === 'ARRIVED') {
          console.log(`⏱️ Grace expired for ${rIdStr}, restarting waiting timer`);
          startWaitingChargeTimer(rIdStr, passengerId, driverId, 5);

          const pSock = activePassengers[passengerId]?.socketId;
          const dSock = activeDrivers[driverId]?.socketId;
          if (pSock) io.to(pSock).emit('waitingResumed', {
            rideId: rIdStr,
            message: 'Driver still waiting. Charges resumed.'
          });
          if (dSock) io.to(dSock).emit('waitingResumed', { rideId: rIdStr });
        }
      } catch (e) {
        console.error('Grace period check failed:', e.message);
      }
    }, GRACE_MS);

  } catch (e) {
	  socketLogger.error(socket.id, 'passengerComing failed', e);
    console.error('passengerComing failed:', e.message);
  }
});


socket.on('appVisibility', ({ passengerId, role, visible }) => {
  if (role !== 'passenger' || !passengerId) return;

  if (!activePassengers[passengerId]) {
    activePassengers[passengerId] = {};
  }

  activePassengers[passengerId] = {
    socketId: activePassengers[passengerId]?.socketId || socket.id,
    isForeground: !!visible,
  };

  console.log(
    `👁 Passenger ${passengerId} visibility = ${visible}`
  );
});

		/* ---------- driver online toggle ---------- */
		socket.on('driverOnlineToggle', async (payload = {}) => {
		  try {
			const userId = payload.userId?.toString();
			const online = !!payload.online;
			if (!userId) return;

			await pool.query(`UPDATE drivers SET is_online = $1 WHERE user_id = $2`, [online, userId]);

			if (!online) {
			  for (const room of socket.rooms) if (room.startsWith('drivers:')) socket.leave(room);
			} else {
			  try {
				const { rows } = await pool.query(`SELECT vehicle_type FROM drivers WHERE user_id = $1`, [userId]);
				if (rows.length && rows[0].vehicle_type) {
				  const vt = String(rows[0].vehicle_type).toUpperCase();
				  socket.join(`drivers:${vt}`);
				  if (activeDrivers[userId]) activeDrivers[userId].vehicleType = vt;
				  socketLogger.connected(socket.id, driverId, 'driver');
				}
			  } catch (e) { console.warn('rejoin room failed:', e.message); }
			}
			socket.emit('driverOnlineToggled', { ok: true, online });
		  } catch (e) {
			console.warn('driverOnlineToggle error:', e.message);
			socket.emit('driverOnlineToggled', { ok: false });
		  }
		});
		
socket.on('driver-go-online', async (data) => {
  try {
    const driverId = data.driverId?.toString();
    if (!driverId) return;

    // 🔐 TERMS & CONDITIONS CHECK
    const termsRes = await pool.query(
      `SELECT terms_accepted
       FROM driver_verifications
       WHERE user_id = $1`,
      [driverId]
    );

    if (!termsRes.rows[0]?.terms_accepted) {
      socket.emit('driver-online-denied', {
        code: 'TERMS_NOT_ACCEPTED',
        message: 'Please accept Terms & Conditions to go online',
      });
      return; // ⛔ HARD STOP
    }

    // ❗ MUST already exist (created during `join`)
    if (!activeDrivers[driverId]) {
      console.warn(`driver-go-online ignored: driver ${driverId} not in activeDrivers`);
      return;
    }

    // 🚗 Fetch vehicle type
    const vehicleRes = await pool.query(
      `SELECT vehicle_type FROM drivers WHERE user_id = $1`,
      [driverId]
    );

    if (!vehicleRes.rows.length || !vehicleRes.rows[0].vehicle_type) {
      console.warn(`Driver ${driverId} has no vehicle_type in DB`);
      return;
    }

    const vehicleType = vehicleRes.rows[0].vehicle_type.toUpperCase();

    // ✅ Rooms
    socket.join('available_drivers');
    socket.join(`drivers:${vehicleType}`);

    // ✅ Update memory
    activeDrivers[driverId].socketId = socket.id;
    activeDrivers[driverId].lastSeen = Date.now();

    // ✅ DB
    await pool.query(
      `UPDATE drivers SET is_online = TRUE WHERE user_id = $1`,
      [driverId]
    );

    console.log(`✅ Driver ${driverId} ONLINE (${vehicleType})`);

  } catch (e) {
    console.error('driver-go-online error:', e);
  }
});


// Handles removing a driver from the 'available_drivers' room
socket.on('driver-go-offline', async (data) => {
  try {
    const driverId = data.driverId?.toString();
    if (!driverId) return;

    // 1. Leave all rooms.
    socket.leave('available_drivers');
    console.log(`Driver ${driverId} left 'available_drivers' room.`);

    // Also leave the specific vehicle type rooms
    for (const room of socket.rooms) {
      if (room.startsWith('drivers:')) {
        socket.leave(room);
        console.log(`Driver ${driverId} left '${room}' room.`);
      }
    }
    
    // // 2. Remove from active drivers object.
    // if (activeDrivers[driverId]) {
        // delete activeDrivers[driverId];
    // }
	
	if (activeDrivers[driverId]) {
  activeDrivers[driverId].socketId = null;
  activeDrivers[driverId].isForeground = false;
  activeDrivers[driverId].lastSeen = Date.now();
}

    // 3. Update the database.
    await pool.query(`UPDATE drivers SET is_online = FALSE WHERE user_id = $1`, [driverId]);

    console.log(`❌ Driver ${driverId} is now fully offline.`);

  } catch (e) {
      console.error('Error in driver-go-offline:', e);
  }
});

		/* ---------- driver location updates ---------- */
		
		socket.on('driverLocationUpdate', async (payload = {}) => {
  try {
    const userId = payload.userId?.toString();
    const activeRideId = payload.rideId;

    if (!userId) return;

    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      console.warn(`Invalid location for driver ${userId}`);
      return;
    }

    // ===============================
    // ✅ MEMORY UPDATE (UNCHANGED)
    // ===============================
    const vehicleTypeFromPayload = payload.vehicleType
      ? String(payload.vehicleType).toUpperCase()
      : null;

    const existingDriver = activeDrivers[userId];

    if (!existingDriver) {
      activeDrivers[userId] = {
        socketId: socket.id,
        latitude,
        longitude,
        vehicleType: vehicleTypeFromPayload,
        lastSeen: Date.now(),
      };
    } else {
      existingDriver.latitude = latitude;
      existingDriver.longitude = longitude;
      existingDriver.lastSeen = Date.now();
      existingDriver.isForeground = true;

      if (
        vehicleTypeFromPayload &&
        typeof vehicleTypeFromPayload === 'string' &&
        vehicleTypeFromPayload.length > 1
      ) {
        existingDriver.vehicleType = vehicleTypeFromPayload;
      }
    }

    // ===============================
    // ✅ ROOM JOIN (UNCHANGED)
    // ===============================
    const finalVehicleType = activeDrivers[userId]?.vehicleType;
    if (finalVehicleType) {
      const room = `drivers:${finalVehicleType}`;
      if (!socket.rooms.has(room)) {
        socket.join(room);
      }
    }

    // ===============================
    // ✅ DB UPDATE (UNCHANGED)
    // ===============================
    try {
      await pool.query(
        `UPDATE drivers
         SET current_location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
             last_seen = NOW(), is_online = TRUE
         WHERE user_id = $3`,
        [latitude, longitude, userId]
      );
    } catch (e) {
      console.warn(`persist location failed`, e.message);
    }

    socket.broadcast.emit('driverLocation', { userId, latitude, longitude });

    // ===============================
    // ✅ QUEUE UNLOCK (UNCHANGED)
    // ===============================
    if (
      activeDrivers[userId]?.isOnActiveRide &&
      payload.remainingDistanceMeters <= 700
    ) {
      activeDrivers[userId].canReceiveQueuedRide = true;
    }

    // ===============================
    // 🔥 FIX START
    // ===============================
    const isOnRide = activeDrivers[userId]?.isOnActiveRide;

    if (isOnRide && activeRideId) {

      // ===============================
      // 📸 ROUTE SNAPSHOT
      // ===============================
      try {
        const now = Date.now();
        const key = String(activeRideId);

        if (!lastRouteSnapshotAt[key] || now - lastRouteSnapshotAt[key] > 15000) {
          lastRouteSnapshotAt[key] = now;

          await logRouteSnapshot(pool, {
            rideExternalId: activeRideId,
            latitude,
            longitude,
            speedKmph: payload.speed ?? null,
          });
        }
      } catch (e) {
        console.warn('route snapshot failed:', e.message);
      }

      // ===============================
      // 🚨 ROUTE DEVIATION (FIXED: NO RETURN)
      // ===============================
      try {
        socket.deviationTracker ??= {};

        const dKey = `${activeRideId}:${userId}`;
        const nowTs = Date.now();

        const deviationMeters =
          Number(payload.distanceFromSuggestedRouteM || 0);

        if (deviationMeters > 0) {
          if (deviationMeters >= SOFT_DEVIATION_DISTANCE_M) {
            if (!socket.deviationTracker[dKey]) {
              socket.deviationTracker[dKey] = { since: nowTs };
            } else {
              const durationSec =
                (nowTs - socket.deviationTracker[dKey].since) / 1000;

              await SafetyService.handleRouteDeviationSoft(socket, {
                rideExternalId: activeRideId,
                driverId: userId,
                passengerId: payload.passengerId,
                distanceMeters: deviationMeters,
                durationSeconds: durationSec,
                lat: latitude,
                lng: longitude,
                speedKmph: payload.speed ?? 0
              });
            }
          } else {
            delete socket.deviationTracker[dKey];
          }
        }
      } catch (e) {
        console.warn('route deviation failed:', e.message);
      }

      // ===============================
      // ⏳ WAITING LOGIC (UNCHANGED)
      // ===============================
      try {
        const rideCheck = await pool.query(
          `SELECT status, arrived_at, passenger_id,
                  ST_Y(pickup_location::geometry) as lat,
                  ST_X(pickup_location::geometry) as lon
           FROM rides WHERE external_id = $1`,
          [activeRideId]
        );

        if (rideCheck.rows.length > 0) {
          const ride = rideCheck.rows[0];

          if (ride.status === 'ACCEPTED' && !ride.arrived_at) {

            const distToPickup =
              haversineDistanceKm(latitude, longitude, ride.lat, ride.lon) * 1000;

            if (distToPickup <= 100) {

              await pool.query(
                `UPDATE rides SET arrived_at = NOW() WHERE external_id = $1`,
                [activeRideId]
              );

              const pId = ride.passenger_id?.toString();
              const pSockId = activePassengers[pId]?.socketId;

              const arrivalData = {
                rideId: activeRideId,
                remainingSeconds: 300
              };

              if (pSockId) io.to(pSockId).emit('waitingWarning', arrivalData);
              io.to(socket.id).emit('waitingWarning', arrivalData);

              startWaitingChargeTimer(activeRideId, pId, userId);
			  console.log(`⏳ Waiting timer started for ${activeRideId}`);
            }
          }
        }
      } catch (err) {
        console.error("Waiting charge error:", err.message);
      }

      // ===============================
      // 🛣️ EXTRA DISTANCE (UNCHANGED)
      // ===============================
      try {
        const tracker = extraDistanceTrackers[activeRideId];

        if (tracker?.approved) {
          const extraDistM =
            haversineDistanceKm(
              latitude, longitude,
              tracker.originalDropLat, tracker.originalDropLon
            ) * 1000;

          const FREE_BUFFER_M = 50;
          const SLOT_SIZE_M = 100;
          const CHARGE_PER_SLOT = 15;

          const chargeableM = Math.max(0, extraDistM - FREE_BUFFER_M);
         const extraCharge = Math.floor(chargeableM / SLOT_SIZE_M) * CHARGE_PER_SLOT;
		tracker.lastExtraCharge = extraCharge; // ✅ always latest value tracker mein

          await pool.query(
            `UPDATE rides SET extra_amount = $1 WHERE external_id = $2`,
            [extraCharge, activeRideId]
          );
		  // ── Always geocode current position → actual_dropoff_address ──
const GEOCODE_MOVE_M = 50;
const movedForGeocode = (tracker.lastGeocodedLat == null)
  ? true
  : haversineDistanceKm(latitude, longitude, tracker.lastGeocodedLat, tracker.lastGeocodedLon) * 1000 >= GEOCODE_MOVE_M;

if (movedForGeocode && !tracker.isGeocoding) {
  tracker.isGeocoding = true;
  let resolvedAddress = null;
  try {
    const gKey = process.env.GOOGLE_MAPS_API_KEY;
    if (gKey) {
      const gRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${gKey}`);
      const gData = await gRes.json();
      if (gData?.results?.[0]?.formatted_address) resolvedAddress = gData.results[0].formatted_address;
    }
  } catch(e) {}
  if (!resolvedAddress) {
    try {
      const nRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`, { headers: { 'User-Agent': 'LetsRide/1.0' } });
      const nData = await nRes.json();
      if (nData?.display_name) {
        const a = nData.address || {};
        const parts = [a.road||a.pedestrian, a.suburb||a.neighbourhood||a.village, a.city||a.county].filter(Boolean);
        resolvedAddress = parts.length >= 2 ? parts.join(', ') : nData.display_name.split(',').slice(0,3).join(',').trim();
      }
    } catch(e) {}
  }
  if (resolvedAddress) {
    tracker.actualDropoffAddress = resolvedAddress;
    tracker.lastGeocodedLat = latitude;
    tracker.lastGeocodedLon = longitude;
    await pool.query(`UPDATE rides SET actual_dropoff_address = $1 WHERE external_id = $2`, [resolvedAddress, activeRideId]);
  }
  tracker.isGeocoding = false;
}

          const pSockId = activePassengers[tracker.passengerId]?.socketId;
          const dSockId = activeDrivers[userId]?.socketId;

          const FREE_BUFFER_M_EMIT = 50;
          const updateData = {
            rideId:               activeRideId,
            extraDistanceM:       Math.round(extraDistM),
            chargeableM:          Math.round(Math.max(0, extraDistM - FREE_BUFFER_M_EMIT)),
            charge:               extraCharge,
            belowThreshold:       extraDistM < FREE_BUFFER_M_EMIT,
            actualDropoffAddress: tracker.actualDropoffAddress || null,
          };

          if (pSockId) io.to(pSockId).emit('extra_distance_update', updateData);
          if (dSockId) io.to(dSockId).emit('extra_distance_update', updateData);
        }
      } catch (e) {
        console.error('extra distance error:', e.message);
      }

    } // 🔚 ride block end

  } catch (e) {
	  socketLogger.error(socket.id, 'driverLocationUpdate error', e);
    console.warn('driverLocationUpdate error:', e);
  }
});

		/* ---------- request ride (strict 3km, prioritized notifications) ---------- */

	socket.on('requestRide', async (payload = {}) => {
  try {
    const passengerId = Number(payload.passengerId);
	 let pendingAmt = 0;
	 try {
      const penaltyRes = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS pending 
         FROM pending_payments 
         WHERE user_id = $1 AND status = 'PENDING'`,
        [passengerId]
      );
      pendingAmt = Number(penaltyRes.rows[0]?.pending || 0);
    } catch (e) {
      console.log('Penalty fetch error:', e.message);
    }
    const extId =
      (payload.rideId && String(payload.rideId)) || `ride_${Date.now()}`;

    const requestedVehicleType =
      (payload.vehicleType || '').toString().toUpperCase();

    const distanceKm = Number(payload.distanceKm) || 0;
    const pickup = payload.pickupLocation || payload.pickup || {};
    const drop = payload.destinationLocation || payload.destination || {};
    //const passengerLoc = payload.passengerLocation || pickup;
	const isScheduledRide = extId.startsWith('sched_');
	const originLat = isScheduledRide
  ? Number(pickup.latitude)
  : Number(payload.passengerLocation?.latitude ?? pickup.latitude);

const originLng = isScheduledRide
  ? Number(pickup.longitude)
  : Number(payload.passengerLocation?.longitude ?? pickup.longitude);

	

    if (
      !passengerId ||
      pickup.latitude == null ||
      pickup.longitude == null ||
      drop.latitude == null ||
      drop.longitude == null ||
      !requestedVehicleType
    ) {
      socket.emit('rideCreateError', { message: 'Missing required fields' });
      return;
    }

    // ---- Fare ----
    let finalAmountRupees = Number(payload.estimatedFare) || 0;
    const surgeMultiplier = Number(payload.surge_multiplier) || 1.0;
	const FIRST_RIDE_FREE_LIMIT_RUPEES = 700;
const wantsFirstRideFree = payload.useFirstRideFree === true;
if (pendingAmt > 0) {
   finalAmountRupees = finalAmountRupees + pendingAmt;
   console.log(`💰 Added ₹${pendingAmt} penalty to ride ${extId}. New total: ₹${finalAmountRupees}`);
}
    // ---- DB insert ----
    const pickupAddr = pickup.address || null;
    const dropAddr = drop.address || null;

    const insertSql = `
      INSERT INTO rides (
        passenger_id, pickup_location, dropoff_location,
        pickup_address, dropoff_address, status, requested_at,
        estimated_fare, vehicle_type, distance_km, external_id, surge_multiplier
      )
      VALUES (
        $1,
        ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
        ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
        $6,$7,'PENDING',NOW(),$8,$9,$10,$11,$12
      )
      RETURNING id
    `;
	setImmediate(() => {
  logRide(pool, {
    rideId: extId,
    passengerId,
    status: 'CREATED',
    paymentStatus: 'PENDING',
    fare: finalAmountRupees,
    distance_km: distanceKm,
  });
});
	
	// 🔹 Fetch passenger avg rating
let passengerAvgRating = 0;

try {
  const r = await pool.query(
    `
    SELECT
      ROUND(AVG(rating), 1) AS avg_rating
    FROM passenger_ratings
    WHERE passenger_id = $1
    `,
    [passengerId]
  );

  passengerAvgRating = Number(r.rows[0]?.avg_rating || 0);
} catch (e) {
  console.warn('Passenger rating fetch failed:', e.message);
}


    const params = [
      passengerId,
      Number(pickup.longitude),
      Number(pickup.latitude),
      Number(drop.longitude),
      Number(drop.latitude),
      pickupAddr,
      dropAddr,
      finalAmountRupees,
      requestedVehicleType,
      distanceKm,
      extId,
      surgeMultiplier
    ];

    const { rows } = await pool.query(insertSql, params);
    const dbId = rows[0].id;

    // ---- Find drivers ----
    const PROXIMITY_KM = 5.0;
    //const passengerLat = Number(passengerLoc.latitude);
    //const passengerLng = Number(passengerLoc.longitude);

   const candidates = await findCandidateDrivers(
  originLat,
  originLng,
  requestedVehicleType,
  new Set(),
  PROXIMITY_KM
);
    // ---- Payload ----
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

// 🚨 Guard first
if (
  pickup.latitude == null ||
  pickup.longitude == null
) {
  console.warn('❌ Pickup coordinates missing. Blocking ride emit.', pickup);
  socket.emit('rideCreateError', {
    message: 'Pickup location coordinates missing',
  });
  return;
}

let isPassengerFirstRide = false;
try {
const refCheck = await pool.query(
  `SELECT first_ride_free_used, first_ride_free_expires_at, referred_by_user_id
   FROM referrals
   WHERE user_id = $1
   LIMIT 1`,
  [passengerId]
);
  const ref = refCheck.rows[0];
  if (ref && !ref.first_ride_free_used && ref.referred_by_user_id) {
    const expired = ref.first_ride_free_expires_at 
      ? new Date() > new Date(ref.first_ride_free_expires_at) 
      : false;
    isPassengerFirstRide =
  wantsFirstRideFree &&
  !expired &&
  finalAmountRupees <= FIRST_RIDE_FREE_LIMIT_RUPEES;
  }
} catch(e) { /* non-fatal */ }

if (isPassengerFirstRide) {
  await pool.query(
    `UPDATE referrals
     SET first_ride_free_locked_at = NOW(),
         first_ride_free_ride_id = $1
     WHERE user_id = $2
       AND first_ride_free_used = FALSE`,
    [extId, passengerId]
  );
}

// ✅ Safe to build payload now
const rideRequestPayload = {
  externalId: extId,
  passengerId: passengerId.toString(),
  otp,
  vehicleType: requestedVehicleType,
  distanceKm,
  sentAt: new Date().toISOString(),
  penaltyAmount: pendingAmt,
    passenger: {
    avgRating: passengerAvgRating,
    badge: getPassengerBadge(passengerAvgRating),
  },

  pickup: {
    latitude: pickup.latitude,
    longitude: pickup.longitude,
    address: pickup.address,
  },
  destination: drop.address,
  pricing: {
    final_amount: finalAmountRupees,
    surge_multiplier: surgeMultiplier,
    gst_rate_percent: isGstApplicable(requestedVehicleType) ? 5 : 0,
  },
   isPassengerFirstRide: isPassengerFirstRide 
};


    let notified = 0;
    rideNotifiedDrivers[extId] = new Set();
	setTimeout(() => {
  delete rideNotifiedDrivers[extId];
}, 10 * 60 * 1000); // 10 minutes


await Promise.all(
  candidates.map(async (c) => {
    try {
      const current = activeDrivers[c.driverId];

      // 🟢 Foreground driver
      if (current?.socketId && current.isForeground === true) {

        // 🧩 Busy driver → queue
        if (current.isOnActiveRide === true) {
          await pool.query(
            `
            UPDATE rides
            SET driver_id = $1,
                status = 'QUEUED_CONFIRMED'
            WHERE external_id = $2
            `,
            [Number(c.driverId), extId]
          );
          return;
        }

        io.to(current.socketId).emit('newRideRequest', rideRequestPayload);
      }

      // 🔔 Background → push
      else {
        await sendNotificationToUser(
          c.driverId,
          '🚕 New Ride Request',
          `Pickup nearby • ₹${finalAmountRupees}`,
          {
            type: 'NEW_RIDE',
            rideId: String(extId),
            sentAt: new Date().toISOString(),
          }
        );
      }

      notified++;
      rideNotifiedDrivers[extId].add(String(c.driverId));

    } catch (e) {
      console.warn(`Notify failed for driver ${c.driverId}:`, e.message);
    }
  })
);


    // ---- ACKs ----
    socket.emit('searchStarted', {
      rideId: extId,
      notifiedDrivers: notified
    });

    socket.emit('rideCreated', {
      rideId: extId,
      dbId,
      status: 'PENDING',
      driversNotified: notified,
	   penaltyAmount: pendingAmt, 
  estimatedFare: finalAmountRupees,
  message: pendingAmt > 0 ? `₹${pendingAmt} previous waiting charge included.` : "Success"
    });

    if (notified === 0) {
      socket.emit('noDriversNearby', {
        vehicleType: requestedVehicleType,
        radiusKm: PROXIMITY_KM
      });
    }

    console.log(`🟢 Ride ${extId} created, notified ${notified} driver(s)`);
	rideLogger.created(pool, {
  rideId: extId,
  passengerId,
  vehicleType: requestedVehicleType,
  estimatedFare: finalAmountRupees,
  distanceKm,
  isScheduled: false,
});
	
	// 🔥 AUTO-EXPIRE RIDE AFTER 30 SECONDS
setTimeout(async () => {
  const result = await pool.query(
    `UPDATE rides
     SET status = 'EXPIRED'
     WHERE external_id = $1 AND status = 'PENDING'
     RETURNING external_id`,
    [extId]
  );

  if (result.rowCount > 0) {
    console.log(`⏱ Ride ${extId} expired`);

    const notifiedSet = rideNotifiedDrivers[extId] || new Set();
    for (const driverId of notifiedSet) {
      const d = activeDrivers[driverId];
      if (d?.socketId) {
        io.to(d.socketId).emit('dismissRideRequest', {
          rideId: extId,
          reason: 'timeout'
        });
      }
    }

    delete rideNotifiedDrivers[extId];
	delete rideBlockedDrivers[extId];
  }
}, 30_000);

	} catch (err) {
		socketLogger.error(socket.id, 'requestRide handler error:', e);
    console.error('requestRide handler error:', err);
    socket.emit('rideCreateError', { message: 'Internal server error' });
  }
});

socket.on('requestRideResend', async ({ rideId, driverId }) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM rides WHERE external_id = $1`,
      [rideId]
    );

    if (!rows.length) return;

    const ride = rows[0];

    const payload = {
      externalId: ride.external_id,
      passengerId: ride.passenger_id,
      vehicleType: ride.vehicle_type,
      distanceKm: ride.distance_km,
      sentAt: new Date().toISOString(),
      pickup: {
        latitude: ride.pickup_location.y,
        longitude: ride.pickup_location.x,
        address: ride.pickup_address,
      },
      destination: ride.dropoff_address,
      pricing: {
        final_amount: ride.estimated_fare,
        surge_multiplier: ride.surge_multiplier,
      },
    };

    // 🔥🔥🔥 THIS IS THE KEY LINE 🔥🔥🔥
    const dSid = activeDrivers[String(driverId)]?.socketId;
if (dSid) {
  io.to(dSid).emit('newRideRequest', payload);
}

    console.log(`🔁 Resent ride ${rideId} to driver ${driverId}`);
  } catch (e) {
	  socketLogger.error(socket.id, 'requestRideResend error', e);
    console.error('requestRideResend error:', e);
  }
});


	socket.on('driverAccept', async (payload = {}) => {
    try {
        const rideId = payload.rideId?.toString();
        const driverId = payload.driverId?.toString();
        
        if (!rideId || !driverId) return;

        // 1. Fetch Driver Details
        let driverData = {};
        try {
            const driverQuery = await pool.query(
                `SELECT
                    u.name AS driver_name,
                    u.phone_number AS contact,
                    d.vehicle_model,
                    d.vehicle_type,
                    d.rating,
                    dv.vehicle_number,
                    dv.vehicle_color, 
                    dv.driver_photo_url,
                    dv.vehicle_photo_url 
                 FROM users u
                 LEFT JOIN drivers d ON d.user_id = u.id
                 LEFT JOIN driver_verifications dv ON dv.user_id = u.id
                 WHERE u.id = $1 LIMIT 1`,
                [driverId]
            );

            if (driverQuery.rows.length > 0) {
                const row = driverQuery.rows[0];
                driverData = {
                    driverName: row.driver_name,
                    contact: row.contact,
                    vehicleModel: row.vehicle_model || row.vehicle_type,
                    vehicleNumber: row.vehicle_number,
                    rating: row.rating,
                    vehicleColor: row.vehicle_color, 
                    driverPhotoUrl: typeof toPublicUrl === 'function' ? toPublicUrl(row.driver_photo_url) : row.driver_photo_url,
                    vehiclePhotoUrl: typeof toPublicUrl === 'function' ? toPublicUrl(row.vehicle_photo_url) : row.vehicle_photo_url,
                };
            }
        } catch (e) {
			socketLogger.error(socket.id, 'Failed to fetch full driver details', e);
            console.error("Failed to fetch full driver details:", e);
        }

        // 2. Get Driver Current Location from memory
        let driverLocation = null;
        if (activeDrivers[driverId]) {
            driverLocation = { 
                latitude: activeDrivers[driverId].latitude, 
                longitude: activeDrivers[driverId].longitude 
            };
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();

        // 3. Update Ride Status (Atomic check to prevent double-acceptance)
        const rideDetails = await pool.query(
            `UPDATE rides SET
                driver_id = $1,
                otp = $2,
                status = 'ACCEPTED',
                accepted_at = NOW()
            WHERE external_id = $3
                AND status = 'PENDING' 
                AND cancelled_at IS NULL
            RETURNING
                passenger_id,
                pickup_address,
                ST_Y(pickup_location::geometry) as pickup_lat,
                ST_X(pickup_location::geometry) as pickup_lon,  
				ST_Y(dropoff_location::geometry) as drop_lat,
				ST_X(dropoff_location::geometry) as drop_lon`, 
            [driverId, otp, rideId]
        );
		
		setImmediate(() => {
  logRide(pool, {
    rideId,
    driverId,
    passengerId,
    status: 'ACCEPTED',
  });
});
        
        if (rideDetails.rowCount === 0) {
            socket.emit('rideAlreadyAccepted', {
                rideId,
                message: 'Ride already accepted by another driver'
            });
			if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = false;
}
			
			socket.emit('dismissRideRequest', {
    rideId,
    reason: 'accepted_by_other'
  });
            return;
        }
		
		// ✅ MARK DRIVER AS ON ACTIVE RIDE (VERY IMPORTANT)
if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = true;
    activeDrivers[String(driverId)].canReceiveQueuedRide = false; // 🔥 ADD
  activeDrivers[String(driverId)].queuedRideId = null;  
}


        // 4. Dismiss request for other notified drivers
        const notifiedSet = rideNotifiedDrivers[String(rideId)] || new Set();
        for (const otherDriverId of notifiedSet) {
            if (String(otherDriverId) === String(driverId)) continue;

            const d = activeDrivers[otherDriverId];
            if (d?.socketId) {
                io.to(d.socketId).emit('dismissRideRequest', {
                    rideId,
                    reason: 'accepted_by_other'
                });
            }
        }
        delete rideNotifiedDrivers[String(rideId)];

        // 5. Notify Passenger
        const passengerId = rideDetails.rows[0]?.passenger_id?.toString();
		 let passengerName = 'Passenger'; // A safe default name
        if (passengerId) {
            try {
                // Command the database to find the passenger's name
                const passengerQuery = await pool.query(
                    `SELECT name FROM users WHERE id = $1`,
                    [passengerId]
                );
                
                // If a name is found, use it!
                if (passengerQuery.rows.length > 0) {
                    passengerName = passengerQuery.rows[0].name;
                }
            } catch (e) {
                console.error("Failed to fetch passenger name:", e);
                // If it fails, passengerName will remain 'Passenger'
            }
        }
		
        if (passengerId) {
            const pSockId = activePassengers[passengerId]?.socketId;
            
       const rideAcceptedPayload = {
  rideId: rideId,
  driverId: driverId,

  driverName: driverData.driverName,
  contact: driverData.contact,

  vehicleModel: driverData.vehicleModel,
  vehicleNumber: driverData.vehicleNumber,
  vehicleColor: driverData.vehicleColor, // ✅ ADD

  otp: otp,

  pickup: {
    latitude: rideDetails.rows[0].pickup_lat,
    longitude: rideDetails.rows[0].pickup_lon,
    address: rideDetails.rows[0].pickup_address,
  },

  dropoff: {
    latitude: rideDetails.rows[0].drop_lat,
    longitude: rideDetails.rows[0].drop_lon,
    address: rideDetails.rows[0].dropoff_address,
  },

  driverLocation: driverLocation,

  driverInfo: {
    rating: driverData.rating,
  },

  // 🔥🔥🔥 THIS IS THE REAL FIX 🔥🔥🔥
  driverPhotoUrl: driverData.driverPhotoUrl
    ? toPublicUrl(driverData.driverPhotoUrl)
    : null,

  vehiclePhotoUrl: driverData.vehiclePhotoUrl
    ? toPublicUrl(driverData.vehiclePhotoUrl)
    : null,
};



            if (pSockId) {
                io.to(pSockId).emit('searchStopped', { rideId, status: 'ACCEPTED' });
                io.to(pSockId).emit('rideAccepted', rideAcceptedPayload);
				   io.to(pSockId).emit('ride-status-update', {
        rideId,
        status: 'DRIVER_EN_ROUTE',
        driverLocation,
    });
            } else {
                // Fallback to Push Notification if socket is offline
                if (typeof sendNotificationToUser === 'function') {
                   await sendNotificationToUser(
  passengerId,
  'Ride Accepted!',
  'Your driver accepted the ride.',
  {
    type: 'RIDE_ACCEPTED',
    rideId,
    sentAt: new Date().toISOString(),
  }
);
                }
            }
        }

        // 6. Acknowledge Driver
       socket.emit('driverAcceptedAck', {
  rideId,
  otp,
  message: 'Ride accepted successfully',
  passengerPickup: {
    latitude: rideDetails.rows[0].pickup_lat,
    longitude: rideDetails.rows[0].pickup_lon,
    address: rideDetails.rows[0].pickup_address
  },
   passengerName: passengerName
});

        console.log(`✅ Driver ${driverId} accepted ${rideId} for passenger ${passengerName}`);
		rideLogger.accepted(pool, {
  rideId,
  driverId,
  passengerId,
  vehicleType: rideDetails.rows[0]?.vehicle_type || null,
});

    } catch (e) {
		socketLogger.error(socket.id, 'driverAccept error', e);
        console.error('driverAccept error:', e);
    }
});

		socket.on('driverReject', async (payload = {}) => {
	  try {
		const rideId = payload.rideId?.toString();
		const driverId = payload.driverId?.toString();
		if (!rideId || !driverId) return;

		// 1. Increment rejected_count for the rejecting driver.
		try {
		  await pool.query(`UPDATE drivers SET rejected_count = COALESCE(rejected_count, 0) + 1 WHERE user_id = $1`, [driverId]);
		} catch (e) { console.warn(`increment rejected_count failed for ${driverId}:`, e.message); }
		
		setImmediate(() => {
  logRide(pool, {
    rideId,
    driverId,
    status: 'REJECTED',
  });
});
		
		const statusCheck = await pool.query(
  `SELECT status FROM rides WHERE external_id = $1`,
  [rideId]
);

if (statusCheck.rows[0]?.status !== 'PENDING') {
  console.log('❌ Rematch aborted, ride not pending');
  return;
}


		// 2. Fetch ride details needed for the rematch.
		const rideQuery = await pool.query(
		  `SELECT passenger_id, ST_Y(pickup_location::geometry) AS pickup_lat, ST_X(pickup_location::geometry) AS pickup_lon, vehicle_type
			 FROM rides WHERE external_id = $1 LIMIT 1`,
		  [rideId]
		);

		if (!rideQuery.rows.length) {
			console.warn(`driverReject: Could not find ride ${rideId} to start rematch.`);
			return;
		}
		const rideDetails = rideQuery.rows[0];
		const passengerId = rideDetails.passenger_id?.toString();
		const passengerSocketId = activePassengers[passengerId]?.socketId;
		const pickupLat = Number(rideDetails.pickup_lat);
		const pickupLon = Number(rideDetails.pickup_lon);
		const vehicleType = rideDetails.vehicle_type;

		// 3. Notify the passenger app that a rematch is starting.
		if (passengerSocketId) {
		  // This event tells the passenger's UI to show the "Finding another driver..." banner.
		  io.to(passengerSocketId).emit('rematchInitiated', { rideId, reason: 'driver_rejected' });
		}

		console.log(`🚫 Driver ${driverId} rejected ride ${rideId}. Starting rematch...`);

		rideBlockedDrivers[rideId] ??= new Set();
rideBlockedDrivers[rideId].add(String(driverId));
const rematchExclude = Array.from(rideBlockedDrivers[rideId]);

		startRematchRounds(rideId, passengerSocketId, vehicleType, pickupLat, pickupLon, rematchExclude);
		
		if (activeDrivers[driverId]?.queuedRideId === rideId) {
  //activeDrivers[driverId].queuedRideId = null;
  
  activeDrivers[driverId].queuedRideId =
  (activeDrivers[driverId].queuedRideId || []).filter(id => id !== rideId);
}

	  } catch (e) {
		  socketLogger.error(socket.id, 'driverReject:', e);
		console.warn('driverReject error:', e);
	  }
	});

		// Driver cancels after accepting -> start rematch
		// payload: { rideId, driverId, reason? }
		// socket.on('driverCancel', async (payload = {}) => {
		  // try {
			// const rideId = payload.rideId?.toString();
			// const driverId = payload.driverId?.toString();
			// const reason = payload.reason || 'cancelled_by_driver';
			// if (!rideId || !driverId) return;

			// // confirm current assignment
			// const q = await pool.query(`SELECT driver_id, status FROM rides WHERE external_id = $1 LIMIT 1`, [rideId]);
			// if (!q.rows.length) return;
			// const row = q.rows[0];
			// if (!row.driver_id || String(row.driver_id) !== String(driverId)) {
			  // console.log(`driverCancel: ignoring since ride driver mismatch for ${rideId}`);
			  // return;
			// }

			// // clear driver and set back to PENDING
			// await pool.query(
			  // `UPDATE rides SET status='PENDING', driver_id=NULL, cancelled_at=NOW(), cancelled_by='DRIVER' WHERE external_id = $1 AND driver_id = $2`,
			  // [rideId, driverId]
			// );

			// // increment rejected_count for cancelling driver
			// try {
			  // await pool.query(`UPDATE drivers SET rejected_count = COALESCE(rejected_count,0) + 1 WHERE user_id = $1`, [driverId]);
			// } catch (e) { console.warn('increment rejected_count failed:', e.message); }

			// // fetch passenger & pickup location & vehicle_type for rematch
			// const pQ = await pool.query(`SELECT passenger_id, ST_Y(pickup_location::geometry) AS pickup_lat, ST_X(pickup_location::geometry) AS pickup_lon, vehicle_type FROM rides WHERE external_id=$1 LIMIT 1`, [rideId]);
			// const passengerId = pQ.rows[0]?.passenger_id?.toString();
			// const passengerSocketId = activePassengers[passengerId]?.socketId;
			// if (passengerSocketId) {
			  // io.to(passengerSocketId).emit('driverCancelled', { rideId, driverId, reason });
			  // io.to(passengerSocketId).emit('rematchInitiated', { rideId, reason });
			// }

			// const pickupLat = Number(pQ.rows[0]?.pickup_lat || 0);
			// const pickupLon = Number(pQ.rows[0]?.pickup_lon || 0);
			// const vehicleType = pQ.rows[0]?.vehicle_type;

			// // start rematch in background excluding cancelling driver
			// startRematchRounds(rideId, passengerSocketId, vehicleType, pickupLat, pickupLon, [driverId]);

			// // acknowledge cancelling driver
			// socket.emit('driverCancelAck', {
  // rideId,
  // message: 'Ride cancelled. Finding another driver.'
// });
			// console.log(`🚫 Driver ${driverId} cancelled ride ${rideId} — rematch started`);
		  // } catch (e) {
			// console.warn('driverCancel error:', e);
		  // }
		// });
		
		socket.on('driverCancel', async (payload = {}) => {
  try {
    const rideId = payload.rideId?.toString();
    const driverId = payload.driverId?.toString();
    const reason = payload.reason || 'cancelled_by_driver';
    if (!rideId || !driverId) return;

    const isScheduledRide = rideId.startsWith('sched_');

    // =====================================================
    // 🟣 SCHEDULED RIDE CANCEL (SAFE)
    // =====================================================
    if (isScheduledRide) {
      const q = await pool.query(
        `SELECT driver_id, passenger_id
         FROM scheduled_rides
         WHERE external_id = $1
         LIMIT 1`,
        [rideId]
      );

      if (!q.rows.length) return;

      if (String(q.rows[0].driver_id) !== String(driverId)) {
        console.log(`driverCancel ignored (scheduled): driver mismatch`);
        return;
      }

      await pool.query(
        `UPDATE scheduled_rides
         SET status = 'CANCELLED', -- ✅ Use standard status
             cancelled_by = 'DRIVER', 
             is_locked = FALSE,
             locked_until = NULL,
             cancelled_at = NOW()
         WHERE external_id = $1`,
        [rideId]
      );

      const passengerId = q.rows[0].passenger_id?.toString();
      const passengerSocketId = activePassengers[passengerId]?.socketId;

      if (passengerSocketId) {
        io.to(passengerSocketId).emit('ride-status-update', {
          rideId,
          status: 'CANCELLED_BY_DRIVER',
          message: 'Driver cancelled. Finding another driver.',
        });
      }

      socket.emit('driverCancelAck', {
        rideId,
        message: 'Scheduled ride cancelled successfully.',
      });

      console.log(`🚫 Scheduled ride ${rideId} cancelled by driver ${driverId}`);
      return; // ⛔ VERY IMPORTANT
    }

    // =====================================================
    // 🟢 NORMAL RIDE CANCEL (YOUR ORIGINAL LOGIC — UNTOUCHED)
    // =====================================================
    const q = await pool.query(
      `SELECT driver_id, status FROM rides WHERE external_id = $1 LIMIT 1`,
      [rideId]
    );
    if (!q.rows.length) return;

    if (String(q.rows[0].driver_id) !== String(driverId)) {
      console.log(`driverCancel ignored (normal): driver mismatch`);
      return;
    }

    await pool.query(
      `UPDATE rides
   SET status = 'PENDING',
       driver_id = NULL,
       cancelled_by = 'DRIVER',
       cancelled_at = NULL
   WHERE external_id = $1`,
  [rideId]
    );

setImmediate(() => {
  logRide(pool, {
    rideId,
    driverId,
    status: 'CANCELLED_BY_DRIVER',
  });
});
    const pQ = await pool.query(
      `SELECT passenger_id,
              ST_Y(pickup_location::geometry) AS pickup_lat,
              ST_X(pickup_location::geometry) AS pickup_lon,
              vehicle_type
       FROM rides WHERE external_id=$1`,
      [rideId]
    );

    const passengerId = pQ.rows[0]?.passenger_id?.toString();
    const passengerSocketId = activePassengers[passengerId]?.socketId;

  if (passengerSocketId) {
  io.to(passengerSocketId).emit('driverCancelled', { rideId, driverId, reason });
  io.to(passengerSocketId).emit('rematchInitiated', { rideId, reason });
}

rideBlockedDrivers[rideId] ??= new Set();
rideBlockedDrivers[rideId].add(String(driverId));
const rematchExclude = Array.from(rideBlockedDrivers[rideId]);

startRematchRounds(
  rideId,
  passengerSocketId,
  pQ.rows[0].vehicle_type,
  pQ.rows[0].pickup_lat,
  pQ.rows[0].pickup_lon,
  rematchExclude
);

    socket.emit('driverCancelAck', {
      rideId,
      message: 'Ride cancelled. Finding another driver.',
    });

    console.log(`🚫 Normal ride ${rideId} cancelled by driver ${driverId}`);
	delete lastRouteSnapshotAt[String(rideId)];
delete global.routeDeviationConsent?.[rideId];
	delete extraDistanceTrackers[rideId];



  } catch (e) {
	  socketLogger.error(socket.id, 'driverCancel error:', e);
    console.warn('driverCancel error:', e);
  }
});

socket.on('cancelRide', async (payload = {}) => {
  try {
    const rideId = payload.rideId?.toString();
    const passengerId = payload.userId?.toString() || payload.passengerId?.toString();

    if (!rideId) return;

    console.log(`❌ Cancellation request for ${rideId} by ${passengerId || '?'}`);

    const isScheduledRide = rideId.startsWith('sched_');

    // =====================================================
    // 🟣 SCHEDULED RIDE
    // =====================================================
    if (isScheduledRide) {
      // 1️⃣ Timer cleanup
      if (waitingTimers[rideId]) {
        clearInterval(waitingTimers[rideId]);
        delete waitingTimers[rideId];
        console.log(`⏱️ Timer stopped for scheduled ride: ${rideId}`);
      }

      // 2️⃣ Get details for penalty
      const q = await pool.query(
        `SELECT driver_id, passenger_id, waiting_amount FROM scheduled_rides WHERE external_id=$1`,
        [rideId]
      );

      if (q.rows.length > 0) {
        const row = q.rows[0];
        const driverId = row.driver_id?.toString();
        const pId = row.passenger_id?.toString(); // DB se passengerId lo safer side
        const waitingAmt = parseFloat(row.waiting_amount || 0);

        // 3️⃣ Penalty Insertion
        if (waitingAmt > 0 && pId) {
          try {
            await pool.query(
              `INSERT INTO pending_payments (user_id, ride_id, driver_id, amount, status) 
               VALUES ($1, (SELECT id FROM rides WHERE external_id = $2), $3, $4, 'PENDING')`,
              [pId, rideId, driverId, waitingAmt]
            );
            console.log(`💰 Scheduled Penalty of ₹${waitingAmt} added for user ${pId}`);
          } catch (penErr) {
            console.error("Scheduled penalty insert failed:", penErr.message);
          }
        }

        // 4️⃣ Update DB status
        await pool.query(
          `UPDATE scheduled_rides SET status='CANCELLED', cancelled_at=NOW(), cancelled_by='PASSENGER' WHERE external_id=$1`,
          [rideId]
        );

        // 5️⃣ Notify Driver
        const dSid = activeDrivers[driverId]?.socketId;
        if (dSid) {
          io.to(dSid).emit('rideCancelledByPassenger', { rideId, type: 'SCHEDULED' });
        }
      }

      delete global.routeDeviationConsent?.[rideId];
      return; 
    }

    // =====================================================
    // 🟢 NORMAL RIDE
    // =====================================================

    // 1️⃣ Get details BEFORE update
    const rideRes = await pool.query(
  `SELECT id, driver_id, passenger_id, waiting_amount FROM rides WHERE external_id=$1`,
  [rideId]
);

    if (rideRes.rows.length > 0) {
      const row = rideRes.rows[0];
	  const rideDbId = row.id;    
      const driverId = row.driver_id?.toString();
      const pId = row.passenger_id?.toString();
      const waitingAmt = parseFloat(row.waiting_amount || 0);

    if (waitingTimers[rideId]) {
  clearInterval(waitingTimers[rideId]);
  delete waitingTimers[rideId];
  console.log(`⏱️ Timer stopped for normal ride: ${rideId}`);
}
if (graceTimers[rideId]) {
  clearTimeout(graceTimers[rideId]);
  delete graceTimers[rideId];
}
	  
	  const pSockId = activePassengers[pId]?.socketId;
const dSockId = driverId ? activeDrivers[driverId]?.socketId : null;
if (pSockId) io.to(pSockId).emit('waitingStopped', { rideId });
if (dSockId) io.to(dSockId).emit('waitingStopped', { rideId });

// ✅ Also reset driver active ride state
if (driverId && activeDrivers[driverId]) {
  activeDrivers[driverId].isOnActiveRide = false;
  activeDrivers[driverId].canReceiveQueuedRide = false;
}

      // 3️⃣ Penalty Insertion
      if (waitingAmt > 0 && pId) {
        try {
         await pool.query(
  `INSERT INTO pending_payments (user_id, ride_id, driver_id, amount, status) 
   VALUES ($1, $2, $3, $4, 'PENDING')`,
  [pId, rideDbId, driverId, waitingAmt]   // ✅ subquery gone, direct id use
);
          console.log(`💰 Penalty of ₹${waitingAmt} added for user ${pId}`);
        } catch (penError) {
          console.error("Penalty insertion failed:", penError.message);
        }
      }

      // 4️⃣ Update DB
      await pool.query(
        `UPDATE rides SET status='CANCELLED', cancelled_at=NOW(), cancelled_by='PASSENGER' WHERE external_id=$1`,
        [rideId]
      );

      // 5️⃣ Log & Notify
      setImmediate(() => { logRide(pool, { rideId, driverId, passengerId: pId, status: 'CANCELLED' }); });

      if (driverId && activeDrivers[driverId]?.socketId) {
        io.to(activeDrivers[driverId].socketId).emit('rideCancelledByPassenger', { rideId, type: 'NORMAL' });
        io.to(activeDrivers[driverId].socketId).emit('dismissRideRequest', { rideId, reason: 'cancelled_by_passenger' });
      }
    }

    // Dismiss other offers
    const notifiedSet = rideNotifiedDrivers[rideId] || new Set();
    for (const dId of notifiedSet) {
      if (activeDrivers[dId]?.socketId) {
        io.to(activeDrivers[dId].socketId).emit('dismissRideRequest', { rideId, reason: 'cancelled_by_passenger' });
      }
    }

    delete rideNotifiedDrivers[rideId];
	delete rideBlockedDrivers[rideId];
    delete global.routeDeviationConsent?.[rideId];
	
	// ── Cancel abuse: expire free ride offer if locked ────────────────────────
try {
  await pool.query(
    `UPDATE referrals
     SET first_ride_free_used = TRUE
     WHERE user_id = $1
       AND first_ride_free_used = FALSE
       AND first_ride_free_locked_at IS NOT NULL`,
    [passengerId]
  );
} catch (refCancelErr) {
  console.error('Referral cancel abuse update failed (non-fatal):', refCancelErr.message);
}
	

  } catch (e) {
	  socketLogger.error(socket.id, 'cancelRide error:', e);
    console.error('cancelRide error:', e);
  }
});



socket.on('driver-check-active-ride', async ({ driverId }) => {
  try {
    const q = await pool.query(
      `SELECT external_id
       FROM rides
       WHERE driver_id = $1
         AND status IN ('IN_TRANSIT')
       LIMIT 1`,
      [driverId]
    );

    if (q.rows.length > 0) {
      socket.emit('driver-active-ride-status', {
        hasActiveRide: true,
        rideId: q.rows[0].external_id,
      });
    } else {
      socket.emit('driver-active-ride-status', {
        hasActiveRide: false,
      });
    }
  } catch (e) {
	   socketLogger.error(socket.id, 'driver-check-active-ride error:', e);
    console.error('driver-check-active-ride error:', e);
    socket.emit('driver-active-ride-status', { hasActiveRide: false });
  }
});
socket.on('driverForceResetActiveRide', ({ driverId }) => {
  if (!driverId) return;
  const key = String(driverId);
  if (activeDrivers[key]) {
    activeDrivers[key].isOnActiveRide = false;
    activeDrivers[key].canReceiveQueuedRide = false;
    activeDrivers[key].queuedRideId = [];
    console.log(`🔓 Force reset isOnActiveRide for driver ${key}`);
  }
});


socket.on('verifyOtp', async (data) => {
  try {
    const { rideId, otp } = data;
    const driverId = Number(data.driverId);

    if (!rideId || !otp || !driverId || isNaN(driverId)) {
      return socket.emit('otpFailed', {
        rideId,
        message: 'Missing or invalid data for OTP verification.'
      });
    }

    // ✅ KEEP THIS ONLY ONCE (RIGHT HERE)
    const dKey = String(driverId);
    const driverSocketId = activeDrivers[dKey]?.socketId;

    const rideQuery = await pool.query(
      `SELECT otp, passenger_id,
              ST_Y(dropoff_location::geometry) AS dest_lat,
              ST_X(dropoff_location::geometry) AS dest_lon
       FROM rides
       WHERE external_id = $1 AND driver_id = $2`,
      [rideId, driverId]
    );

    if (rideQuery.rows.length === 0) {
      return socket.emit('otpFailed', {
        rideId,
        message: 'Ride not found or not assigned to you.'
      });
    }

    const ride = rideQuery.rows[0];
	const passengerId = ride.passenger_id?.toString();
const passengerSocketId = passengerId ? activePassengers[passengerId]?.socketId : null;

    if (String(ride.otp).trim() !== String(otp).trim()) {
      return socket.emit('otpFailed', {
        rideId,
        message: 'Incorrect OTP provided.'
      });
    }
	
if (waitingTimers[rideId]) {
  clearInterval(waitingTimers[rideId]);
  delete waitingTimers[rideId];
  console.log(`⏱️ Waiting timer stopped for ride ${rideId}`);
}
if (graceTimers[rideId]) {
  clearTimeout(graceTimers[rideId]);
  delete graceTimers[rideId];
}


    await pool.query(
      `UPDATE rides SET status='IN_TRANSIT', started_at=NOW()
       WHERE external_id=$1`,
      [rideId]
    );

setImmediate(() => {
  logRide(pool, {
    rideId,
    driverId,
    passengerId,
    status: 'IN_TRANSIT',
  });
});

if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = true;
   activeDrivers[String(driverId)].canReceiveQueuedRide = false; // 🔥 ADD
  activeDrivers[String(driverId)].queuedRideId = null;    
}

// 🧹 IMPORTANT: purana ride ka snapshot memory clean
delete lastRouteSnapshotAt[String(rideId)];
const freeRideCheck = await pool.query(
  `SELECT 1
   FROM referrals
   WHERE user_id = $1
     AND first_ride_free_ride_id = $2
     AND first_ride_free_used = FALSE
   LIMIT 1`,
  [ride.passenger_id, rideId]
);

const isPassengerFirstRideForOtp = freeRideCheck.rowCount > 0;

    // ✅ USE IT HERE (DON’T REDECLARE)
    if (driverSocketId) {
      io.to(driverSocketId).emit('otpVerified', {
        rideId,
		isPassengerFirstRide: isPassengerFirstRideForOtp, 
        destination: {
          latitude: ride.dest_lat,
          longitude: ride.dest_lon,
        }
      });
    }

   // const passengerId = ride.passenger_id?.toString();
   // const passengerSocketId = activePassengers[passengerId]?.socketId;

  if (passengerSocketId) {
  io.to(passengerSocketId).emit('rideStarted', {
    rideId,
    status: 'IN_TRANSIT',
    startedAt: new Date().toISOString()
  });

  io.to(passengerSocketId).emit('ride-status-update', {
    rideId,
    status: 'IN_TRANSIT'
  });
}


  } catch (e) {
	  socketLogger.error(socket.id, 'verifyOtp error:', e);
    console.error('verifyOtp error:', e);
  }
});

socket.on('verify-scheduled-otp', async (data) => {
  const client = await pool.connect();
  try {
    const { rideId, otp } = data;
	const driverId = Number(data.driverId);
    const dKey = String(driverId);
const driverSocketId = activeDrivers[dKey]?.socketId;


    if (!rideId || !otp || !driverId || isNaN(driverId)) {
      throw new Error('Invalid data received for OTP verification.');
    }

    await client.query('BEGIN');

    const scheduledRideQuery = await client.query(
      `SELECT *,
              ST_Y(dropoff_location::geometry) AS dropoff_latitude,
              ST_X(dropoff_location::geometry) AS dropoff_longitude
         FROM scheduled_rides
        WHERE external_id = $1 AND driver_id = $2`,
      [rideId, driverId]
    );

    if (scheduledRideQuery.rows.length === 0) {
      throw new Error('Scheduled ride not found or not assigned to you.');
    }

    const s_ride = scheduledRideQuery.rows[0];

    // ------------------- OTP FIX -------------------
    const otpFromDb = String(s_ride.otp ?? "").trim();
    const otpFromClient = String(otp ?? "").trim();

    if (otpFromDb !== otpFromClient) {
      throw new Error("Incorrect OTP.");
    }
    // ------------------------------------------------

    await client.query(
        `INSERT INTO rides (
            external_id, passenger_id, driver_id, pickup_location, dropoff_location,
            pickup_address, dropoff_address, status, vehicle_type, estimated_fare,
            distance_km, otp, surge_multiplier, accepted_at, started_at, requested_at,ride_type,waiting_amount
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_TRANSIT',$8,$9,$10,$11,$12,$13,NOW(),$14,'SCHEDULED', $15)
         ON CONFLICT (external_id) DO NOTHING`,
        [
          s_ride.external_id,
          s_ride.passenger_id,
          s_ride.driver_id,
          s_ride.pickup_location,
          s_ride.dropoff_location,
          s_ride.pickup_address,
          s_ride.dropoff_address,
          s_ride.vehicle_type,
          s_ride.estimated_fare,
          s_ride.distance_km,
          s_ride.otp,
          s_ride.surge_multiplier,
          s_ride.accepted_at,
          s_ride.scheduled_pickup_time,
		  s_ride.waiting_amount || 0,   
        ]
    );

    await client.query(`UPDATE scheduled_rides SET status='IN_TRANSIT' WHERE external_id=$1`, [rideId]);
    await client.query(`UPDATE rides SET status='IN_TRANSIT', started_at=NOW() WHERE external_id=$1`, [rideId]);
	
	if (waitingTimers[rideId]) {
  clearInterval(waitingTimers[rideId]);
  delete waitingTimers[rideId];
  console.log(`⏱️ Waiting timer stopped for scheduled ride ${rideId}`);
}
	
if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = true;
}

    const passengerId = s_ride.passenger_id.toString();
    const passengerSocketId = activePassengers[passengerId]?.socketId;
    if (driverSocketId) {
      io.to(driverSocketId).emit("otpVerified", {
        rideId,
        destination: {
        latitude: s_ride.dropoff_latitude,
      longitude: s_ride.dropoff_longitude
        },
        dropoffAddress: s_ride.dropoff_address
      });
	  
    }

    if (passengerSocketId) {
      io.to(passengerSocketId).emit("rideStarted", {
        rideId,
        startedAt: new Date().toISOString()
      });
	  
	  if (passengerSocketId) {
  io.to(passengerSocketId).emit('ride-status-update', {
    rideId,
    status: 'IN_TRANSIT'
  });
}

    }

    await client.query("COMMIT");
    console.log(`🚀 Scheduled OTP verified for ${rideId}`);

  } catch (err) {
    await client.query("ROLLBACK");
	socketLogger.error(socket.id, 'verify-scheduled-otp error:', e);
    console.error(`❌ verify-scheduled-otp failed:`, err);
    socket.emit("otpFailed", { rideId: data.rideId, message: err.message });
  } finally {
    client.release();
  }
});

socket.on('completeRide', async (payload = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let { rideId, driverId, passengerId, paidByCash } = payload;
    rideId = rideId?.toString();
    driverId = driverId?.toString();
    passengerId = passengerId?.toString();

    if (!rideId || !driverId) {
      console.warn('completeRide called with missing rideId or driverId');
      await client.query('ROLLBACK');
      //client.release();
      return;
    }

const rideQuery = await client.query(
  `SELECT external_id, passenger_id, driver_id, vehicle_type,
      pickup_address, dropoff_address, requested_at,
      estimated_fare, surge_multiplier,
      waiting_amount, extra_amount,
      COALESCE(actual_dropoff_address, '') AS actual_dropoff_address,
      COALESCE((
        SELECT SUM(amount) FROM pending_payments 
        WHERE user_id = r.passenger_id AND status IN ('PENDING','PAID')
          AND paid_in_ride_id = r.id
      ), 0) AS penalty_collected
   FROM rides r WHERE external_id = $1 LIMIT 1`,
  [rideId]
);

    if (rideQuery.rows.length === 0) {
      console.error(`completeRide: Ride with ID ${rideId} not found.`);
      await client.query('ROLLBACK');
      //client.release();
      return;
    }
    const rideRow = rideQuery.rows[0];
	
	 const tollRes = await client.query(
      `SELECT COALESCE(SUM(toll_amount), 0) AS toll_total
       FROM toll_charges
       WHERE (ride_id = $1 OR scheduled_ride_id = $1)
         AND passenger_status = 'APPROVED'`,
      [rideId]
    );
   const tollAmt = parseFloat(tollRes.rows[0]?.toll_total || 0);
   const waitingAmt  = Math.round(Number(rideRow.waiting_amount || 0));
   // ✅ Tracker se lo (most accurate) — DB mein race condition ho sakti hai
const trackerExtra = extraDistanceTrackers[rideId]?.approved
  ? extraDistanceTrackers[rideId].lastExtraCharge || 0
  : 0;
const extraAmt = Math.round(
  trackerExtra > 0 ? trackerExtra : Number(rideRow.extra_amount || 0)
); 


const penaltyAmt = Math.round(Number(rideRow.penalty_collected || 0));
const baseFareTotal = Math.round(Number(rideRow.estimated_fare || 0)) - penaltyAmt;
const finalTotalR = baseFareTotal + waitingAmt + extraAmt + tollAmt + penaltyAmt;

await client.query(
  `UPDATE rides SET status = 'COMPLETED', final_fare = $1,
   payment_mode = $3, completed_at = NOW() WHERE external_id = $2`,
  [finalTotalR, rideId, paidByCash ? 'CASH' : 'ONLINE']
);
    if (rideId.startsWith('sched_')) {
      await client.query(`UPDATE scheduled_rides SET status = 'COMPLETED' WHERE external_id = $1`, [rideId]);
    }

    // --- 💎 YOUR NEW, CORRECT DECIMAL FINANCIAL CALCULATIONS 💎 ---
     const isGstApplicableRide = isGstApplicable(rideRow.vehicle_type);
    const divisor = isGstApplicableRide ? 1.05 : 1.0;

    // ✅ FIX 3: Breakdown calculations based on FIXED baseFareTotal (228)
    const baseExactR = baseFareTotal / divisor;          
    const totalGstExactR = baseFareTotal - baseExactR;
    const cgstR_exact = totalGstExactR / 2;
    const sgstR_exact = totalGstExactR / 2;
    const platformBaseShareR_exact = baseExactR * 0.03;  

    // ✅ FIX 4: Driver Share (Ab ye 300.16 aayega rounded to 300)
    const driverBaseShareR_exact = (baseExactR * 0.97) + waitingAmt + extraAmt + tollAmt; 
    const driverShareRounded = Math.floor(driverBaseShareR_exact);
    
    const surgeMultiplier = Number(rideRow.surge_multiplier) || 1.0;
    const surgeR_exact = baseExactR - (baseExactR / surgeMultiplier);
    // --- END OF CALCULATIONS ---


    // --- GST Ledger Insert (Now uses correct decimal variables) ---
    const paymentMode = paidByCash ? 'OFFLINE_CASH' : 'ONLINE';
    await client.query(
      `INSERT INTO gst_ledger (
         ride_external_id, driver_id, passenger_id, total_fare_paise,
         base_fare_paise, cgst_paise, sgst_paise, total_gst_paise, payment_mode
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (ride_external_id) DO NOTHING`,
      [
        rideId, rideRow.driver_id, rideRow.passenger_id, finalTotalR,
        baseExactR, cgstR_exact, sgstR_exact, totalGstExactR, paymentMode
      ]
    );

    // --- Wallet Ledger Logic (Now uses correct rounding at the end) ---
    if (paidByCash) {
        // Driver owes (Commission + GST)
        const companyOwedExact = platformBaseShareR_exact + totalGstExactR; // e.g. 76.95
        const companyOwedRounded = Math.floor(companyOwedExact);  // e.g. 77
        if (companyOwedRounded > 0) {
            const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await client.query(
                `INSERT INTO wallet_ledger (driver_id, ride_external_id, type, direction, amount_paise, note, due_date, is_settled)
                 VALUES ($1, $2, 'CASH_RECEIVED', 'DR', $3, 'Platform Share + GST from Cash Ride', $4, FALSE)
                 ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
                [Number(driverId), rideId, companyOwedRounded, dueDate] // Storing final rounded Rupee
            );
        }
    } else { // Online Ride
        // Company owes driver his 97% share
     
        if (driverShareRounded > 0) {
            await client.query(
                `INSERT INTO wallet_ledger (driver_id, ride_external_id, type, direction, amount_paise, note)
                 VALUES ($1, $2, 'CREDIT_ONLINE', 'CR', $3, 'Driver Earning from Online Ride')
                 ON CONFLICT (driver_id, ride_external_id, type) DO UPDATE SET amount_paise = EXCLUDED.amount_paise`,
                [Number(driverId), rideId, driverShareRounded] // Always update to latest correct amount
            );
        }
    }

    // --- Your perfect wallet balance update remains ---
    await client.query(`INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,[Number(driverId)]);
    await client.query(
      `UPDATE driver_wallets SET balance_paise = (
          SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount_paise ELSE -amount_paise END), 0)
          FROM wallet_ledger WHERE driver_id = $1
      ) WHERE driver_id = $1`,
      [Number(driverId)]
    );
	
	const totalExactR =
  baseExactR + surgeR_exact + cgstR_exact + sgstR_exact;

// ✅ FINAL PAYABLE (ROUNDED)
const finalRoundedR = Math.round(totalExactR + waitingAmt + extraAmt + tollAmt);

	// --- Ride Invoice Insert (Now uses correct decimal variables) ---
	const { rows: ins } = await client.query(
      `INSERT INTO ride_invoices (
        ride_external_id, passenger_id, driver_id, vehicle_type, pickup_address, dropoff_address,actual_dropoff_address,
        ride_started_at, ride_completed_at, base_amount_paise, surge_amount_paise,
        cgst_paise, sgst_paise, total_paise, rounded_rupees,
        waiting_amount,extra_amount,toll_amount,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,$16,$17,$18,NOW())
      ON CONFLICT (ride_external_id) DO UPDATE SET
        base_amount_paise  = EXCLUDED.base_amount_paise,
        surge_amount_paise = EXCLUDED.surge_amount_paise,
        cgst_paise         = EXCLUDED.cgst_paise,
        sgst_paise         = EXCLUDED.sgst_paise,
        total_paise        = EXCLUDED.total_paise,
        rounded_rupees     = EXCLUDED.rounded_rupees,
		 toll_amount    = EXCLUDED.toll_amount,
        waiting_amount     = EXCLUDED.waiting_amount,
		extra_amount       = EXCLUDED.extra_amount,
		actual_dropoff_address = EXCLUDED.actual_dropoff_address
      RETURNING id`,
      [
        rideRow.external_id, rideRow.passenger_id, Number(driverId), rideRow.vehicle_type,
        rideRow.pickup_address, rideRow.dropoff_address,rideRow.actual_dropoff_address || null, rideRow.requested_at, new Date(),
        baseExactR,
        surgeR_exact,
        cgstR_exact,
        sgstR_exact,
        finalRoundedR,  // total_paise
        finalRoundedR,  // rounded_rupees
        waitingAmt,      // ✅ $15 — waiting_amount
		extraAmt, 
		tollAmt,
      ]
    );
	const invoiceId = ins[0].id;
	const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	await client.query(`UPDATE ride_invoices SET invoice_number = 'LR' || $1::text || LPAD(id::text, 6, '0') WHERE id = $2 AND (invoice_number IS NULL OR invoice_number = '')`,[ymd, invoiceId]);
	console.log(`🧾 Auto-invoice upserted for ${rideId}`);
	
	// --- Inside socket.on('completeRide', ...) ---
const pendingWaitingCredits = await client.query(
  `
  SELECT driver_id, COALESCE(SUM(amount), 0) AS amount
  FROM pending_payments
  WHERE user_id = $1
    AND status = 'PENDING'
    AND driver_id IS NOT NULL
  GROUP BY driver_id
  `,
  [passengerId]
);

const pendingWaitingTotal = pendingWaitingCredits.rows.reduce(
  (sum, row) => sum + Math.round(Number(row.amount || 0)),
  0
);

if (paidByCash && pendingWaitingTotal > 0) {
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await client.query(
    `UPDATE wallet_ledger
       SET amount_paise = amount_paise + $1,
           note = note || ' + ₹' || $1::text || ' prev waiting collected'
     WHERE driver_id = $2
       AND ride_external_id = $3
       AND type = 'CASH_RECEIVED'`,
    [pendingWaitingTotal, Number(driverId), rideId]
  );
}

for (const row of pendingWaitingCredits.rows) {
  const waitingCredit = Math.round(Number(row.amount || 0));
  if (waitingCredit > 0) {
    await client.query(
      `
      INSERT INTO wallet_ledger
        (driver_id, ride_external_id, type, direction, amount_paise, note)
      VALUES
        ($1, $2, 'WAITING_CREDIT', 'CR', $3, $4)
      ON CONFLICT (driver_id, ride_external_id, type)
      DO UPDATE SET amount_paise = wallet_ledger.amount_paise + EXCLUDED.amount_paise
      `,
      [
        row.driver_id,
        rideId,
        waitingCredit,
        `Waiting charges collected from passenger on ride ${rideId}`,
      ]
    );
	 await client.query(
      `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
      [row.driver_id]
    );
    await client.query(
      `UPDATE driver_wallets
         SET balance_paise = (
           SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount_paise ELSE -amount_paise END), 0)
           FROM wallet_ledger WHERE driver_id = $1
         )
       WHERE driver_id = $1`,
      [row.driver_id]
    );
  }
}

await client.query(
  `UPDATE pending_payments 
   SET status = 'PAID',
       paid_in_ride_id = (SELECT id FROM rides WHERE external_id = $2 LIMIT 1)
   WHERE user_id = $1 AND status = 'PENDING'`,
  [passengerId, rideId]
);
console.log(`✅ Previous penalties cleared for passenger ${passengerId}`);

// --- COMMIT FIRST ---
await client.query('COMMIT');


setImmediate(() => {
  logRide(pool, {
    rideId,
    driverId,
    passengerId,
    status: 'COMPLETED',
    paymentStatus: paidByCash ? 'CASH' : 'ONLINE',
    fare: finalTotalR,
  });
  
  rideLogger.completed(pool, {
  rideId,
  driverId,
  passengerId,
  finalFare: finalTotalR,
  paymentMode: paidByCash ? 'CASH' : 'ONLINE',
  distanceKm: rideRow.distance_km || null,
});

  logPayment(pool, {
    rideId,
    driverId,
    passengerId,
    amount: finalTotalR,
    paymentMode: paidByCash ? 'CASH' : 'ONLINE',
    status: 'SUCCESS',

    // 🔥🔥🔥 ADD THIS 🔥🔥🔥
    orderId: payload.razorpay_order_id || null,
    paymentId: payload.razorpay_payment_id || null,

    meta: {
      source: paidByCash ? 'cash' : 'razorpay',
    },
  });
});
delete lastRouteSnapshotAt[String(rideId)];
// ── REFERRAL: First ride free check + bonus ──────────────────────────────
setImmediate(async () => {
  try {
    // 1. Check karo ki kya ye is passenger ki pehli ride thi (Referral linked)
 const refCheck = await pool.query(
  `SELECT id, referred_by_user_id, referrer_benefit_amount, first_ride_free_used
   FROM referrals
   WHERE user_id = $1
     AND first_ride_free_ride_id = $2
     AND first_ride_free_locked_at IS NOT NULL
   LIMIT 1`,
  [passengerId, rideId]
);

    if (refCheck.rows.length > 0) {
      const ref = refCheck.rows[0];

      // 2. Sirf tabhi bonus do agar pehle use NAHI hua hai (first_ride_free_used = FALSE)
      if (ref.first_ride_free_used === false) {
        
        // A. Mark first ride as used
        await pool.query(
          `UPDATE referrals SET 
            first_ride_free_used = TRUE, 
            first_ride_free_ride_id = $2 
           WHERE user_id = $1`,
          [passengerId, rideId]
        );

        // B. Agar kisi ne refer kiya hai (referred_by_user_id exists)
        if (ref.referred_by_user_id) {
          const bonusAmount = ref.referrer_benefit_amount || 50;
          const bonusPaise = bonusAmount; // Kyunki hum wallet mein seedha Rupee store kar rahe hain aapke logic ke hisaab se

          // C. Referrer (Driver/Friend) ke wallet mein paisa daalo
          await pool.query(
            `INSERT INTO wallet_ledger (
               driver_id, ride_external_id, type, direction, amount_paise, note
             ) VALUES ($1, $2, 'REFERRAL_BONUS', 'CR', $3, 'Referral bonus — your friend completed their first ride')
             ON CONFLICT DO NOTHING`,
            [ref.referred_by_user_id, rideId, bonusPaise]
          );

          // D. Driver ka wallet balance refresh karo
          await pool.query(
            `UPDATE driver_wallets SET balance_paise = (
                SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount_paise ELSE -amount_paise END), 0)
                FROM wallet_ledger WHERE driver_id = $1
            ) WHERE driver_id = $1`,
            [ref.referred_by_user_id]
          );
		  
		  await pool.query(
  `INSERT INTO platform_ledger (ride_external_id, type, direction, amount_paise, note)
   VALUES ($1, 'REFERRAL_SUBSIDY', 'DR', $2, 
   'First ride free — company owes driver ₹' || $3)
   ON CONFLICT (ride_external_id, type) DO NOTHING`,
  [rideId, driverShareRounded * 100, driverShareRounded]
);

          // E. Notify Referrer (Agar online hai toh)
          const refDriverSockId = activeDrivers[String(ref.referred_by_user_id)]?.socketId;
         io.to(refDriverSockId).emit('first_ride_company_pay', {
  rideId,
  referralBonus: bonusAmount,           // ₹50 referral bonus
  ideFare: driverShareRounded,
  rideFare: _driverFareForReferral,     // actual 97%+waiting+extra
  totalOwed: _driverFareForReferral + bonusAmount,
  message: `🎁 Free ride completed!\n\nCompany will pay you:\n• Ride fare: ₹${_driverFareForReferral} (97% + charges)\n• Referral bonus: ₹${bonusAmount}\n• Total: ₹${_driverFareForReferral + bonusAmount}\n\nPayment within 7 days.`,
});
          console.log(`💰 Referral bonus ₹${bonusAmount} given to User ${ref.referred_by_user_id}`);
		  
		  
        }
      }
    }
  } catch (refErr) {
    console.error('❌ Referral post-ride error:', refErr.message);
  }
});


// ===============================
// 🚀 AUTO-ASSIGN QUEUED RIDE
// ===============================
const nextRideRes = await pool.query(`
  SELECT *
  FROM rides
  WHERE driver_id = $1
    AND status = 'QUEUED_CONFIRMED'
  ORDER BY id ASC
  LIMIT 1
`, [Number(driverId)]);

if (nextRideRes.rows.length > 0) {
  const nextRide = nextRideRes.rows[0];

  await pool.query(`
    UPDATE rides
    SET status = 'PENDING'
    WHERE id = $1
  `, [nextRide.id]);

  const driverSocketId = activeDrivers[String(driverId)]?.socketId;
  if (driverSocketId) {
    io.to(driverSocketId).emit('rideAssigned', {
      rideId: nextRide.external_id,
      passengerId: nextRide.passenger_id,
      pickup: { address: nextRide.pickup_address },
      destination: nextRide.dropoff_address,
      otp: nextRide.otp,
      estimatedFare: nextRide.estimated_fare,
      distanceKm: nextRide.distance_km,
      surgeMultiplier: nextRide.surge_multiplier ?? 1.0,
    });

    console.log(
      `🚀 Queued ride ${nextRide.external_id} auto-assigned to driver ${driverId}`
    );
  }
}

// ===============================
// 🔓 DRIVER STATE RESET (ONLY ONCE)
// ===============================
if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = false;
  activeDrivers[String(driverId)].canReceiveQueuedRide = false;
  activeDrivers[String(driverId)].queuedRideId = [];
}

	const unlockQuery = await client.query(
        `UPDATE scheduled_rides SET is_locked = FALSE, locked_until = NULL WHERE driver_id = $1 AND is_locked = TRUE RETURNING external_id`,
       [Number(driverId)]
    );
    if (unlockQuery.rows.length > 0) {
        console.log(`🔓 Lock released for driver ${driverId} from scheduled ride ${unlockQuery.rows[0].external_id}.`);
        const dSid = activeDrivers[driverId]?.socketId;
		if (dSid) {
            io.to(dSid).emit('driver-unlocked', { message: 'Your scheduled ride is complete. You are now available for new requests.' });
        }
    }

	console.log(`🏁 Completed ${rideId}, fare=${finalTotalR}, waiting=${waitingAmt}, extra=${extraAmt}, cash=${!!paidByCash}`);
if (passengerId) {
    const pSid = activePassengers[passengerId]?.socketId;
    if (pSid) io.to(pSid).emit('rideCompleted', { 
        rideId, driverId, 
        finalFare: finalTotalR,   // ✅ already includes waiting
        waitingCharge: waitingAmt, // ✅ separately for display
		 tollCharge: tollAmt,  
		 extraCharge:   extraAmt,
		  actualDropoffAddress: rideRow.actual_dropoff_address || null, 
        paidByCash: !!paidByCash 
    });
}
const dSid = activeDrivers[driverId]?.socketId;
if (dSid) io.to(dSid).emit('rideCompleted', { 
    rideId, 
    finalFare: finalTotalR,    // ✅ already includes waiting
    waitingCharge: waitingAmt,  // ✅ separately for display
	extraCharge:   extraAmt, 
	 tollCharge: tollAmt, 
	  actualDropoffAddress: rideRow.actual_dropoff_address || null,
    paidByCash: !!paidByCash,
    passengerId: rideRow.passenger_id?.toString()
});
	delete extraDistanceTrackers[rideId];
	delete global.routeDeviationConsent?.[rideId];
	delete sosTimers[rideId];
	delete rideBlockedDrivers[rideId];
	await pool.query(
  `UPDATE rides SET is_sos_active = FALSE WHERE external_id = $1`,
  [rideId]
);


  } catch (e) {
	await client.query('ROLLBACK');
	socketLogger.error(socket.id, 'completeRide transaction error', e);
	console.error('completeRide transaction error. Rolled back.', e);
  } finally {
	client.release();
  }
});

//passenger rating
// ✅✅✅ PASTE THIS ENTIRE NEW, GLORIOUS LISTENER INTO socket.js ✅✅✅

socket.on('submitDriverRating', async ({ rideId, driverId, passengerId, rating, review, tags }) => {
    if (!rideId || !passengerId || !driverId || !rating) {
        console.warn('[submitDriverRating] Received with missing data. Aborting.');
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Step 1: Insert the main rating into your new 'passenger_ratings' table
        await client.query(
            `INSERT INTO passenger_ratings (ride_external_id, driver_id, passenger_id, rating, review)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (ride_external_id) DO NOTHING`, // This prevents errors if submitted twice
            [rideId, driverId, passengerId, rating, review]
        );

        // Step 2: Insert the beautiful checkbox tags into 'ride_rating_tags'
        if (tags && Array.isArray(tags) && tags.length > 0) {
            for (const tag of tags) {
                await client.query(
                    `INSERT INTO ride_rating_tags (ride_external_id, rated_by_role, tag_key, tag_value)
                     VALUES ($1, 'DRIVER', $2, $3)
                     ON CONFLICT (ride_external_id, rated_by_role, tag_value) DO NOTHING`,
                    [rideId, tag.key, tag.value]
                );
            }
        }
		
		await client.query(`
  UPDATE passenger_ratings
  SET
    total_ratings = total_ratings + 1,
    avg_rating = ROUND(
      ((avg_rating * total_ratings) + $1) / (total_ratings + 1),
      1
    )
  WHERE id = $2
`, [rating, passengerId]);


        // As you commanded, we DO NOT update the users table. That step is removed.

        await client.query('COMMIT');
        console.log(`✅ Driver ${driverId} rated passenger ${passengerId} for ride ${rideId}`);

    } catch (e) {
        await client.query('ROLLBACK');
		socketLogger.error(socket.id, 'submitDriverRating error', e);
        console.error('❌ Error in submitDriverRating:', e);
    } finally {
        client.release();
    }
});

	

	socket.on('sendMessage', async (data) => {
  const { rideId, senderId, senderRole, message } = data;
  if (!rideId || !senderId || !senderRole || !message) return;

  // 🔎 find ride
  const q = await pool.query(
    `SELECT driver_id, passenger_id
     FROM rides
     WHERE external_id = $1
     LIMIT 1`,
    [rideId]
  );

  if (!q.rows.length) return;

  const { driver_id, passenger_id } = q.rows[0];

  // 🔥 AUTO recipient resolution
  const recipientId =
    senderRole === 'driver'
      ? passenger_id?.toString()
      : driver_id?.toString();

  if (!recipientId) return;

  let recipientSocketId = null;

  if (activePassengers[recipientId]) {
    recipientSocketId = activePassengers[recipientId].socketId;
  } else if (activeDrivers[recipientId]) {
    recipientSocketId = activeDrivers[recipientId].socketId;
  }

  if (recipientSocketId) {
    io.to(recipientSocketId).emit('receiveMessage', {
      rideId,
      senderId,
      message,
      timestamp: new Date().toISOString(),
    });
  }
});

	

socket.on('accept-scheduled-ride', async (data) => {
    const { rideId, driverId } = data;
    if (!rideId || !driverId) {
        console.error('[accept-scheduled-ride] Missing rideId or driverId.');
        return;
    }

    console.log(`[accept-scheduled-ride] Driver ${driverId} accepted ride ${rideId}`);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Lock the ride and get passenger_id.
        const rideUpdateResult = await client.query(
            `UPDATE scheduled_rides
  SET
    status = 'ACCEPTED',
    driver_id = $1,
    is_locked = TRUE,
    locked_until = NULL
  WHERE external_id = $2
    AND status = 'SEARCHING'
  RETURNING
    passenger_id,
	vehicle_type,
    pickup_address,
    dropoff_address,
    scheduled_pickup_time,
    estimated_fare,
    otp,
    ST_Y(pickup_location::geometry) as pickup_lat,
    ST_X(pickup_location::geometry) as pickup_lon`,
            [driverId, rideId]
        );

        if (rideUpdateResult.rows.length === 0) {
            throw new Error('Ride could not be locked. Already accepted by another driver.');
        }

        const rideDetails = rideUpdateResult.rows[0];
	// Fetch driver's vehicle_type from DB (source of truth)
const driverVehicleRes = await client.query(
  `SELECT vehicle_type FROM drivers WHERE user_id = $1`,
  [driverId]
);

const driverVehicleType =
  driverVehicleRes.rows[0]?.vehicle_type?.toUpperCase();

const rideVehicleType =
  rideDetails.vehicle_type?.toUpperCase();

if (!driverVehicleType || !rideVehicleType) {
  throw new Error('Vehicle type validation failed');
}

if (driverVehicleType !== rideVehicleType) {
  throw new Error(
    `Vehicle type mismatch: ride=${rideVehicleType}, driver=${driverVehicleType}`
  );
}

		
        const passengerId = rideDetails.passenger_id;
		

        // 2. ✅ FETCH THE DRIVER'S FULL DETAILS
        const driverDetailsQuery = await client.query(
            `SELECT
                u.name AS driver_name, -- You said your column is 'name', not 'full_name'
                u.phone_number AS driver_contact,
                d.vehicle_model,
                d.vehicle_number,
                d.rating,
				dv.driver_photo_url,
					dv.vehicle_photo_url
             FROM users u
             JOIN drivers d ON u.id = d.user_id
			 LEFT JOIN driver_verifications dv ON dv.user_id = u.id
             WHERE u.id = $1`,
            [driverId]
        );
        const driverDetails = driverDetailsQuery.rows[0] || {};
		
        let passengerName = 'Passenger'; // A safe default name
        if (passengerId) {
            try {
                // Command the database to find the passenger's name
                const passengerQuery = await client.query(
                    `SELECT name FROM users WHERE id = $1`,
                    [passengerId]
                );
                
                // If a name is found, we use it!
                if (passengerQuery.rows.length > 0) {
                    passengerName = passengerQuery.rows[0].name;
                }
            } catch (e) {
                console.error("Failed to fetch passenger name for scheduled ride:", e);
                // If it fails, the name will remain 'Passenger', which is a safe fallback.
            }
        }
		
		
        const driverLocation = activeDrivers[driverId] ? { latitude: activeDrivers[driverId].latitude, longitude: activeDrivers[driverId].longitude } : null;
		console.log('🧠 activePassengers snapshot:', activePassengers);
		console.log('🧠 passengerId:', passengerId);
		
		//upcoming ride panel schedule ride.
		
		socket.emit('driver-locked', {
            'message': 'You have an upcoming scheduled ride.',
            'lockedUntil': rideDetails.locked_until,
            'rideDetails': {
                 rideId: rideId,
                 passengerId: passengerId,
				 passengerName: passengerName,
                 otp: rideDetails.otp,
                 pickupAddress: rideDetails.pickup_address,
                 dropoffAddress: rideDetails.dropoff_address,
                 scheduledPickupTime: rideDetails.scheduled_pickup_time,
                 estimatedFare: rideDetails.estimated_fare,
                 pickupLatitude: rideDetails.pickup_lat,
                 pickupLongitude: rideDetails.pickup_lon
            }
        });
        console.log(`✅ [INSTANT]  Acknowledged Driver ${driverId} and sent passenger pickup details.`);
		

        // 3. ✅✅✅ NOTIFY PASSENGER WITH ALL DETAILS (THE CRITICAL FIX) ✅✅✅
       const pState = activePassengers[passengerId];

// 🟢 Passenger app OPEN → SOCKET ONLY
if (pState?.socketId && pState.isForeground === true) {
  io.to(pState.socketId).emit('ride-status-update', {
    rideId: rideId,
    status: 'ACCEPTED',

    // 🔥 full driver data (same as pehle)
    driver_id: driverId,
    driver_name: driverDetails.driver_name,
    driver_contact: driverDetails.driver_contact,
    vehicle_model: driverDetails.vehicle_model,
    vehicle_number: driverDetails.vehicle_number,
    rating: driverDetails.rating,
    driver_location: driverLocation,
    driver_photo_url: toPublicUrl(driverDetails.driver_photo_url),
    vehicle_photo_url: toPublicUrl(driverDetails.vehicle_photo_url),
  });

  console.log(`🟢 Passenger ${passengerId} notified via SOCKET (foreground).`);
}
// 🔔 Passenger app BACKGROUND / KILLED → PUSH ONLY
else {
  await sendNotificationToUser(
    passengerId,
    'Your Scheduled Ride is Confirmed!',
    'A driver has been assigned.',
    {
      type: 'SCHEDULED_ACCEPTED',
      rideId,
      sentAt: new Date().toISOString(),
    },
	  { showNotification: true } 
  );

  console.log(`🔔 Passenger ${passengerId} notified via PUSH (background).`);
}


    console.log(`✅ Sent PUSH NOTIFICATION to passenger ${passengerId} for scheduled ride confirmation.`);


        // 4. Acknowledge the DRIVER (This part is already correct in your code)
        
// 🔥🔥🔥 DISMISS POPUP FOR OTHER DRIVERS (SCHEDULED RIDE) 🔥🔥🔥
const notifiedSet = global.rideNotifiedDrivers?.[rideId] || new Set();

for (const otherDriverId of notifiedSet) {
  if (String(otherDriverId) === String(driverId)) continue;

  const d = activeDrivers[String(otherDriverId)];
  if (d?.socketId) {
    io.to(d.socketId).emit('dismissRideRequest', {
      rideId,
      reason: 'accepted_by_other'
    });
  }
}

// 🧹 cleanup memory
delete global.rideNotifiedDrivers?.[rideId];

        await client.query('COMMIT');
		

    } catch (e) {
        await client.query('ROLLBACK');
		socketLogger.error(socket.id, `[accept-scheduled-ride] Transaction failed for ride ${rideId}:`, e);
        console.error(`[accept-scheduled-ride] Transaction failed for ride ${rideId}:`, e);
        socket.emit('action-failed', { message: e.message || "Could not accept ride." });
    } finally {
        client.release();
    }
});



socket.on('start-driving-to-scheduled-pickup', async (data) => {
    const { rideId, driverId } = data;
    if (!rideId || !driverId) {
        console.error('[start-driving] Missing rideId or driverId.');
        return;
    }

    console.log(`Driver ${driverId} is now driving to pickup for scheduled ride ${rideId}.`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Step 1: Fetch driver details and passenger_id at the same time.
        // We join the tables to get everything in one query.
        const query = `
            SELECT
                sr.passenger_id,
                u.name AS driver_name,
                d.vehicle_model,
                d.vehicle_number
            FROM scheduled_rides sr
            JOIN drivers d ON d.user_id = sr.driver_id
            JOIN users u ON u.id = sr.driver_id
            WHERE sr.external_id = $1 AND sr.driver_id = $2
        `;
        const detailsResult = await client.query(query, [rideId, driverId]);

        if (detailsResult.rows.length === 0) {
            throw new Error('Ride not found or not assigned to this driver.');
        }
        const rideInfo = detailsResult.rows[0];
        const passengerId = rideInfo.passenger_id;

        // Step 2: Update the ride status to 'EN_ROUTE_TO_PICKUP'
        await client.query(
            `UPDATE scheduled_rides SET status = 'EN_ROUTE_TO_PICKUP' WHERE external_id = $1`,
            [rideId]
        );

        // Step 3: Notify the passenger with ALL the required details.
        if (passengerId) {
            const pSock = activePassengers[passengerId]?.socketId; // Assuming you have this map
            if (pSock) {
                // ✅ THIS IS THE FIX ✅
                // We now include all the details the Flutter app is waiting for.
                io.to(pSock).emit('ride-status-update', {
                    rideId: rideId,
                    status: 'EN_ROUTE_TO_PICKUP',
                    driver_name: rideInfo.driver_name,
                    vehicle_model: rideInfo.vehicle_model,
                    vehicle_number: rideInfo.vehicle_number,
                    message: 'Your driver is on the way!'
                });
                console.log(`Notified passenger ${passengerId} that driver is en route.`);
            }
        }

        await client.query('COMMIT');

    } catch (e) {
        await client.query('ROLLBACK');
		socketLogger.error(socket.id, `[start-driving] Transaction failed for ride ${rideId}:`, e);
        console.error(`[start-driving] Transaction failed for ride ${rideId}:`, e);
    } finally {
        client.release();
    }
});

socket.on('driver-arrived-for-scheduled-ride', async (data) => {
  const { rideId, passengerId } = data;
  if (!rideId || !passengerId) {
    console.error('[driver-arrived-scheduled] Missing rideId or passengerId.');
    return;
  }

  console.log(`Driver has arrived for scheduled ride ${rideId}. Notifying passenger ${passengerId}.`);
  const client = await pool.connect();

  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const updateResult = await client.query(
      `UPDATE scheduled_rides
       SET status = 'ARRIVED', otp = $1
       WHERE external_id = $2
       RETURNING external_id, driver_id`, // Get the driver_id
      [otp, rideId]
    );

    if (updateResult.rows.length === 0) {
      throw new Error(`Could not find scheduled ride ${rideId} to mark as ARRIVED.`);
    }

    const driverId = updateResult.rows[0].driver_id; // Get the driver's ID from the query result

    // --- NOTIFY PASSENGER (This part is correct) ---
    const pSock = activePassengers[passengerId]?.socketId;
    if (pSock) {
      io.to(pSock).emit('ride-arrived-otp', {
        rideId: rideId,
        status: 'ARRIVED',
        otp: otp,
        message: 'Your driver has arrived!'
      });
      console.log(`✅ OTP ${otp} sent to passenger ${passengerId} for ride ${rideId}.`);
    } else {
      console.warn(`Could not find active socket for passenger ${passengerId} to send OTP.`);
    }

    // ✅✅✅ THIS IS THE MISSING PIECE OF LOGIC ON THE BACKEND ✅✅✅
    // --- NOTIFY DRIVER (ACK) with the new OTP ---
socket.emit('scheduledRideArrivedAck', {
  rideId,
  otp,
  message: 'Passenger notified. Waiting for OTP verification.'
});

    // ✅ FIX: Start waiting charge timer for scheduled rides too
    // passengerId comes from the event data, driverId from the DB query result
    const driverIdForTimer = updateResult.rows[0].driver_id?.toString();
    const passengerIdStr = passengerId?.toString();
    console.log(`⏳ Starting waiting timer for scheduled ride ${rideId} — passenger: ${passengerIdStr}, driver: ${driverIdForTimer}`);
    
    // ✅ FIX: Emit waitingWarning immediately so passenger sees the countdown popup.
    // For normal rides, waitingWarning comes from driverLocationUpdate 100m check.
    // For scheduled rides, that check never runs — so we emit it manually here.
    const pSockImmediate = activePassengers[passengerIdStr]?.socketId;
    const immediateWarning = { rideId, remainingSeconds: 30 };
    if (pSockImmediate) io.to(pSockImmediate).emit('waitingWarning', immediateWarning);
    io.to(`passenger:${passengerIdStr}`).emit('waitingWarning', immediateWarning); // room fallback
    io.to(`driver:${driverIdForTimer}`).emit('waitingWarning', immediateWarning);
    console.log(`⚠️ waitingWarning emitted for scheduled ride ${rideId}`);
    
    startWaitingChargeTimer(rideId, passengerIdStr, driverIdForTimer);


  } catch (e) {
	  socketLogger.error(socket.id, `[driver-arrived-scheduled] Error for ride ${rideId}:`, e);
    console.error(`[driver-arrived-scheduled] Error for ride ${rideId}:`, e);
  } finally {
    client.release();
  }
});

// for FCM added 12:13 am 17012026

socket.on('driver-request-ride-resend', async ({ driverId, rideId }) => {
  try {
    const q = await pool.query(
      `
      SELECT
        *,
        ST_Y(pickup_location::geometry) AS pickup_lat,
        ST_X(pickup_location::geometry) AS pickup_lng,
        ST_Y(dropoff_location::geometry) AS drop_lat,
        ST_X(dropoff_location::geometry) AS drop_lng
      FROM rides
      WHERE external_id = $1
        AND status = 'PENDING'
      `,
      [rideId]
    );

    if (q.rows.length === 0) return;

    const r = q.rows[0];

    socket.emit('newRideRequest', {
      rideId: r.external_id,
      passengerId: r.passenger_id,
      pickupAddress: r.pickup_address,
      dropoffAddress: r.dropoff_address,

      pickupLatitude: r.pickup_lat,
      pickupLongitude: r.pickup_lng,
      dropoffLatitude: r.drop_lat,
      dropoffLongitude: r.drop_lng,

      estimatedFare: r.estimated_fare,
      distanceKm: r.distance_km,
      vehicleType: r.vehicle_type,
      surgeMultiplier: r.surge_multiplier ?? 1.0,

      fromResync: true,
    });

    console.log(`🔁 Resent ride ${rideId} to driver ${driverId}`);
  } catch (e) {
	  socketLogger.error(socket.id, 'driver-request-ride-resend error:', e);
    console.error('driver-request-ride-resend error:', e);
  }
});


async function logRouteSnapshot(pool, data) {
  const {
    rideExternalId,
    latitude,
    longitude,
    speedKmph
  } = data;

  if (!rideExternalId) return;

  await pool.query(
    `
    INSERT INTO ride_route_snapshots (
      ride_external_id,
      latitude,
      longitude,
      speed_kmph
    ) VALUES ($1, $2, $3, $4)
    `,
    [rideExternalId, latitude, longitude, speedKmph]
  );
}


async function getActiveRideIdForDriver(pool, driverId) {
  const { rows } = await pool.query(
    `
    SELECT external_id
    FROM rides
    WHERE driver_id = $1
      AND status='IN_TRANSIT'
	  ORDER BY started_at DESC NULLS LAST
    LIMIT 1
    `,
    [driverId]
  );

  return rows[0]?.external_id || null;
}

function shouldLogRouteSnapshot(rideExternalId) {
  const key = String(rideExternalId);
  const now = Date.now();

  if (!lastRouteSnapshotAt[key] || now - lastRouteSnapshotAt[key] > 15000) {
    lastRouteSnapshotAt[key] = now;
    return true;
  }
  return false;
}

//back to back ride Socket
socket.on('driverConfirmQueuedRide', async ({ rideId, driverId }) => {
  console.log(`🟢 Driver ${driverId} confirmed queued ride ${rideId}`);

  // mark queued ride as confirmed
  await pool.query(
    `
    UPDATE rides
    SET status = 'QUEUED_CONFIRMED',
        driver_id = $1
    WHERE external_id = $2
    `,
    [driverId, rideId]
  );
});


 
// 🛡️ ROUTE DEVIATION (SOFT) — OPTION A
socket.on('route_deviation_soft', async (payload = {}) => {
  try {
    // ✅ PRODUCTION ENABLED — manual dev-test button is guarded in Flutter by ENABLE_DEV_ROUTE_DEVIATION=false
    // ⛔ Guard: payload empty
    if (!payload?.rideExternalId || !payload?.driverId) return;
	
	   await rideLogger.deviated(pool, {
      rideId:      payload.rideExternalId,
      driverId:    payload.driverId,
      passengerId: payload.passengerId || null,
      distanceM:   payload.distanceMeters || null,
      durationSec: payload.durationSeconds || null,
    });


    // 👉 Delegate ALL logic (no brain here)
    await SafetyService.handleRouteDeviationSoft(socket, payload);

  } catch (err) {
	  socketLogger.error(socket.id, 'route_deviation_soft error', err);
    console.error('❌ route_deviation_soft error:', err.message);
  }
});

socket.on('register', ({ userId, role }) => {
  if (role === 'passenger') {
    socket.join(`passenger:${userId}`);
    console.log(`✅ Passenger ${userId} joined room passenger:${userId}`);
  }
});


socket.on('driver_route_explanation', async (payload = {}) => {
	console.log('📨 driver_route_explanation received:', payload);
  try {
    const { rideExternalId, driverId, message } = payload;
    if (!rideExternalId || !driverId || !message) return;

    const q = await socket.dbPool.query(
      `SELECT passenger_id
       FROM rides
       WHERE external_id = $1
         AND driver_id = $2
         AND status = 'IN_TRANSIT'
       LIMIT 1`,
      [rideExternalId, driverId]
    );

    if (!q.rows.length) return;

    const passengerId = q.rows[0].passenger_id?.toString();

    // 👉 Send confirmation popup to passenger
    socket.to(`passenger:${passengerId}`).emit('route_change_confirmation', {
      rideExternalId,
      driverMessage: message
    });

  } catch (e) {
	  socketLogger.error(socket.id, 'driver_route_explanation error', e);
    console.error('driver_route_explanation error:', e.message);
  }
});


socket.on('route_change_decision', async (payload = {}) => {
  try {
    const { rideExternalId, passengerId, decision } = payload;
    if (!rideExternalId || !passengerId || !decision) return;

    // 1️⃣ Persist passenger decision (SOURCE OF TRUTH)
    await pool.query(
      `
      INSERT INTO ride_safety_state (ride_external_id, passenger_decision, decision_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (ride_external_id)
      DO UPDATE SET
        passenger_decision = EXCLUDED.passenger_decision,
        decision_at = NOW()
      `,
      [rideExternalId, decision]
    );

    // 2️⃣ In-memory cache (speed only)
    socket.routeDeviationConsent[rideExternalId] = decision;

    // 3️⃣ Fetch driver
    const q = await pool.query(
      `
      SELECT driver_id
      FROM rides
      WHERE external_id = $1
        AND passenger_id = $2
        AND status = 'IN_TRANSIT'
      LIMIT 1
      `,
      [rideExternalId, passengerId]
    );

    if (!q.rows.length) return;
    const driverId = q.rows[0].driver_id?.toString();

    // 4️⃣ Notify driver
    socket.to(`driver:${driverId}`).emit(
      'route_change_decision_result',
      {
        rideExternalId,
        decision,
        message:
          decision === 'AGREE'
            ? 'Passenger agreed to route change.'
            : 'Passenger did not agree. Please follow suggested route.',
      }
    );

  } catch (e) {
	  socketLogger.error(socket.id, 'route_change_decision error', e);
    console.error('route_change_decision error:', e.message);
  }
});

socket.on('terminate_ride', async (payload = {}) => {
  try {
    const { rideExternalId, choice } = payload;
    if (!rideExternalId || !choice) return;

    if (choice === 'CONTINUE_RIDE') {
      socket.routeDeviationConsent[rideExternalId] = 'AGREE';
      return;
    }

    if (choice !== 'END_RIDE_NOW') return;

    const { rows } = await pool.query(
      `UPDATE rides
       SET status = 'PARTIAL_COMPLETE',
           completed_at = NOW(),
           cancelled_by = 'SAFETY_ROUTE_DEVIATION'
       WHERE external_id = $1
         AND status = 'IN_TRANSIT'
       RETURNING passenger_id, driver_id`,
      [rideExternalId]
    );

    if (!rows.length) return;

    const passengerId = rows[0].passenger_id?.toString();
    const driverId = rows[0].driver_id?.toString();

    if (passengerId && activePassengers[passengerId]?.socketId) {
      io.to(activePassengers[passengerId].socketId).emit('ride_terminated', {
        rideId: rideExternalId,
        reason: 'route_deviation',
      });
    }

    if (driverId && activeDrivers[driverId]?.socketId) {
      io.to(activeDrivers[driverId].socketId).emit('ride_terminated', {
        rideId: rideExternalId,
        reason: 'route_deviation',
      });

      activeDrivers[driverId].isOnActiveRide = false;
      activeDrivers[driverId].canReceiveQueuedRide = false;
      activeDrivers[driverId].queuedRideId = [];
    }

    delete global.routeDeviationConsent?.[rideExternalId];
    delete sosTimers[rideExternalId];
    delete lastRouteSnapshotAt[String(rideExternalId)];
    delete extraDistanceTrackers[rideExternalId];
  } catch (e) {
	  socketLogger.error(socket.id, 'terminate_ride error', e);
    console.error('terminate_ride error:', e.message);
  }
});

socket.on('sos_triggered', async (payload = {}) => {
  try {
    const {
      rideExternalId,
      triggeredBy, // PASSENGER | DRIVER
      userId,
      lat,
      lng,
      reason
    } = payload;

    if (!rideExternalId || !triggeredBy || !userId) return;

    // 1️⃣ Fetch ride
    const q = await pool.query(
      `SELECT passenger_id, driver_id, status
       FROM rides
       WHERE external_id = $1
       LIMIT 1`,
      [rideExternalId]
    );

    if (!q.rows.length) return;

    const ride = q.rows[0];

    // 2️⃣ Insert SOS event
    await pool.query(
      `INSERT INTO ride_safety_events (
        ride_external_id,
        driver_id,
        passenger_id,
        event_type,
        latitude,
        longitude,
        triggered_by
      )
      VALUES ($1,$2,$3,'SOS_TRIGGERED',$4,$5,$6)`,
      [
        rideExternalId,
        ride.driver_id,
        ride.passenger_id,
        lat ?? null,
        lng ?? null,
        triggeredBy
      ]
    );
	
	await pool.query(
  `
  INSERT INTO ride_sos_state (ride_external_id, status, triggered_at)
  VALUES ($1, 'TRIGGERED', NOW())
  ON CONFLICT (ride_external_id)
  DO NOTHING
  `,
  [rideExternalId]
);

	// ===============================
// 🧨 AUTO ESCALATION TIMER (30s)
// ===============================
if (sosTimers[rideExternalId]) {
  clearTimeout(sosTimers[rideExternalId]);
    delete sosTimers[rideExternalId];

}

sosTimers[rideExternalId] = setTimeout(async () => {
  try {
    const check = await pool.query(
      `SELECT status FROM ride_sos_state WHERE ride_external_id = $1`,
      [rideExternalId]
    );

    if (check.rows[0]?.status === 'RESOLVED') return;

    await pool.query(
      `
      INSERT INTO ride_sos_state (ride_external_id, status, escalated_at)
      VALUES ($1, 'ESCALATED', NOW())
      ON CONFLICT (ride_external_id)
      DO UPDATE SET
        status = 'ESCALATED',
        escalated_at = NOW()
      `,
      [rideExternalId]
    );

    io.to('admin_room').emit('sos_escalated', {
      rideExternalId,
      message: '🚨 SOS AUTO-ESCALATED (NO RESPONSE)',
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('SOS escalation failed:', e.message);
  } finally {
    delete sosTimers[rideExternalId]; // ✅ ADD THIS
  }
}, 30_000);


	

    // 3️⃣ Mark ride as under safety monitoring
   await pool.query(
  `UPDATE rides SET is_sos_active = TRUE WHERE external_id = $1`,
  [rideExternalId]
);


    // 4️⃣ Notify admin
    io.to('admin_room').emit('sos_alert', {
      rideExternalId,
      triggeredBy,
      userId,
      reason: reason || 'SOS triggered',
      timestamp: new Date().toISOString()
    });

    // 5️⃣ Notify both parties
    io.to(`driver:${ride.driver_id}`).emit('sos_ack', {
      message: 'SOS received. Support team is monitoring this ride.'
    });

    io.to(`passenger:${ride.passenger_id}`).emit('sos_ack', {
      message: 'SOS received. Support team is monitoring this ride.'
    });

    console.log(`🚨 SOS triggered for ${rideExternalId}`);

  } catch (e) {
	  socketLogger.error(socket.id, 'sos_triggered error', e);
    console.error('sos_triggered error:', e.message);
  }
});


socket.on('sos_resolved', async ({ rideExternalId, adminId }) => {
  try {
    if (!rideExternalId) return;

    await pool.query(
      `
      UPDATE ride_sos_state
      SET status = 'RESOLVED', resolved_at = NOW()
      WHERE ride_external_id = $1
      `,
      [rideExternalId]
    );

    await pool.query(
      `UPDATE rides SET is_sos_active = FALSE WHERE external_id = $1`,
      [rideExternalId]
    );

    if (sosTimers[rideExternalId]) {
      clearTimeout(sosTimers[rideExternalId]);
      delete sosTimers[rideExternalId];
    }

    io.to('admin_room').emit('sos_resolved_ack', {
      rideExternalId,
      adminId,
      timestamp: new Date().toISOString()
    });

    console.log(`✅ SOS resolved for ${rideExternalId}`);

  } catch (e) {
	  socketLogger.error(socket.id, 'sos_resolved error ', e);
    console.error('sos_resolved error:', e.message);
  }
});



//close here safety related changes

//   EXTRA DISTANCE — Step 1: Driver requests passenger approval
// ─────────────────────────────────────────────────────────────
socket.on('driver_extra_distance_request', async (payload) => {
  const {
    rideId,
    driverId,
    newDropLat,
    newDropLng,
    newDropAddress
  } = payload;
  try {
    if (!rideId || !driverId) return;

    // ✅ Support both normal and scheduled rides
    const isScheduled = String(rideId).startsWith('sched_');
    const rideTable = isScheduled ? 'scheduled_rides' : 'rides';

    const rideRes = await pool.query(
      `SELECT passenger_id,
              ST_Y(dropoff_location::geometry) AS drop_lat,
              ST_X(dropoff_location::geometry) AS drop_lon
       FROM ${rideTable}
       WHERE external_id = $1 AND driver_id = $2 AND status = 'IN_TRANSIT'
       LIMIT 1`,
      [rideId, driverId]
    );

    if (!rideRes.rows.length) {
      console.warn(`extra_distance_request: ride ${rideId} not found or not IN_TRANSIT`);
      return;
    }

    const { passenger_id, drop_lat, drop_lon } = rideRes.rows[0];
    const pId = passenger_id?.toString();

    // ── STEP 1: Driver's current GPS (sent directly from Flutter) ──────────────
    // Primary: payload.newDropLat/Lng (Flutter sends current location on button press)
    // Fallback 1: activeDrivers in-memory map
    // Fallback 2: DB current_location
    let driverLat = (payload.newDropLat != null && !isNaN(Number(payload.newDropLat)))
      ? Number(payload.newDropLat) : null;
    let driverLon = (payload.newDropLng != null && !isNaN(Number(payload.newDropLng)))
      ? Number(payload.newDropLng) : null;

    if (driverLat == null || driverLon == null) {
      // Fallback 1: in-memory
      const mem = activeDrivers[driverId.toString()];
      if (mem?.latitude != null && mem?.longitude != null) {
        driverLat = mem.latitude;
        driverLon = mem.longitude;
        console.log(`📍 Using in-memory location for driver ${driverId}`);
      }
    }

    if (driverLat == null || driverLon == null) {
      // Fallback 2: DB
      try {
        const loc = await pool.query(
          `SELECT ST_Y(current_location::geometry) as lat,
                  ST_X(current_location::geometry) as lon
           FROM drivers WHERE user_id = $1 LIMIT 1`,
          [driverId]
        );
        if (loc.rows.length) {
          driverLat = Number(loc.rows[0].lat);
          driverLon = Number(loc.rows[0].lon);
          console.log(`📍 Using DB fallback location for driver ${driverId}`);
        }
      } catch(e) { console.warn('DB location fetch failed:', e.message); }
    }

    if (driverLat == null || driverLon == null) {
      console.warn(`❌ No driver location found for ${driverId} — allowing request`);
      // Don't block if we can't determine location
    } else {
      // ── STEP 2: Distance check ──────────────────────────────────────────────
      const distToDropoffM = haversineDistanceKm(
        driverLat, driverLon,
        Number(drop_lat), Number(drop_lon)
      ) * 1000;

      console.log(
        `📏 Driver(${driverId}) at (${driverLat.toFixed(5)}, ${driverLon.toFixed(5)}) ` +
        `→ Drop(${Number(drop_lat).toFixed(5)}, ${Number(drop_lon).toFixed(5)}) = ${Math.round(distToDropoffM)}m`
      );

      // 300m tolerance for India GPS accuracy in urban areas
      const ARRIVAL_TOLERANCE_M = 300;

      if (distToDropoffM > ARRIVAL_TOLERANCE_M) {
        console.warn(`🚫 Extra distance blocked: ${Math.round(distToDropoffM)}m from original drop`);
        socket.emit('extra_distance_too_early', {
          rideId,
          distanceToDropoffM: Math.round(distToDropoffM),
          message: `You are still ${Math.round(distToDropoffM)} m away from the passenger's original drop-off. Please reach there first.`,
        });
        return;
      }
    }

    // ✅ PASS → proceed
   extraDistanceTrackers[rideId] = {
  originalDropLat: Number(drop_lat),
  originalDropLon: Number(drop_lon),

  newDropLat: payload.newDropLat,
  newDropLng: payload.newDropLng,
  newDropAddress: payload.newDropAddress, // ✅ now exists

  passengerId: pId,
  approved: false,
};

    const pSockId = activePassengers[pId]?.socketId;

    if (pSockId) {
      io.to(pSockId).emit('extra_distance_approval_request', {
  rideId,
  newDropAddress,
  message: 'Driver wants to change destination. Extra charges apply.',
});
    }

    socket.emit('extra_distance_request_sent', { rideId });

    console.log(`🛣️ Extra distance request sent for ${rideId}`);

  } catch (e) {
	  socketLogger.error(socket.id, 'driver_extra_distance_request error ', e);
    console.error('driver_extra_distance_request error:', e.message);
  }
});

// 🛣️  EXTRA DISTANCE — Step 2: Passenger approves or rejects
// ─────────────────────────────────────────────────────────────
socket.on('passenger_extra_distance_response', async ({ rideId, passengerId, approved }) => {
  try {
    if (!rideId) return;

    // ✅ Support both normal and scheduled rides
    const isScheduled = String(rideId).startsWith('sched_');
    const rideTable = isScheduled ? 'scheduled_rides' : 'rides';

    const rideRes = await pool.query(
      `SELECT driver_id FROM ${rideTable} WHERE external_id = $1 LIMIT 1`,
      [rideId]
    );
    if (!rideRes.rows.length) return;
 
    const driverId = rideRes.rows[0].driver_id?.toString();
    const dSockId  = activeDrivers[driverId]?.socketId;
 
    if (approved) {
      // Mark approved — the driverLocationUpdate loop will now track distance
      if (extraDistanceTrackers[rideId]) {
        extraDistanceTrackers[rideId].approved = true;
      }
      if (dSockId) io.to(dSockId).emit('extra_distance_approved', { rideId });
      console.log(`✅ Extra distance APPROVED for ${rideId}`);
    } else {
      // Passenger rejected — clean up, tell driver to end ride
      delete extraDistanceTrackers[rideId];
      // Reset extra_amount in both tables
      await pool.query(
        `UPDATE ${rideTable} SET extra_amount = 0 WHERE external_id = $1`,
        [rideId]
      );
      if (dSockId) io.to(dSockId).emit('extra_distance_rejected', {
        rideId,
        message: 'Passenger declined the extra distance. Please end the ride now.',
      });
      console.log(`❌ Extra distance REJECTED for ${rideId}`);
    }
  } catch (e) {
	  socketLogger.error(socket.id, 'passenger_extra_distance_response error ', e);
    console.error('passenger_extra_distance_response error:', e.message);
  }
});

		/* ---------- disconnect ---------- */
	socket.on('disconnect', async () => {
  console.log('🔌 Socket disconnected:', socket.id);

  for (const [driverId, d] of Object.entries(activeDrivers)) {
    if (d.socketId === socket.id) {
      // 🔹 Soft-disconnect (do NOT delete yet)
      d.socketId = null;
      d.lastSeen = Date.now();
	 d.isForeground = false;


       socketLogger.disconnected(socket.id, driverId, 'driver');
      break;
    }
  }

for (const [pid, p] of Object.entries(activePassengers)) {
  if (p?.socketId === socket.id) {
	  socketLogger.disconnected(socket.id, pid, 'passenger');
    delete activePassengers[pid];
    break;
  }
}

});
 });

	  // helpers for other modules
	  initSocketServer.getIo = function () {
		if (!io) throw new Error('Socket not initialised. Call initSocketServer(server, pool) first.');
		return io;
	  };
	  initSocketServer.getActiveDrivers = function () { return activeDrivers; };
	  // 🧹 HARD CLEANUP: remove drivers that stopped sending heartbeats
setInterval(async () => {
  const now = Date.now();

  for (const [driverId, d] of Object.entries(activeDrivers)) {
    if (!d?.lastSeen || now - d.lastSeen > 120_000) {
      console.log(`🧹 Pruning stale driver ${driverId}`);

      delete activeDrivers[driverId];

      try {
        await pool.query(
          `UPDATE drivers SET is_online = FALSE WHERE user_id = $1`,
          [driverId]
        );
      } catch (e) {
        console.warn(`stale cleanup DB fail for ${driverId}:`, e.message);
      }
    }
  }
}, 30_000);

	//setInterval(() => broadcastAvailableDrivers(io, pool), 10000);
setInterval(async () => {
  const drivers = Object.entries(activeDrivers)
    .filter(([_, d]) => d && Date.now() - d.lastSeen < 60_000)
    .map(([userId, d]) => ({
      user_id: Number(userId),
      vehicle_type: d.vehicleType,
      latitude: d.latitude,
      longitude: d.longitude,
    }));

  for (const [pid, pState] of Object.entries(activePassengers)) {
    if (!pState?.socketId) continue;

    const q = await pool.query(
      `SELECT 1 FROM rides
       WHERE passenger_id = $1
         AND status IN ('ACCEPTED','IN_TRANSIT')
       LIMIT 1`,
      [pid]
    );

    // ✅ send nearby drivers ONLY if no active ride
    if (q.rowCount === 0) {
      io.to(pState.socketId).emit('update-nearby-drivers', drivers);
    }
  }
}, 5000);


	  return io;
	}

	module.exports = initSocketServer;
	module.exports.getActiveDrivers   = () => activeDrivers;
module.exports.getActivePassengers = () => activePassengers;