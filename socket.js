	// socket.js
	const { Server } = require('socket.io');
	const {
	  isGstApplicable,
	  roundedRupeesFromPaise,
	} = require('./utils/tax');
	const { sendNotificationToUser } = require('./services/notification_sender');
	const SafetyService = require('./services/safety.service');
	const { getPassengerBadge } = require('./utils/ratingUtils');


	const activeDrivers = {};     // { [driverId]: { socketId, latitude, longitude, vehicleType, lastSeen } }
	const activePassengers = {};  // { [passengerId]: { socketId, isForeground } }
	const rideNotifiedDrivers = {};
	const lastRouteSnapshotAt = {};
	global.routeDeviationConsent = {}; 
	const sosTimers = {};

	let io = null;

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


	// fare helpers (same as invoices route)
	function computeBaseFareINR(vehicleType, distanceKm) {
	  const vt = String(vehicleType || '').toUpperCase();
	  const base =
		vt === 'BIKE'  ? 20 :
		vt === 'MINI'  ? 40 :
		vt === 'SEDAN' ? 70 :
		vt === 'SUV'   ? 100 : 40;

	  const perKm =
		vt === 'BIKE'  ? 6  :
		vt === 'MINI'  ? 10 :
		vt === 'SEDAN' ? 15 :
		vt === 'SUV'   ? 20 : 10;

	  const km = Math.max(0, Number(distanceKm) || 0);
	  return Math.round((base + perKm * km) * 100) / 100;
	}
	// function roundedRupeesFromPaise(paise) {
	  // if (typeof paise !== 'number' || !Number.isFinite(paise)) return 0;
	  // return Math.round(paise / 100);
	// }



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

	  //
	  // Helper: find candidate drivers around the passenger, within radius,
	  // excluding driver IDs in excludeSet. Uses activeDrivers in-memory and supplements
	  // prioritization using acceptance rate (accepted/(accepted+rejected+1)).
	  async function findCandidateDrivers(passengerLat, passengerLng, vehicleType, excludeSet = new Set(), radiusKm = 3.0) {
		const simpleCandidates = [];
		for (const [driverId, d] of Object.entries(activeDrivers)) {
		  if (!d) continue;
		  if (!d.vehicleType || d.vehicleType !== vehicleType) continue;
		  if (d.latitude == null || d.longitude == null) continue;
		  if (!d.lastSeen || (Date.now() - d.lastSeen) > 60 * 1000) continue; // stale
		  if (excludeSet.has(String(driverId))) continue;

		  const dist = haversineDistanceKm(passengerLat, passengerLng, d.latitude, d.longitude);
		  if (dist <= radiusKm) {
			simpleCandidates.push({ driverId: String(driverId), socketId: d.socketId, distance: dist });
		  }
		}

		if (!simpleCandidates.length) return [];

		// fetch stats for these drivers
		const driverIds = simpleCandidates.map(c => c.driverId);
		const stats = await fetchDriverStats(driverIds);

		// compute acceptance metric and sort by (acceptanceRate desc, distance asc)
		const enhanced = simpleCandidates.map(c => {
		  const s = stats[c.driverId] || { accepted_count: 0, rejected_count: 0 };
		  const accepted = Number(s.accepted_count || 0);
		  const rejected = Number(s.rejected_count || 0);
		  // +1 in denominator to avoid divide-by-zero; this biases new drivers slightly
		  const acceptRate = accepted / (accepted + rejected + 1);
		  return { ...c, accepted, rejected, acceptRate };
		});

		enhanced.sort((a,b) => {
		  if (b.acceptRate !== a.acceptRate) return b.acceptRate - a.acceptRate; // higher acceptance first
		  return a.distance - b.distance; // closer first
		});

		return enhanced;
	  }

	  //
	  // Rematch rounds: tries sequential rounds (non-blocking to caller)
	  // rounds = [{ radiusKm, waitMs }, ...]
	  //
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
  if (!cur || !cur.socketId) return;

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

			  // activeDrivers[userId] = {
				// socketId: socket.id,
				// latitude:  (typeof prev.latitude  === 'number') ? prev.latitude  : null,
				// longitude: (typeof prev.longitude === 'number') ? prev.longitude : null,
				// vehicleType,
				// lastSeen: Date.now(),
			  // };
			  
activeDrivers[userId] = {
  ...(activeDrivers[userId] || {}), // 🧠 preserve existing state
  socketId: socket.id,              // 🔌 update socket
  vehicleType,                      // 🚗 ensure vehicle type is set
  lastSeen: Date.now(),             // ⏱️ heartbeat
  isForeground: true,               // 📱 app visible
};
socket.join(`driver:${userId}`);
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
			  socket.join('passengers');
			  socket.join(`passenger:${userId}`);  
			  console.log(`✅ Passenger ${userId} registered`);
			}
		  } catch (e) { console.warn('join error:', e); }
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

    // ❗ MUST already exist (created during `join`)
    if (!activeDrivers[driverId]) {
      console.warn(`driver-go-online ignored: driver ${driverId} not in activeDrivers`);
      return;
    }

    // 🔐 Fetch vehicle type only for room join (NOT state creation)
    const { rows } = await pool.query(
      `SELECT vehicle_type FROM drivers WHERE user_id = $1`,
      [driverId]
    );

    if (!rows.length || !rows[0].vehicle_type) {
      console.warn(`Driver ${driverId} has no vehicle_type in DB`);
      return;
    }

    const vehicleType = rows[0].vehicle_type.toUpperCase();

    // ✅ Rooms
    socket.join('available_drivers');
    socket.join(`drivers:${vehicleType}`);

    // ✅ UPDATE ONLY (NO object creation)
    activeDrivers[driverId].socketId = socket.id;
    activeDrivers[driverId].lastSeen = Date.now();

    await pool.query(
      `UPDATE drivers SET is_online = TRUE WHERE user_id = $1`,
      [driverId]
    );

    console.log(`✅ Driver ${driverId} re-attached ONLINE as ${vehicleType}`);
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
		// socket.on('driverLocationUpdate', async (payload = {}) => {
		  // try {
			// const userId = payload.userId?.toString();
			// if (!userId) return;

			// const latitude = Number(payload.latitude);
			// const longitude = Number(payload.longitude);
			// if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
			  // console.warn(`Invalid location for driver ${userId}:`, payload.latitude, payload.longitude);
			  // return;
			// }
			// const vt = payload.vehicleType ? String(payload.vehicleType).toUpperCase() : null;

			// if (!activeDrivers[userId]) {
			  // activeDrivers[userId] = {
				// socketId: socket.id, latitude, longitude, vehicleType: vt || undefined, lastSeen: Date.now(),
			  // };
			// } else {
			  // Object.assign(activeDrivers[userId], { latitude, longitude, lastSeen: Date.now() });
			  // if (vt) activeDrivers[userId].vehicleType = vt;
			// }

			// if (vt) {
			  // const room = `drivers:${vt}`;
			  // if (!socket.rooms.has(room)) { socket.join(room); console.log(`🚕 Driver ${userId} joined ${room} via location update`); }
			// }

			// try {
			  // await pool.query(
				// `UPDATE drivers
				   // SET current_location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
					   // last_seen = NOW(), is_online = TRUE
				 // WHERE user_id = $3`,
				// [latitude, longitude, userId]
			  // );
			// } catch (e) { console.warn(`persist location failed for ${userId}:`, e.message); }

			// socket.broadcast.emit('driverLocation', { userId, latitude, longitude });
		  // } catch (e) { console.warn('driverLocationUpdate error:', e); }
		// });
		
		
		socket.on('driverLocationUpdate', async (payload = {}) => {
	  try {
		const userId = payload.userId?.toString();
		if (!userId) return;

		const latitude = Number(payload.latitude);
		const longitude = Number(payload.longitude);
		if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
		  console.warn(`Invalid location for driver ${userId}:`, payload.latitude, payload.longitude);
		  return;
		}

		// --- START OF THE GUARANTEED FIX ---

		// 1. Get the vehicle type from the payload IF it exists.
		const vehicleTypeFromPayload = payload.vehicleType ? String(payload.vehicleType).toUpperCase() : null;

		// 2. Check if the driver is already known.
		const existingDriver = activeDrivers[userId];

		if (!existingDriver) {
		  // If driver is new, create the entry with whatever vehicleType we received.
		  activeDrivers[userId] = {
			socketId: socket.id,
			latitude,
			longitude,
			vehicleType: vehicleTypeFromPayload, // Might be null, that's ok for the first entry.
			lastSeen: Date.now(),
		  };
		} else {
		  // If driver already exists, update their details.
		  existingDriver.latitude = latitude;
		  existingDriver.longitude = longitude;
		  existingDriver.lastSeen = Date.now();
		  if (existingDriver.isForeground !== false) {
  existingDriver.isForeground = true;
}


		  // THIS IS THE MOST IMPORTANT LINE:
		  // ONLY update the vehicleType if the payload provides a NEW, valid one.
		  // Otherwise, leave the existing vehicleType (from the 'join' event) untouched.
		 if (
  vehicleTypeFromPayload &&
  typeof vehicleTypeFromPayload === 'string' &&
  vehicleTypeFromPayload.length > 1
) {
  existingDriver.vehicleType = vehicleTypeFromPayload;
}
		}
		
		// --- END OF THE GUARANTEED FIX ---


		// The rest of your function remains the same, ensuring the driver is in the correct room.
		const finalVehicleType = activeDrivers[userId]?.vehicleType;
		if (finalVehicleType) {
			const room = `drivers:${finalVehicleType}`;
			if (!socket.rooms.has(room)) {
				socket.join(room);
				console.log(`🚕 Driver ${userId} joined ${room} via location update`);
			}
		}

		// Your database update logic is good and stays the same.
		try {
		  await pool.query(
			`UPDATE drivers
			   SET current_location = ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
				   last_seen = NOW(), is_online = TRUE
			 WHERE user_id = $3`,
			[latitude, longitude, userId]
		  );
		} catch (e) {
		  console.warn(`persist location failed for ${userId}:`, e.message);
		}

		// Broadcasting to other clients is also fine.
		socket.broadcast.emit('driverLocation', { userId, latitude, longitude });
		
		// 🟢 OPTION-A STEP 2: PASSIVE ROUTE SNAPSHOT
		if (!activeDrivers[userId]?.isForeground) {
  return; // background / ride ended / app idle
}
 if (!activeDrivers[userId]?.isOnActiveRide) return;

		try
		{
const activeRideId = await getActiveRideIdForDriver(pool, userId);

// ❌ NO ACTIVE RIDE → HARD STOP
if (!activeRideId) {
 
  return;
}


// ⏱ NOW CHECK TIMER
if (!shouldLogRouteSnapshot(activeRideId)) return;


// ✅ SAFE TO LOG
await logRouteSnapshot(pool, {
  rideExternalId: activeRideId,
  latitude,
  longitude,
  speedKmph: payload.speed ?? null,
});

delete lastRouteSnapshotAt[String(activeRideId)];

} catch (e) {
  console.warn('route snapshot failed:', e.message);
}




	  } catch (e) {
		console.warn('driverLocationUpdate error:', e);
	  }
	});

		/* ---------- request ride (strict 3km, prioritized notifications) ---------- */
		// socket.on('requestRide', async (payload = {}) => {
		  // try {
			// const passengerId = Number(payload.passengerId);
			// const extId = (payload.rideId && String(payload.rideId)) || `ride_${Date.now()}`;
			// const requestedVehicleType = (payload.vehicleType || '').toString().toUpperCase();
			// const estFare   = Number(payload.estimatedFare) || 0;
			// const distanceKm = Number(payload.distanceKm) || 0;
			// const pickup     = payload.pickupLocation || payload.pickup || {};
			// const drop       = payload.destinationLocation || payload.destination || {};
			// const passengerLoc = payload.passengerLocation || pickup;

			// if (!passengerId || !pickup || !drop || !requestedVehicleType) {
			  // socket.emit('rideCreateError', { message: 'Missing required fields' });
			  // return;
			// }

			// const pickupAddr = pickup.address || null;
			// const dropAddr   = drop.address || null;

			// const insertSql = `
			  // INSERT INTO rides (
				// passenger_id, pickup_location, dropoff_location,
				// pickup_address, dropoff_address, status, requested_at,
				// estimated_fare, vehicle_type, distance_km, external_id
			  // )
			  // VALUES (
				// $1,
				// ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
				// ST_SetSRID(ST_MakePoint($4,$5),4326)::geography,
				// $6,$7,'PENDING',NOW(),$8,$9,$10,$11
			  // )
			  // RETURNING id
			// `;
			// const params = [
			  // passengerId,
			  // Number(pickup.longitude), Number(pickup.latitude),
			  // Number(drop.longitude),   Number(drop.latitude),
			  // pickupAddr, dropAddr,
			  // estFare, requestedVehicleType, distanceKm, extId
			// ];
			// const { rows } = await pool.query(insertSql, params);
			// const dbId = rows[0].id;

			// const PROXIMITY_KM = 3.0;
			// const passengerLat = Number(passengerLoc.latitude);
			// const passengerLng = Number(passengerLoc.longitude);

			// // Use prioritized candidate finder
			// const candidates = await findCandidateDrivers(passengerLat, passengerLng, requestedVehicleType, new Set(), PROXIMITY_KM);

			// // tuning: how long maximum delay (ms) to give low-acceptance drivers
			// const MAX_DELAY_MS = 4000;
			// // tuning: baseline immediate batch size
			// const IMMEDIATE_BATCH = 3;

			// let notified = 0;
			// candidates.forEach((c, idx) => {
			  // const acceptRate = (typeof c.acceptRate === 'number') ? c.acceptRate : 0;
			  // const rate = Math.max(0, Math.min(1, acceptRate));
			  // const baseDelay = (idx < IMMEDIATE_BATCH) ? 0 : Math.round((1 - rate) * MAX_DELAY_MS);

			  // setTimeout(() => {
				// const current = activeDrivers[c.driverId];
				// if (!current || !current.socketId) return;
				// const dist = c.distance != null ? c.distance : haversineDistanceKm(passengerLat, passengerLng, current.latitude, current.longitude);
				// io.to(current.socketId).emit('newRideRequest', {
				  // ...payload,
				  // rideId: extId,
				  // dbId,
				  // vehicleType: requestedVehicleType,
				  // distanceToPickup: (dist != null ? dist.toFixed(2) : '0.00'),
				  // prioritized: true,
				  // acceptRate: rate,
				  // rematch: false,
				// });
			  // }, baseDelay);

			  // notified++;
			// });

			// socket.emit('rideCreated', { rideId: extId, dbId, status: 'PENDING', driversNotified: notified });

			// if (notified === 0) {
			  // console.log(`🟠 No ${requestedVehicleType} drivers within ${PROXIMITY_KM} km`);
			  // socket.emit('noDriversNearby', { vehicleType: requestedVehicleType, radiusKm: PROXIMITY_KM });
			// } else {
			  // console.log(`🟢 Ride ${extId} created, notified ${notified} driver(s)`);
			// }
		  // } catch (err) {
			// console.error('requestRide insert/match error', err);
			// socket.emit('rideCreateError', { message: 'Could not create/match ride' });
		  // }
		  // // snapshot helpful for debugging
		  // console.log('activeDrivers snapshot:', JSON.stringify(activeDrivers, null, 2));
		// });
		
		// In socket.js
	// ❌ DELETE your old 'requestRide' handler.
	// ✅ PASTE this new, final, and correct version.
	// In socket.js
	// ✅ REPLACE your entire 'requestRide' handler with this final version.

	socket.on('requestRide', async (payload = {}) => {
  try {
    const passengerId = Number(payload.passengerId);
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
    const finalAmountRupees = Number(payload.estimatedFare) || 0;
    const surgeMultiplier = Number(payload.surge_multiplier) || 1.0;

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

// ✅ Safe to build payload now
const rideRequestPayload = {
  externalId: extId,
  passengerId: passengerId.toString(),
  otp,
  vehicleType: requestedVehicleType,
  distanceKm,
  sentAt: Date.now().toString(),
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
  }
};


    let notified = 0;
    rideNotifiedDrivers[extId] = new Set();
	setTimeout(() => {
  delete rideNotifiedDrivers[extId];
}, 10 * 60 * 1000); // 10 minutes
for (const c of candidates) {
  try {
    const current = activeDrivers[c.driverId];

    // 🟢 CASE 1: App foreground → SOCKET ONLY
    if (current?.socketId && current.isForeground === true) {
      io.to(current.socketId).emit('newRideRequest', rideRequestPayload);
    } 
    // 🔔 CASE 2: App background / killed → NOTIFICATION ONLY
    else {
      await sendNotificationToUser(
        c.driverId,
        '🚕 New Ride Request',
        `Pickup nearby • ₹${finalAmountRupees}`,
        {
          type: 'NEW_RIDE',
          rideId: String(extId),
          sentAt: Date.now().toString(),
        }
      );
    }

    notified++;
    rideNotifiedDrivers[extId].add(String(c.driverId));
  } catch (e) {
    console.warn(`Notify failed for driver ${c.driverId}:`, e.message);
  }
}


    // ---- ACKs ----
    socket.emit('searchStarted', {
      rideId: extId,
      notifiedDrivers: notified
    });

    socket.emit('rideCreated', {
      rideId: extId,
      dbId,
      status: 'PENDING',
      driversNotified: notified
    });

    if (notified === 0) {
      socket.emit('noDriversNearby', {
        vehicleType: requestedVehicleType,
        radiusKm: PROXIMITY_KM
      });
    }

    console.log(`🟢 Ride ${extId} created, notified ${notified} driver(s)`);
	
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
  }
}, 30_000);

	} catch (err) {
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
      sentAt: Date.now().toString(),
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
    sentAt: Date.now().toString(),
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

    } catch (e) {
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

		// 4. THE CRITICAL FIX: Start the rematch process in the background.
		// It will automatically exclude the driver who just rejected the ride.
	//io.to('available_drivers').emit('dismissRideRequest', { rideId });
		startRematchRounds(rideId, passengerSocketId, vehicleType, pickupLat, pickupLon, [driverId]);

	  } catch (e) {
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
         SET status = 'CANCELLED_BY_DRIVER',
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
       SET status='PENDING',
           driver_id=NULL,
           cancelled_at=NOW(),
           cancelled_by='DRIVER'
       WHERE external_id=$1`,
      [rideId]
    );

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

    startRematchRounds(
      rideId,
      passengerSocketId,
      pQ.rows[0].vehicle_type,
      pQ.rows[0].pickup_lat,
      pQ.rows[0].pickup_lon,
      [driverId]
    );

    socket.emit('driverCancelAck', {
      rideId,
      message: 'Ride cancelled. Finding another driver.',
    });

    console.log(`🚫 Normal ride ${rideId} cancelled by driver ${driverId}`);
	delete lastRouteSnapshotAt[String(rideId)];
delete global.routeDeviationConsent?.[rideId];



  } catch (e) {
    console.warn('driverCancel error:', e);
  }
});

		

		// socket.on('cancelRide', async (payload = {}) => {
		  // try {
			// const rideId = payload.rideId?.toString();
			// const passengerId = payload.userId?.toString() || payload.passengerId?.toString();
			// if (rideId) {
			  // await pool.query(
				// `UPDATE rides SET status='CANCELLED', cancelled_at=NOW(), cancelled_by='PASSENGER'
				  // WHERE external_id=$1`,
				// [rideId]
			  // );
			  // const { rows } = await pool.query(`SELECT driver_id FROM rides WHERE external_id=$1`, [rideId]);
			  // const driverId = rows?.[0]?.driver_id?.toString();
			  // if (driverId && activeDrivers[driverId]) {
				// io.to(activeDrivers[driverId].socketId).emit('rideCancelled', { rideId, by: 'PASSENGER' });
			  // }
			// }
			// console.log(`❌ cancelRide ride=${rideId || '(no id)'} by passenger=${passengerId || '?'}`);
		  // } catch (e) { console.warn('cancelRide error', e); }
		// });
		
		// ✅ REPLACE the 'cancelRide' handler in socket.js with this one

	// socket.on('cancelRide', async (payload = {}) => {
	  // try {
		// const rideId = payload.rideId?.toString();
		// const passengerId = payload.userId?.toString() || payload.passengerId?.toString();

		// if (!rideId) {
		  // console.warn('cancelRide called without a rideId.');
		  // return;
		// }

		// console.log(`❌ Passenger ${passengerId || '?'} is attempting to cancel ride ${rideId}`);

		// // First, get the driver_id BEFORE updating the ride status
		// const rideQuery = await pool.query(
			// `SELECT driver_id FROM rides WHERE external_id = $1`,
			// [rideId]
		// );

		// const driverId = rideQuery.rows[0]?.driver_id?.toString();

		// // Now, update the ride status in the database
		// await pool.query(
		  // `UPDATE rides
			  // SET status = 'CANCELLED',
				  // cancelled_at = NOW(),
				  // cancelled_by = 'PASSENGER'
			// WHERE external_id = $1`,
		  // [rideId]
		// );

		// // --- THIS IS THE CRUCIAL FIX ---
		// // If a driver was assigned to this ride, notify them.
		// if (driverId) {
		 // const dKey = String(driverId);
// const driverSocketId = activeDrivers[dKey]?.socketId;
		  // if (driverSocketId) {
			// console.log(`📢 Notifying driver ${driverId} on socket ${driverSocketId} that the ride was cancelled.`);
			// // Use a clear, specific event name
			// io.to(driverSocketId).emit('rideCancelledByPassenger', {
			  // rideId: rideId,
			    // type: rideId.startsWith('sched_') ? 'SCHEDULED' : 'NORMAL',
			  // message: 'The passenger has cancelled the ride.'
			// });
			// io.to(driverSocketId).emit('dismissRideRequest', {
  // rideId,
  // reason: 'cancelled_by_passenger'
// });
			
		  // } else {
			// console.log(`Driver ${driverId} was assigned but is not actively connected.`);
		  // }
		// }
		// // --- END OF FIX ---
		 // delete rideNotifiedDrivers[String(rideId)];

	  // } catch (e) {
		// console.error('Error during cancelRide:', e);
	  // }
	  
	 

	// });
	
	
	socket.on('cancelRide', async (payload = {}) => {
  try {
    const rideId =
      payload.rideId?.toString();
    const passengerId =
      payload.userId?.toString() || payload.passengerId?.toString();

    if (!rideId) return;

    console.log(`❌ Passenger ${passengerId || '?'} cancelling ${rideId}`);

    const isScheduledRide = rideId.startsWith('sched_');

    // =====================================================
    // 🟣 SCHEDULED RIDE (100% SAFE – SEPARATE TABLE)
    // =====================================================
    if (isScheduledRide) {
      await pool.query(
        `UPDATE scheduled_rides
         SET status='CANCELLED',
             cancelled_at=NOW(),
             cancelled_by='PASSENGER'
         WHERE external_id=$1`,
        [rideId]
      );

      const q = await pool.query(
        `SELECT driver_id FROM scheduled_rides WHERE external_id=$1`,
        [rideId]
      );

      const driverId = q.rows[0]?.driver_id?.toString();
      const dSid = activeDrivers[driverId]?.socketId;

      if (dSid) {
        io.to(dSid).emit('rideCancelledByPassenger', {
          rideId,
          type: 'SCHEDULED'
        });
      }

      delete global.routeDeviationConsent?.[rideId];
      console.log(`🟣 Scheduled ride ${rideId} cancelled`);
      return; // ⛔ STOP HERE (important)
    }

    // =====================================================
    // 🟢 NORMAL RIDE
    // =====================================================

    // 1️⃣ get assigned driver BEFORE updating status
    const rideRes = await pool.query(
      `SELECT driver_id FROM rides WHERE external_id=$1`,
      [rideId]
    );

    const driverId = rideRes.rows[0]?.driver_id?.toString();

    // 2️⃣ update DB
    await pool.query(
      `UPDATE rides
       SET status='CANCELLED',
           cancelled_at=NOW(),
           cancelled_by='PASSENGER'
       WHERE external_id=$1`,
      [rideId]
    );

    // 3️⃣ 🔥 CRITICAL FIX: notify ACCEPTED DRIVER directly
    if (driverId && activeDrivers[driverId]?.socketId) {
      io.to(activeDrivers[driverId].socketId).emit(
        'rideCancelledByPassenger',
        {
          rideId,
          type: 'NORMAL'
        }
      );

      io.to(activeDrivers[driverId].socketId).emit(
        'dismissRideRequest',
        {
          rideId,
          reason: 'cancelled_by_passenger'
        }
      );

      console.log(`📢 Cancel sent to active driver ${driverId}`);
    }

    // 4️⃣ also dismiss any pending offers (safe)
    const notifiedSet = rideNotifiedDrivers[rideId] || new Set();
    for (const dId of notifiedSet) {
      const d = activeDrivers[dId];
      if (d?.socketId) {
        io.to(d.socketId).emit('dismissRideRequest', {
          rideId,
          reason: 'cancelled_by_passenger'
        });
      }
    }

    // 5️⃣ cleanup
    delete rideNotifiedDrivers[rideId];
    delete global.routeDeviationConsent?.[rideId];

  } catch (e) {
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
    console.error('driver-check-active-ride error:', e);
    socket.emit('driver-active-ride-status', { hasActiveRide: false });
  }
});




	   // In socket.js
	// ✅ PASTE THIS NEW, FINAL, AND CORRECT 'verifyOtp' HANDLER
	// In socket.js
	// ❌ DELETE your old 'verifyOtp' listener.
	// ✅ PASTE this new, final, and absolutely correct version.

	// socket.on('verifyOtp', async (data) => {
  // try {
    // const { rideId, otp } = data;

    // // ✅✅✅ THE FINAL FIX IS HERE ✅✅✅
    // // 1. Force the driverId to be a clean number.
    // const driverId = Number(data.driverId);

    // // 2. Add a strong guard to check for valid data.
    // if (!rideId || !otp || !driverId || isNaN(driverId)) {
      // return socket.emit('otpFailed', { rideId, message: 'Missing or invalid data for OTP verification.' });
    // }
    // // ✅✅✅ END OF FIX ✅✅✅

    // // 3. The rest of the handler can now safely use the numeric driverId.
    // const rideQuery = await pool.query(
      // `SELECT
          // otp,
          // passenger_id,
          // ST_Y(dropoff_location::geometry) as dest_lat,
          // ST_X(dropoff_location::geometry) as dest_lon
       // FROM rides
       // WHERE external_id = $1 AND driver_id = $2`, // This query will now work correctly!
      // [rideId, driverId] // Use the clean, numeric driverId
    // );

    // if (rideQuery.rows.length === 0) {
      // // This error will now only appear for genuinely incorrect rides.
      // return socket.emit('otpFailed', { rideId, message: 'Ride not found or not assigned to you.' });
    // }

    // const ride = rideQuery.rows[0];

    // // Verify the OTP (this part is correct)
    // if (ride.otp !== otp) {
      // return socket.emit('otpFailed', { rideId, message: 'Incorrect OTP provided.' });
    // }

    // // Update ride status and driver's stats (this part is correct)
    // await pool.query(
      // "UPDATE rides SET status = 'IN_TRANSIT', started_at = NOW() WHERE external_id = $1",
      // [rideId]
    // );
    // await pool.query(
      // `UPDATE drivers SET accepted_count = COALESCE(accepted_count, 0) + 1 WHERE user_id = $1`,
      // [driverId] // Use the numeric driverId here too
    // );

    // // Send destination data to the driver (this part is correct)
    // const passengerId = ride.passenger_id?.toString();
    // const driverSocketId = activeDrivers[driverId]?.socketId;
    // const passengerSocketId = activePassengers[passengerId]?.socketId;

    // if (driverSocketId) {
      // const destinationPayload = {
        // latitude: ride.dest_lat,
        // longitude: ride.dest_lon,
      // };
      // io.to(driverSocketId).emit('otpVerified', {
        // rideId: rideId,
        // destination: destinationPayload,
      // });
    // }
	


    // // Notify passenger (this part is correct)
		// // Original bug: io.to(passengerSocketId).emit('otpVerified', { rideId: rideId });
    // if (passengerSocketId) {
      // io.to(passengerSocketId).emit('rideStarted', {
          // rideId: rideId,
          // startedAt: new Date().toISOString()
      // });
    // }

    // console.log(`🔓 OTP Verified for ride ${rideId}. Trip is now IN_TRANSIT.`);

  // } catch (error) {
    // console.error(`❌ Error in verifyOtp for ride ${data.rideId}:`, error);
    // socket.emit('otpFailed', { rideId: data.rideId, message: 'A server error occurred.' });
  // }
// });
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

    if (String(ride.otp).trim() !== String(otp).trim()) {
      return socket.emit('otpFailed', {
        rideId,
        message: 'Incorrect OTP provided.'
      });
    }

    await pool.query(
      `UPDATE rides SET status='IN_TRANSIT', started_at=NOW()
       WHERE external_id=$1`,
      [rideId]
    );

if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = true;
}

// 🧹 IMPORTANT: purana ride ka snapshot memory clean
delete lastRouteSnapshotAt[String(rideId)];


    // ✅ USE IT HERE (DON’T REDECLARE)
    if (driverSocketId) {
      io.to(driverSocketId).emit('otpVerified', {
        rideId,
        destination: {
          latitude: ride.dest_lat,
          longitude: ride.dest_lon,
        }
      });
    }

    const passengerId = ride.passenger_id?.toString();
    const passengerSocketId = activePassengers[passengerId]?.socketId;

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
    console.error('verifyOtp error:', e);
  }
});


//for schedule module otp process
// ✅✅✅ PASTE THIS ENTIRE NEW HANDLER INTO socket.js ✅✅✅
// ❌ DELETE the 'verify-scheduled-otp' handler I gave you before.
// ✅ PASTE this new, final, and correct version in its place.

// socket.on('verify-scheduled-otp', async (data) => {
  // const client = await pool.connect();
  // try {
    // const { rideId, otp } = data;
    // const driverId = Number(data.driverId);

    // if (!rideId || !otp || !driverId || isNaN(driverId)) {
      // throw new Error('Invalid data received for OTP verification.');
    // }

    // await client.query('BEGIN'); // Start transaction for safety

    // // Step 1: Find the ride in the "Reservation Book" (scheduled_rides)
    // const scheduledRideQuery = await client.query(
      // `SELECT
          // *,
          // ST_Y(dropoff_location::geometry) AS "dropoffLatitude",
          // ST_X(dropoff_location::geometry) AS "dropoffLongitude"
       // FROM scheduled_rides
       // WHERE external_id = $1 AND driver_id = $2`,
      // [rideId, driverId]
    // );

    // if (scheduledRideQuery.rows.length === 0) {
      // // This is the error you are seeing. The scheduled ride wasn't found for this driver.
      // throw new Error('Scheduled ride not found or not assigned to you.');
    // }

    // const s_ride = scheduledRideQuery.rows[0];

    // // Step 2: Verify the OTP from that record
   // const otpFromDb = String(ride.otp ?? '').trim();
// const otpFromClient = String(otp ?? '').trim();

// if (otpFromDb !== otpFromClient) {
  // return socket.emit('otpFailed', { rideId, message: 'Incorrect OTP provided.' });
// }

    // // Step 3: OTP IS CORRECT! Now, we "promote" it to the "Active Job Log" (rides table).
    // // This is the most important step that implements your correct design.
    // console.log(`OTP Correct for ${rideId}. Promoting to 'rides' table.`);
    // await client.query(
        // `INSERT INTO rides (
            // external_id, passenger_id, driver_id, pickup_location, dropoff_location,
            // pickup_address, dropoff_address, status, vehicle_type, estimated_fare,
            // distance_km, otp, surge_multiplier, accepted_at, started_at, requested_at
         // )
         // VALUES ($1, $2, $3, $4, $5, $6, $7, 'IN_TRANSIT', $8, $9, $10, $11, $12, $13, NOW(), $14)
         // ON CONFLICT (external_id) DO NOTHING`, // This prevents errors if it somehow already exists
        // [
          // s_ride.external_id, s_ride.passenger_id, s_ride.driver_id,
          // s_ride.pickup_location, s_ride.dropoff_location, s_ride.pickup_address,
          // s_ride.dropoff_address, s_ride.vehicle_type, s_ride.estimated_fare,
          // s_ride.distance_km, s_ride.otp, s_ride.surge_multiplier,
          // s_ride.accepted_at, s_ride.scheduled_pickup_time // Use scheduled time as requested_at
        // ]
    // );

    // // Step 4: Update the status in both places to keep them in sync.
    // await client.query(`UPDATE scheduled_rides SET status = 'IN_TRANSIT' WHERE external_id = $1`, [rideId]);
    // await client.query(`UPDATE rides SET status = 'IN_TRANSIT', started_at = NOW() WHERE external_id = $1`, [rideId]);


    // await client.query('COMMIT'); // All database changes are now saved.

    // // --- The rest of the logic is for notifying the apps ---
    // const passengerId = s_ride.passenger_id?.toString();
    // const driverSocketId = activeDrivers[driverId]?.socketId;
    // const passengerSocketId = activePassengers[passengerId]?.socketId;

    // if (driverSocketId) {
      // // This is the event the driver app is waiting for to show the route.
      // io.to(driverSocketId).emit('otpVerified', {
        // rideId: rideId,
        // destination: {
          // latitude: s_ride.dropoffLatitude,
		  // longitude: s_ride.dropoffLongitude,
        // },
		// dropoffAddress: s_ride.dropoff_address,
      // });
    // }

    // // if (passengerSocketId) {
      // // io.to(passengerSocketId).emit('rideStarted', { rideId: rideId });
    // // }
// if (passengerSocketId) {
  // const payloadForPassenger = {
    // rideId: rideId,
    // status: 'IN_TRANSIT',
    // startedAt: new Date().toISOString()
  // };

  // io.to(passengerSocketId).emit('otpVerified', payloadForPassenger);
  // io.to(passengerSocketId).emit('rideStarted', payloadForPassenger);
// }

    // console.log(`🔓 OTP Verified for scheduled ride ${rideId}. Trip is now IN_TRANSIT.`);

  // } catch (error) {
    // await client.query('ROLLBACK');
    // console.error(`❌ Error in verify-scheduled-otp for ride ${data.rideId}:`, error);
    // socket.emit('otpFailed', { rideId: data.rideId, message: error.message });
  // } finally {
    // client.release();
  // }
// });

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
              ST_Y(dropoff_location::geometry) AS dropoffLatitude,
              ST_X(dropoff_location::geometry) AS dropoffLongitude
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
            distance_km, otp, surge_multiplier, accepted_at, started_at, requested_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_TRANSIT',$8,$9,$10,$11,$12,$13,NOW(),$14)
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
          s_ride.scheduled_pickup_time
        ]
    );

    await client.query(`UPDATE scheduled_rides SET status='IN_TRANSIT' WHERE external_id=$1`, [rideId]);
    await client.query(`UPDATE rides SET status='IN_TRANSIT', started_at=NOW() WHERE external_id=$1`, [rideId]);
	
if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = true;
}

    const passengerId = s_ride.passenger_id.toString();
    const passengerSocketId = activePassengers[passengerId]?.socketId;
    if (driverSocketId) {
      io.to(driverSocketId).emit("otpVerified", {
        rideId,
        destination: {
        latitude: s_ride.dropofflatitude ?? s_ride.dropoffLatitude,
      longitude: s_ride.dropofflongitude ?? s_ride.dropoffLongitude
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
          estimated_fare, surge_multiplier
       FROM rides WHERE external_id = $1 LIMIT 1`,
      [rideId]
    );

    if (rideQuery.rows.length === 0) {
      console.error(`completeRide: Ride with ID ${rideId} not found.`);
      await client.query('ROLLBACK');
      //client.release();
      return;
    }
    const rideRow = rideQuery.rows[0];

    const finalTotalR = Math.round(Number(rideRow.estimated_fare || 0));
    await client.query(
      `UPDATE rides SET status = 'COMPLETED', final_fare = $1, completed_at = NOW() WHERE external_id = $2`,
      [finalTotalR, rideId]
    );
    if (rideId.startsWith('sched_')) {
      await client.query(`UPDATE scheduled_rides SET status = 'COMPLETED' WHERE external_id = $1`, [rideId]);
    }

    // --- 💎 YOUR NEW, CORRECT DECIMAL FINANCIAL CALCULATIONS 💎 ---
    const isGstApplicableRide = isGstApplicable(rideRow.vehicle_type);
    const divisor = isGstApplicableRide ? 1.05 : 1.0;

    const baseExactR = finalTotalR / divisor; // e.g., 192.3809...
    const totalGstExactR = finalTotalR - baseExactR; // e.g., 9.6190...
    const cgstR_exact = totalGstExactR / 2; // e.g., 4.8095...
    const sgstR_exact = totalGstExactR / 2; // e.g., 4.8095...
    const platformBaseShareR_exact = baseExactR * 0.35; // e.g., 67.333...
    const driverBaseShareR_exact = baseExactR * 0.65; // e.g., 125.047...
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
        const companyOwedRounded = Math.round(companyOwedExact); // e.g. 77
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
        // Company owes driver his 65% share
        const driverShareRounded = Math.round(driverBaseShareR_exact);
        if (driverShareRounded > 0) {
            await client.query(
                `INSERT INTO wallet_ledger (driver_id, ride_external_id, type, direction, amount_paise, note)
                 VALUES ($1, $2, 'CREDIT_ONLINE', 'CR', $3, 'Driver Earning from Online Ride') ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
                [Number(driverId), rideId, driverShareRounded] // Storing final rounded Rupee
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
const finalRoundedR = Math.round(totalExactR);

	// --- Ride Invoice Insert (Now uses correct decimal variables) ---
	const { rows: ins } = await client.query(
		  `INSERT INTO ride_invoices (
		    ride_external_id, passenger_id, driver_id, vehicle_type, pickup_address, dropoff_address,
		    ride_started_at, ride_completed_at, base_amount_paise, surge_amount_paise,
            cgst_paise, sgst_paise, total_paise, rounded_rupees, created_at
	      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
	      ON CONFLICT (ride_external_id) DO UPDATE SET
		    base_amount_paise = EXCLUDED.base_amount_paise, surge_amount_paise = EXCLUDED.surge_amount_paise,
		    cgst_paise = EXCLUDED.cgst_paise, sgst_paise = EXCLUDED.sgst_paise,
		    total_paise = EXCLUDED.total_paise, rounded_rupees = EXCLUDED.rounded_rupees
	      RETURNING id`,
		  [
            rideRow.external_id, rideRow.passenger_id, Number(driverId), rideRow.vehicle_type,
  rideRow.pickup_address, rideRow.dropoff_address, rideRow.requested_at, new Date(),
	baseExactR,        // decimal
  surgeR_exact,      // decimal
  cgstR_exact,       // decimal
  sgstR_exact,       // decimal
  totalExactR,       // ✅ decimal total
  finalRoundedR  
          ]
		);
	const invoiceId = ins[0].id;
	const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	await client.query(`UPDATE ride_invoices SET invoice_number = 'LR' || $1::text || LPAD(id::text, 6, '0') WHERE id = $2 AND (invoice_number IS NULL OR invoice_number = '')`,[ymd, invoiceId]);
	console.log(`🧾 Auto-invoice upserted for ${rideId}`);

	// --- Your perfect finalize, unlock, and notify logic remains ---
	await client.query('COMMIT');
	delete lastRouteSnapshotAt[String(rideId)];


		if (activeDrivers[String(driverId)]) {
  activeDrivers[String(driverId)].isOnActiveRide = false;
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

	console.log(`🏁 Completed ${rideId}, fare=${finalTotalR}, cash=${!!paidByCash}`);
	if (passengerId) {
		const pSid = activePassengers[passengerId]?.socketId;
		if (pSid) io.to(pSid).emit('rideCompleted', { rideId, driverId, finalFare: finalTotalR, paidByCash: !!paidByCash });
	}
	const dSid = activeDrivers[driverId]?.socketId;
	if (dSid) io.to(dSid).emit('rideCompleted', { rideId, finalFare: finalTotalR, paidByCash: !!paidByCash,
	passengerId: rideRow.passenger_id?.toString()});
	
	delete global.routeDeviationConsent?.[rideId];
	delete sosTimers[rideId];
	
	await pool.query(
  `UPDATE rides SET is_sos_active = FALSE WHERE external_id = $1`,
  [rideId]
);


  } catch (e) {
	await client.query('ROLLBACK');
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
        console.error('❌ Error in submitDriverRating:', e);
    } finally {
        client.release();
    }
});

	

	socket.on('sendMessage', (data) => {
		/*
		  Expected data format:
		  {
			rideId: "the_current_ride_id",
			recipientId: "user_id_of_passenger_or_driver",
			senderId: "user_id_of_the_sender",
			message: "Hello, I'm here."
		  }
		*/
		const { rideId, recipientId, senderId, message } = data;

		if (!recipientId || !senderId || !message) {
		  console.log('Invalid message data received:', data);
		  return;
		}

		console.log(`Message for ride ${rideId} from ${senderId} to ${recipientId}`);

		// --- ✅ START OF THE FIX ---
		// Instead of a missing function, we look up the recipient's socket.id
		// in the maps you ALREADY maintain.
		let recipientSocketId = null;

		// Is the recipient a passenger?
		if (activePassengers[recipientId]) {
			recipientSocketId = activePassengers[recipientId].socketId;
		}
		// Or is the recipient a driver?
		else if (activeDrivers[String(recipientId)]) {
  recipientSocketId = activeDrivers[String(recipientId)].socketId;
}
		// --- ✅ END OF THE FIX ---

		if (recipientSocketId) {
		  console.log(`Found recipient socket: ${recipientSocketId}. Forwarding message.`);
		  // Forward the message ONLY to the intended recipient.
		  io.to(recipientSocketId).emit('receiveMessage', {
			rideId: rideId,
			senderId: senderId,
			message: message,
			timestamp: new Date().toISOString() // Use ISO string for cross-platform safety
		  });
		} else {
		  console.log(`Could not find active socket for recipient: ${recipientId}. They might be offline.`);
		  // Optionally, you could store the message in the database as "undelivered".
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
      sentAt: Date.now().toString(),
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


  } catch (e) {
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

// const dSid = activeDrivers[String(driverId)]?.socketId;
// if (dSid) {
  // io.to(dSid).emit('newRideRequest', payload);
// }

    console.log(`🔁 Resent ride ${rideId} to driver ${driverId}`);
  } catch (e) {
    console.error('driver-request-ride-resend error:', e);
  }
});


//passenger and driver safety module start 

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



// 🛡️ ROUTE DEVIATION (SOFT) — OPTION A
socket.on('route_deviation_soft', async (payload = {}) => {
  try {
	  
	   if (process.env.NODE_ENV === 'production') {
      console.log('❌ route_deviation_soft (manual) blocked in production');
      return;
    }
	  
    // ⛔ Guard: payload empty
    if (!payload?.rideExternalId || !payload?.driverId) return;

    // 👉 Delegate ALL logic (no brain here)
    await SafetyService.handleRouteDeviationSoft(socket, payload);

  } catch (err) {
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
    console.error('route_change_decision error:', e.message);
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
    console.error('sos_resolved error:', e.message);
  }
});



//close here safety related changes

		/* ---------- disconnect ---------- */
	socket.on('disconnect', async () => {
  console.log('🔌 Socket disconnected:', socket.id);

  for (const [driverId, d] of Object.entries(activeDrivers)) {
    if (d.socketId === socket.id) {
      // 🔹 Soft-disconnect (do NOT delete yet)
      d.socketId = null;
      d.lastSeen = Date.now();
	 d.isForeground = false;


      console.log(`🧹 Soft-disconnected driver ${driverId}`);
      break;
    }
  }

for (const [pid, p] of Object.entries(activePassengers)) {
  if (p?.socketId === socket.id) {
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

