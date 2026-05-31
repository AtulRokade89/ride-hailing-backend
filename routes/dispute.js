// routes/dispute.js
const express = require('express');
const router  = express.Router();
const initSocketServer       = require('../socket');
const { sendNotificationToUser } = require('../services/notification_sender');

// ─────────────────────────────────────────────
// HELPER: Haversine — km between two GPS points
// ─────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


async function notifyDisputeResolved(pool, rideExternalId, disputeId, payload) {
  try {
    const io = initSocketServer.getIo();
    const activeDrivers = initSocketServer.getActiveDrivers();

    const { rows } = await pool.query(
      `SELECT driver_id, passenger_id FROM rides WHERE external_id=$1
       UNION ALL
       SELECT driver_id, passenger_id FROM scheduled_rides WHERE external_id=$1
       LIMIT 1`,
      [rideExternalId]
    );

    if (!rows.length) return;

    const { driver_id, passenger_id } = rows[0];
    const dSock = activeDrivers[String(driver_id)]?.socketId;
	const driverKey = String(driver_id);
if (activeDrivers[driverKey]) {
  activeDrivers[driverKey].isOnActiveRide = false;
  activeDrivers[driverKey].canReceiveQueuedRide = false;
  activeDrivers[driverKey].queuedRideId = [];
  activeDrivers[driverKey].lastSeen = Date.now();
}

    const socketPayload = {
      disputeId,
      rideExternalId,
      ...payload,
    };

    if (dSock) io.to(dSock).emit('disputeResolved', socketPayload);
    io.to(`passenger:${passenger_id}`).emit('disputeResolved', socketPayload);
  } catch (se) {
    console.error('Socket emit failed disputeResolved:', se.message);
  }
}


// ─────────────────────────────────────────────
// HELPER: Partial fare — same base rates as
// your existing fare logic in schedule.js/tax.js
// ─────────────────────────────────────────────

function computePartialFare(vehicleType, distanceKm) {
  const vt = String(vehicleType || '').toUpperCase();

  const base =
    vt === 'MINI'    ? 45  :
    vt === 'SEDAN'   ? 75  :
    vt === 'SUV'     ? 110 :
    vt === 'EV_MINI' ? 38  : 45;

  const perKm =
    vt === 'MINI'    ? 11  :
    vt === 'SEDAN'   ? 16  :
    vt === 'SUV'     ? 21  :
    vt === 'EV_MINI' ? 9   : 11;

  const km = Math.max(0, Number(distanceKm) || 0);
  // Minimum = base fare even if very short distance
  return Math.max(base, Math.round((base + perKm * km) * 100) / 100);
}


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dispute/raise
//
// Driver ya passenger dono raise kar sakte hain ride ke beech mein.
//
// Body:
// {
//   rideExternalId : "ride_123_xxx",
//   rideType       : "NORMAL",        ← "NORMAL" or "SCHEDULED"
//   raisedBy       : "driver",        ← "driver" or "passenger"
//   reason         : "Passenger misbehaving",
//   isSafety       : false,           ← true = admin ko turant alert
//   currentLat     : 18.9876,         ← driver ki current GPS
//   currentLng     : 72.8356
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/raise', async (req, res) => {
  const pool = global.pool;
  const {
    rideExternalId,
    rideType    = 'NORMAL',
    raisedBy,
    reason,
    isSafety    = false,
    currentLat,
    currentLng,
  } = req.body;

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!rideExternalId || !raisedBy || currentLat == null || currentLng == null) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (!['driver', 'passenger'].includes(raisedBy)) {
    return res.status(400).json({ error: 'invalid_raised_by' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Fetch ride from correct table ──────────────────────────────────
    let ride = null;

    if (rideType === 'SCHEDULED') {
      const { rows } = await client.query(
        `SELECT
            external_id,
            passenger_id,
            driver_id,
            vehicle_type,
            estimated_fare,
            distance_km,
            status,
            ST_Y(pickup_location::geometry) AS pickup_lat,
            ST_X(pickup_location::geometry) AS pickup_lng
         FROM scheduled_rides
         WHERE external_id = $1`,
        [rideExternalId]
      );
      ride = rows[0];
    } else {
      const { rows } = await client.query(
        `SELECT
            external_id,
            passenger_id,
            driver_id,
            vehicle_type,
            estimated_fare,
            distance_km,
            status,
            payment_mode,
            ST_Y(pickup_location::geometry) AS pickup_lat,
            ST_X(pickup_location::geometry) AS pickup_lng
         FROM rides
         WHERE external_id = $1`,
        [rideExternalId]
      );
      ride = rows[0];
    }

    if (!ride) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ride_not_found' });
    }

// ── Check existing dispute BEFORE status check ─────────────────────────
const existing = await client.query(
  `SELECT id, status, partial_fare, auto_resolve_at
   FROM ride_disputes
   WHERE ride_external_id = $1
   ORDER BY raised_at DESC
   LIMIT 1`,
  [rideExternalId]
);

if (existing.rows.length > 0) {
  await client.query('ROLLBACK');
  return res.status(409).json({
    error  : 'dispute_already_exists',
    dispute: existing.rows[0],
    message: 'A dispute is already open for this ride.',
  });
}

    // ── 2. Only active rides can be disputed ──────────────────────────────
   const allowedStatuses = ['ACCEPTED', 'IN_TRANSIT'];
if (!allowedStatuses.includes(ride.status)) {
  await client.query('ROLLBACK');
  return res.status(400).json({
    error  : 'ride_not_active',
    message: `Cannot raise dispute on ride with status: ${ride.status}`,
  });
    }


    // ── 4. Distance covered so far (pickup → current GPS) ─────────────────
    const distanceCoveredKm = haversineKm(
      Number(ride.pickup_lat),
      Number(ride.pickup_lng),
      Number(currentLat),
      Number(currentLng)
    );

    // ── 5. Partial fare ───────────────────────────────────────────────────
    const partialFare = computePartialFare(ride.vehicle_type, distanceCoveredKm);

    // ── 6. Timestamps ─────────────────────────────────────────────────────
    const now             = new Date();
    const autoResolveAt   = new Date(now.getTime() + 15 * 60 * 1000);       // +15 min
    const adminDeadlineAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // +48 hr

    // ── 7. Insert dispute ─────────────────────────────────────────────────
    const { rows: disputeRows } = await client.query(
      `INSERT INTO ride_disputes (
          ride_external_id,
          ride_type,
          raised_by,
          reason,
          dispute_lat,
          dispute_lng,
          distance_covered_km,
          partial_fare,
          status,
          raised_at,
          auto_resolve_at,
          admin_deadline_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',NOW(),$9,$10)
       RETURNING id`,
      [
        rideExternalId,
        rideType,
        raisedBy,
        reason || null,
        currentLat,
        currentLng,
        distanceCoveredKm.toFixed(2),
        partialFare,
        autoResolveAt,
        adminDeadlineAt,
      ]
    );
    const disputeId = disputeRows[0].id;

    // ── 8. Freeze ride → DISPUTED ─────────────────────────────────────────
    // IMPORTANT: Before using this, run this once in your DB:
    //
    // ALTER TABLE rides DROP CONSTRAINT rides_status_check;
    // ALTER TABLE rides ADD CONSTRAINT rides_status_check
    //   CHECK (status = ANY (ARRAY[
    //     'PENDING','ACCEPTED','IN_TRANSIT','COMPLETED',
    //     'CANCELLED','EXPIRED','QUEUED_CONFIRMED',
    //     'DISPUTED','PARTIAL_COMPLETE'
    //   ]));

    const table = rideType === 'SCHEDULED' ? 'scheduled_rides' : 'rides';
    await client.query(
      `UPDATE ${table} SET status = 'DISPUTED' WHERE external_id = $1`,
      [rideExternalId]
    );

    await client.query('COMMIT');

    // ── 9. Socket — notify both parties ──────────────────────────────────
    try {
      const io            = initSocketServer.getIo();
      const activeDrivers = initSocketServer.getActiveDrivers();
      const driverSockId  = activeDrivers[String(ride.driver_id)]?.socketId;

      const disputePayload = {
        disputeId,
        rideExternalId,
        raisedBy,
        reason            : reason || null,
        distanceCoveredKm : parseFloat(distanceCoveredKm.toFixed(2)),
        partialFare,
        autoResolveAt     : autoResolveAt.toISOString(),
        message           : `Dispute raised by ${raisedBy}. Partial fare ₹${partialFare} calculated.`,
      };

      if (driverSockId) io.to(driverSockId).emit('rideDisputeRaised', disputePayload);
      io.to(`passenger:${ride.passenger_id}`).emit('rideDisputeRaised', disputePayload);

    } catch (se) {
      console.error('❌ Socket emit failed (raise):', se.message);
    }

    // ── 10. Push notifications ────────────────────────────────────────────
    try {
      const notifMeta = {
        type     : 'DISPUTE_RAISED',
        rideId   : rideExternalId,
        disputeId: String(disputeId),
      };

      if (raisedBy === 'driver') {
        await sendNotificationToUser(
          ride.passenger_id,
          'Dispute Raised by Driver',
          `Your driver raised an issue. ₹${partialFare} is on hold pending review.`,
          notifMeta
        );
      } else {
        await sendNotificationToUser(
          ride.driver_id,
          'Dispute Raised by Passenger',
          `Passenger raised an issue. ₹${partialFare} is on hold pending review.`,
          notifMeta
        );
      }

      // Safety case → admin bhi alert hoga
      if (isSafety && process.env.ADMIN_USER_ID) {
        await sendNotificationToUser(
          process.env.ADMIN_USER_ID,
          '🚨 SAFETY DISPUTE',
          `Safety issue on ride ${rideExternalId}. Immediate review needed.`,
          { type: 'SAFETY_DISPUTE', rideId: rideExternalId, disputeId: String(disputeId) }
        );
      }
    } catch (ne) {
      console.error('❌ Push notification failed (raise):', ne.message);
    }

    return res.status(201).json({
      ok               : true,
      disputeId,
      partialFare,
      distanceCoveredKm: parseFloat(distanceCoveredKm.toFixed(2)),
      autoResolveAt    : autoResolveAt.toISOString(),
      adminDeadlineAt  : adminDeadlineAt.toISOString(),
      message          : isSafety
        ? 'Safety dispute raised. Admin alerted immediately.'
        : 'Dispute raised. Both parties have 15 minutes to agree on partial fare.',
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error raising dispute:', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  } finally {
    client.release();
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dispute/respond
//
// Driver ya passenger partial fare accept/reject karta hai.
//
// Body:
// {
//   disputeId   : 1,
//   respondedBy : "passenger",
//   accepted    : true
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/respond', async (req, res) => {
  const pool = global.pool;
  const { disputeId, respondedBy, accepted } = req.body;

  if (!disputeId || !respondedBy || accepted == null) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (!['driver', 'passenger'].includes(respondedBy)) {
    return res.status(400).json({ error: 'invalid_respondedBy' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Fetch dispute (locked) ─────────────────────────────────────────
    const { rows } = await client.query(
      `SELECT * FROM ride_disputes WHERE id = $1 FOR UPDATE`,
      [disputeId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'dispute_not_found' });
    }

    const dispute = rows[0];

    if (dispute.status !== 'OPEN') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error  : 'dispute_not_open',
        status : dispute.status,
        message: 'This dispute is no longer open for responses.',
      });
    }

    // ── 2. Save this party's response ─────────────────────────────────────
    const col = respondedBy === 'driver' ? 'driver_accepted' : 'passenger_accepted';
    await client.query(
      `UPDATE ride_disputes SET ${col} = $1 WHERE id = $2`,
      [accepted, disputeId]
    );

    // ── 3. Re-fetch — check if both responded ─────────────────────────────
    const { rows: updated } = await client.query(
      `SELECT driver_accepted, passenger_accepted,
              partial_fare, ride_external_id, ride_type
       FROM ride_disputes WHERE id = $1`,
      [disputeId]
    );
    const d = updated[0];

    const bothAccepted   = d.driver_accepted === true  && d.passenger_accepted === true;
    const anyoneRejected = d.driver_accepted === false || d.passenger_accepted === false;

    // ── OUTCOME A: Both agreed → Auto resolve ─────────────────────────────
    if (bothAccepted) {
      await client.query(
        `UPDATE ride_disputes
         SET status     = 'AUTO_RESOLVED',
             final_fare = partial_fare,
             resolved_at= NOW(),
             resolved_by= 'system'
         WHERE id = $1`,
        [disputeId]
      );

      const rideTable = d.ride_type === 'SCHEDULED' ? 'scheduled_rides' : 'rides';
      await client.query(
        `UPDATE ${rideTable}
         SET status     = 'PARTIAL_COMPLETE',
             final_fare = $1
         WHERE external_id = $2`,
        [d.partial_fare, d.ride_external_id]
      );

      await client.query('COMMIT');

      // Notify both via socket
      // try {
        // const io            = initSocketServer.getIo();
        // const activeDrivers = initSocketServer.getActiveDrivers();

        // // Fetch ids — try rides first, then scheduled_rides
        // const rideRow = await pool.query(
          // `SELECT driver_id, passenger_id FROM rides          WHERE external_id=$1
           // UNION ALL
           // SELECT driver_id, passenger_id FROM scheduled_rides WHERE external_id=$1
           // LIMIT 1`,
          // [d.ride_external_id]
        // );

        // if (rideRow.rows.length) {
          // const { driver_id, passenger_id } = rideRow.rows[0];
          // const dSock = activeDrivers[String(driver_id)]?.socketId;
          // const payload = {
            // disputeId,
            // rideExternalId: d.ride_external_id,
            // resolution    : 'AUTO_RESOLVED',
            // finalFare     : d.partial_fare,
            // message       : 'Both parties agreed. Partial fare finalised.',
          // };
          // if (dSock) io.to(dSock).emit('disputeResolved', payload);
          // io.to(`passenger:${passenger_id}`).emit('disputeResolved', payload);
        // }
      // } catch (se) {
        // console.error('❌ Socket emit failed (auto-resolve):', se.message);
      // }
	  
	  await notifyDisputeResolved(pool, d.ride_external_id, disputeId, {
  resolution: 'AUTO_RESOLVED',
  finalFare: d.partial_fare,
  message: 'Both parties agreed. Partial fare finalised.',
});

      return res.json({
        ok        : true,
        resolved  : true,
        resolution: 'AUTO_RESOLVED',
        finalFare : d.partial_fare,
        message   : 'Both parties agreed. Partial fare has been finalised.',
      });
    }

    // ── OUTCOME B: Someone rejected → admin queue ─────────────────────────
    if (anyoneRejected) {
      await client.query(
        `UPDATE ride_disputes SET status = 'PENDING_ADMIN_REVIEW' WHERE id = $1`,
        [disputeId]
      );
      await client.query('COMMIT');
	  
await notifyDisputeResolved(pool, d.ride_external_id, disputeId, {
  resolution: 'PENDING_ADMIN_REVIEW',
  message: 'Dispute escalated to admin. Fare on hold. Admin reviews within 48 hours.',
});
      return res.json({
        ok        : true,
        resolved  : false,
        resolution: 'PENDING_ADMIN_REVIEW',
        message   : 'Dispute escalated to admin. Fare on hold. Admin reviews within 48 hours.',
      });
    }

    // ── OUTCOME C: Only one party responded so far ────────────────────────
    await client.query('COMMIT');
    return res.json({
      ok        : true,
      resolved  : false,
      resolution: 'WAITING_FOR_OTHER_PARTY',
      message   : `Response saved. Waiting for ${respondedBy === 'driver' ? 'passenger' : 'driver'} to respond.`,
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error responding to dispute:', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  } finally {
    client.release();
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dispute/status/:rideExternalId
//
// App current dispute state check karne ke liye poll karta hai.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:rideExternalId', async (req, res) => {
  const pool = global.pool;
  const { rideExternalId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT
          id,
          ride_external_id,
          ride_type,
          raised_by,
          reason,
          distance_covered_km,
          partial_fare,
          final_fare,
          status,
          driver_accepted,
          passenger_accepted,
          raised_at,
          auto_resolve_at,
          admin_deadline_at,
          resolved_at,
          resolved_by,
          admin_notes
       FROM ride_disputes
       WHERE ride_external_id = $1
       ORDER BY raised_at DESC
       LIMIT 1`,
      [rideExternalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'no_dispute_found' });
    }

    return res.json({ dispute: rows[0] });
  } catch (e) {
    console.error('❌ Error fetching dispute status:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dispute/admin/pending
//
// Admin dashboard — saari PENDING_ADMIN_REVIEW disputes with full details.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/pending', async (req, res) => {
  const pool = global.pool;

  try {
    const { rows } = await pool.query(
      `SELECT
          rd.id                   AS dispute_id,
          rd.ride_external_id,
          rd.ride_type,
          rd.raised_by,
          rd.reason,
          rd.distance_covered_km,
          rd.partial_fare,
          rd.status,
          rd.raised_at,
          rd.admin_deadline_at,
          rd.driver_accepted,
          rd.passenger_accepted,

          u_p.name                AS passenger_name,
          u_p.phone_number        AS passenger_phone,

          u_d.name                AS driver_name,
          u_d.phone_number        AS driver_phone,

          COALESCE(r.pickup_address,  sr.pickup_address)  AS pickup_address,
          COALESCE(r.dropoff_address, sr.dropoff_address) AS dropoff_address,
          COALESCE(r.vehicle_type,    sr.vehicle_type)    AS vehicle_type,
          COALESCE(r.payment_mode,    'CASH')             AS payment_mode,
          COALESCE(r.estimated_fare,  sr.estimated_fare)  AS estimated_fare

       FROM ride_disputes rd

       LEFT JOIN rides r
         ON r.external_id = rd.ride_external_id AND rd.ride_type = 'NORMAL'

       LEFT JOIN scheduled_rides sr
         ON sr.external_id = rd.ride_external_id AND rd.ride_type = 'SCHEDULED'

       LEFT JOIN users u_p
         ON u_p.id = COALESCE(r.passenger_id, sr.passenger_id)

       LEFT JOIN users u_d
         ON u_d.id = COALESCE(r.driver_id, sr.driver_id)

       WHERE rd.status = 'PENDING_ADMIN_REVIEW'
       ORDER BY rd.raised_at ASC`
    );

    return res.json({ disputes: rows });
  } catch (e) {
    console.error('❌ Error fetching pending disputes:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


module.exports = router;