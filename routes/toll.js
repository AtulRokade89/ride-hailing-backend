// routes/toll.js
// ─────────────────────────────────────────────────────────────────────────────
//  Toll Charges — REST route (no socket.js entry needed)
//  Mounts at: /api/toll
//
//  POST /api/toll/add          → Driver toll submit karta hai
//  POST /api/toll/respond      → Passenger approve / reject karta hai
//  GET  /api/toll/:rideId      → Invoice ke liye approved toll fetch
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

// ─── Socket IO access ────────────────────────────────────────────────────────
// socket.js module.exports = initSocketServer (function)
// io instance ek baar init hone ke baad global.io me store karte hain (see below)
// activePassengers aur activeDrivers global me expose karte hain via socket.js init
// Isliye hum global.socketIo use karenge jo server.js me set kiya hai
//
// server.js me yeh add karo jahan initSocketServer call karo:
//   const io = initSocketServer(server, pool);
//   global.socketIo        = io;
//   global.activeDrivers   = activeDrivers;    // ← socket.js ke top se
//   global.activePassengers= activePassengers; // ← socket.js ke top se
//
// (Yeh ek baar karna hai, baaki sab automatically kaam karega)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helper ──────────────────────────────────────────────────────────────────
function getIo() { return global.io; }
function getActiveDrivers()  { return global.activeDrivers  || {}; }
function getPassengers()     { return global.activePassengers || {}; }

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/toll/add
//  Body: { rideId, rideType ('NORMAL'|'SCHEDULED'), driverId, tollAmount }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/add', async (req, res) => {
  const pool = global.pool;
  const { rideId, rideType, driverId, tollAmount } = req.body;

  // Validation
  if (!rideId || !rideType || !driverId || !tollAmount) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  const amount = parseFloat(tollAmount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid_toll_amount' });
  }
  const type = String(rideType).toUpperCase();
  if (!['NORMAL', 'SCHEDULED'].includes(type)) {
    return res.status(400).json({ error: 'invalid_ride_type' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Ride exist karta hai? Driver match karta hai? Active hai? ────────
    let passengerId, pickupAddr, dropoffAddr, driverName, passengerName;

    if (type === 'NORMAL') {
      const r = await client.query(
        `SELECT r.passenger_id, r.pickup_address, r.dropoff_address,
                ud.name AS driver_name, up.name AS passenger_name
         FROM rides r
         JOIN users ud ON ud.id = $2
         JOIN users up ON up.id = r.passenger_id
         WHERE r.external_id = $1
           AND r.driver_id   = $2
           AND r.status IN ('ACCEPTED','ARRIVED','IN_TRANSIT')`,
        [rideId, driverId]
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'active_ride_not_found_for_driver' });
      }
      ({ passenger_id: passengerId, pickup_address: pickupAddr,
         dropoff_address: dropoffAddr, driver_name: driverName,
         passenger_name: passengerName } = r.rows[0]);

    } else {
      const r = await client.query(
        `SELECT sr.passenger_id, sr.pickup_address, sr.dropoff_address,
                ud.name AS driver_name, up.name AS passenger_name
         FROM scheduled_rides sr
         JOIN users ud ON ud.id = $2
         JOIN users up ON up.id = sr.passenger_id
         WHERE sr.external_id = $1
           AND sr.driver_id   = $2
           AND sr.status IN ('ACCEPTED','IN_TRANSIT')`,
        [rideId, driverId]
      );
      if (!r.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'active_scheduled_ride_not_found_for_driver' });
      }
      ({ passenger_id: passengerId, pickup_address: pickupAddr,
         dropoff_address: dropoffAddr, driver_name: driverName,
         passenger_name: passengerName } = r.rows[0]);
    }

    // ── Already ek PENDING toll hai is ride ke liye? ─────────────────────
    const existing = await client.query(
      `SELECT id FROM toll_charges
       WHERE (ride_id = $1 OR scheduled_ride_id = $1)
         AND passenger_status = 'PENDING'`,
      [rideId]
    );
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'toll_already_pending_for_this_ride' });
    }

    // ── Insert toll record ─────────────────────────────────────────────────
    const insertQ = type === 'NORMAL'
      ? `INSERT INTO toll_charges
           (ride_id, passenger_id, driver_id, passenger_name, driver_name, toll_amount)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`
      : `INSERT INTO toll_charges
           (scheduled_ride_id, passenger_id, driver_id, passenger_name, driver_name, toll_amount)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`;

    const ins = await client.query(insertQ,
      [rideId, passengerId, driverId, passengerName, driverName, amount]);
    const tollId = ins.rows[0].id;

    await client.query('COMMIT');

    // ── Socket: passenger ko notify karo ──────────────────────────────────
try {
  const io          = getIo();
  // Room-based messaging is better than socketId mapping
  if (io) {
    // ✅ ROOM-BASED EMISSION: Hamesha isi format me bhejein
    io.to(`passenger:${passengerId}`).emit('tollChargeRequest', {
      tollId,
      rideId,
      rideType: type,
      tollAmount: amount,
      driverName,
      pickupAddress:  pickupAddr,
      dropoffAddress: dropoffAddr,
      message: `Driver has paid Rs.${amount} toll pay. Please approve.`,
    });
    console.log(`[TOLL] 📢 Notified room passenger:${passengerId} — toll Rs.${amount}`);
  } else {
    console.warn(`[TOLL] ⚠️ Socket IO not available`);
  }
} catch (sockErr) {
  console.error('[TOLL] Socket notify error:', sockErr.message);
}

    return res.status(201).json({
      ok: true,
      tollId,
      message: 'Toll request sent to passenger for approval.',
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[TOLL] /add error:', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  } finally {
    client.release();
  }
});


// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/toll/respond
//  Body: { tollId, passengerId, action ('APPROVED'|'REJECTED') }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/respond', async (req, res) => {
  const pool = global.pool;
  const { tollId, passengerId, action } = req.body;

  if (!tollId || !passengerId || !action) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  const act = String(action).toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(act)) {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Toll record fetch ──────────────────────────────────────────────────
    const tollRes = await client.query(
      `SELECT * FROM toll_charges WHERE id = $1 AND passenger_id = $2`,
      [tollId, passengerId]
    );
    if (!tollRes.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'toll_not_found' });
    }
    const toll = tollRes.rows[0];

    if (toll.passenger_status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'toll_already_responded' });
    }

    // ── Status update ──────────────────────────────────────────────────────
    await client.query(
      `UPDATE toll_charges
         SET passenger_status = $1, passenger_responded_at = NOW()
       WHERE id = $2`,
      [act, tollId]
    );

    // ── APPROVED → ride ki fare me toll amount add karo ────────────────────
    let newFare = null;
    if (act === 'APPROVED') {
     if (toll.ride_id) {
  // ✅ estimated_fare mat badlo — toll alag track hota hai toll_charges table mein
  const upd = await client.query(
    `SELECT estimated_fare FROM rides WHERE external_id = $1`,
    [toll.ride_id]
  );
  // newFare = base + toll (for UI display only)
  newFare = parseFloat(upd.rows[0]?.estimated_fare || 0) + toll.toll_amount;
} else {
  const upd = await client.query(
    `SELECT estimated_fare FROM scheduled_rides WHERE external_id = $1`,
    [toll.scheduled_ride_id]
  );
  newFare = parseFloat(upd.rows[0]?.estimated_fare || 0) + toll.toll_amount;
}
    }

    await client.query('COMMIT');

    const rideId = toll.ride_id || toll.scheduled_ride_id;

    // ── Socket: driver ko notify karo ──────────────────────────────────────
    try {
      const io            = getIo();
      const activeDrivers = getActiveDrivers();
      const passengers    = getPassengers();

      const dSock = activeDrivers[String(toll.driver_id)]?.socketId;

      if (io && dSock) {
        if (act === 'APPROVED') {
          io.to(dSock).emit('tollApprovedByPassenger', {
            tollId,
            rideId,
            tollAmount:   toll.toll_amount,
            newTotalFare: newFare,
            message: `Passenger ne Rs.${toll.toll_amount} toll approve kar diya! Total fare updated.`,
          });
        } else {
          io.to(dSock).emit('tollRejectedByPassenger', {
            tollId,
            rideId,
            tollAmount: toll.toll_amount,
            message: `Passenger ne toll reject kar diya. Aap dobara submit kar sakte ho.`,
          });
        }
        console.log(`[TOLL] 📢 Driver ${toll.driver_id} notified — toll ${act}`);
      }

      // Passenger ko bhi fare update bhejo (approve case me)
      if (act === 'APPROVED' && io) {
        const pSock = passengers[String(passengerId)]?.socketId;
        if (pSock) {
          io.to(pSock).emit('fareUpdatedWithToll', {
            rideId,
            tollAmount:   toll.toll_amount,
            newTotalFare: newFare,
          });
        }
      }
    } catch (sockErr) {
      console.error('[TOLL] Socket notify error:', sockErr.message);
    }

    return res.json({
      ok: true,
      action: act,
      tollId,
      newTotalFare: newFare,
      message: act === 'APPROVED'
        ? `Toll Rs.${toll.toll_amount} approved. Fare updated.`
        : `Toll Rs.${toll.toll_amount} rejected. No fare change.`,
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[TOLL] /respond error:', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  } finally {
    client.release();
  }
});


// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/toll/:rideId?rideType=NORMAL|SCHEDULED
//  Invoice generation ke liye approved toll fetch karna
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:rideId', async (req, res) => {
  const pool    = global.pool;
  const rideId  = req.params.rideId;
  const rideType = String(req.query.rideType || 'NORMAL').toUpperCase();

  if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  try {
    const whereCol = rideType === 'SCHEDULED' ? 'scheduled_ride_id' : 'ride_id';

    const { rows } = await pool.query(
      `SELECT
         id, toll_amount, passenger_status,
         passenger_name, driver_name,
         created_at, passenger_responded_at
       FROM toll_charges
       WHERE ${whereCol} = $1
       ORDER BY created_at ASC`,
      [rideId]
    );

    const approvedTotal = rows
      .filter(r => r.passenger_status === 'APPROVED')
      .reduce((sum, r) => sum + parseFloat(r.toll_amount), 0);

    return res.json({ ok: true, tolls: rows, approved_total: approvedTotal });

  } catch (e) {
    console.error('[TOLL] /get error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});


module.exports = router;