// D:/ride-hailing-project/ride-hailing-backend/routes/schedule.js

const express = require('express');
const router = express.Router();
// ✅✅✅ THIS IS THE FIX. IMPORT THE POOL DIRECTLY. ✅✅✅
const { sendNotificationToUser } = require('../services/notification_sender');


// --- FARE LOGIC (This code is perfect) ---
const SCHEDULED_RIDE_PREMIUM_MULTIPLIER = 1.15;
function computeScheduledFareINR(vehicleType, distanceKm) {
  // ... (no changes needed here)
  const vt = String(vehicleType || '').toUpperCase();
  const base = vt === 'MINI' ? 40 : vt === 'SEDAN' ? 70 : vt === 'SUV' ? 100 : 70;
  const perKm = vt === 'MINI' ? 10 : vt === 'SEDAN' ? 15 : vt === 'SUV' ? 20 : 15;
  const km = Math.max(0, Number(distanceKm) || 0);
  const normalFare = (base + perKm * km);
  return Math.round(normalFare * SCHEDULED_RIDE_PREMIUM_MULTIPLIER * 100) / 100;
}

// --- GET A QUOTE (This code is perfect) ---
const GST_RATE = 0.05;
router.get('/quote', (req, res) => {
    // ... (no changes needed here)
    const { vehicleType, distanceKm } = req.query;
    if (!['MINI', 'SEDAN', 'SUV'].includes(String(vehicleType).toUpperCase())) {
        return res.status(400).json({ error: 'invalid_vehicle_type_for_scheduling' });
    }
    const distance = parseFloat(distanceKm);
    if (isNaN(distance) || distance <= 0) {
        return res.status(400).json({ error: 'invalid_distance' });
    }
    const baseFare = computeScheduledFareINR(vehicleType, distance);
    const cgst = baseFare * (GST_RATE / 2);
    const sgst = baseFare * (GST_RATE / 2);
    const totalWithGst = baseFare + cgst + sgst;
    res.json({
        base_rupees: baseFare.toFixed(2),
        cgst_rupees: cgst.toFixed(2),
        sgst_rupees: sgst.toFixed(2),
        estimatedFare: Math.round(totalWithGst),
        total_rupees: totalWithGst.toFixed(2)
    });
});

// --- CREATE A RIDE (✅ USE `pool` HERE) ---
router.post('/create', async (req, res) => {
	const pool = global.pool; 
    const { passengerId, pickup, destination, vehicleType, distanceKm, estimatedFare, scheduledPickupTime } = req.body;
    if (!passengerId || !pickup || !destination || !vehicleType || !scheduledPickupTime) {
        return res.status(400).json({ error: 'missing_required_fields' });
    }
    try {
        const externalId = `sched_${passengerId}_${Date.now()}`;
        // ✅ Use the imported 'pool'
        await pool.query(
            `INSERT INTO scheduled_rides (
                external_id, passenger_id, pickup_location, dropoff_location,
                pickup_address, dropoff_address, vehicle_type, scheduled_pickup_time,
                estimated_fare, distance_km
            ) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9, $10, $11, $12)`,
            [externalId, passengerId, pickup.longitude, pickup.latitude, destination.longitude, destination.latitude, pickup.address, destination.address, vehicleType, scheduledPickupTime, estimatedFare, distanceKm]
        );
		
await sendNotificationToUser(
  passengerId,
  'Your Scheduled Ride is Confirmed!',
  'Tap to see details.',
  {
    type: 'SCHEDULED_ACCEPTED',
    rideId: externalId,
    scheduledPickupTime,
  }
);


		
        res.status(201).json({ ok: true, message: 'Ride scheduled successfully!', scheduleId: externalId });
    } catch (e) {
        console.error('Error creating scheduled ride:', e);
        res.status(500).json({ error: 'server_error', details: e.message });
    }
});

// --- GET UPCOMING RIDES (✅ USE `pool` HERE) ---
router.get('/upcoming', async (req, res) => {
  const pool = global.pool; 
  const { passengerId } = req.query;
  if (!passengerId) {
    return res.status(400).json({ error: 'passengerId_required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
          sr.external_id,
          sr.pickup_address,
          sr.dropoff_address,
          sr.vehicle_type,
          sr.scheduled_pickup_time,
          sr.estimated_fare,
          sr.status,

          -- pickup as { latitude, longitude }
          json_build_object(
            'latitude',  ST_Y(sr.pickup_location::geometry),
            'longitude', ST_X(sr.pickup_location::geometry)
          ) AS pickup_location,

          -- dropoff as { latitude, longitude }
          json_build_object(
            'latitude',  ST_Y(sr.dropoff_location::geometry),
            'longitude', ST_X(sr.dropoff_location::geometry)
          ) AS dropoff_location,

          -- driver_location from drivers.current_location (if any)
          json_build_object(
            'latitude',  ST_Y(d.current_location::geometry),
            'longitude', ST_X(d.current_location::geometry)
          ) AS driver_location

       FROM scheduled_rides sr
       LEFT JOIN drivers d ON d.user_id = sr.driver_id
       WHERE sr.passenger_id = $1
       ORDER BY sr.scheduled_pickup_time DESC`,
      [passengerId]
    );

    res.json({ scheduled_rides: rows });
  } catch (e) {
    console.error("Error fetching upcoming rides:", e);
    res.status(500).json({ error: 'server_error' });
  }
});


// This route gets ALL rides for a passenger, sorted by most recent first.
router.get('/passenger/:passengerId', async (req, res) => {
  const pool = global.pool; // You are already doing this correctly.
  const { passengerId } = req.params;

  if (!passengerId) {
    return res.status(400).json({ error: 'passengerId_is_required' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
          sr.external_id,
          sr.pickup_address,
          sr.dropoff_address,
          sr.vehicle_type,
          sr.scheduled_pickup_time,
          sr.estimated_fare,
          sr.status,
          sr.driver_id,

          -- Data from the 'users' table for driver info
          u.name AS driver_name,
          u.phone_number AS driver_contact,
          d.rating AS rating, -- The driver's overall rating
          dv.driver_photo_url AS driver_photo,

          -- Data from the 'vehicles' table
          d.vehicle_model AS vehicle_model,
          d.vehicle_number AS vehicle_number,

          -- All the location data your app needs
          json_build_object('latitude', ST_Y(sr.pickup_location::geometry), 'longitude', ST_X(sr.pickup_location::geometry)) AS pickup_location,
          json_build_object('latitude', ST_Y(sr.dropoff_location::geometry), 'longitude', ST_X(sr.dropoff_location::geometry)) AS dropoff_location,
          json_build_object('latitude', ST_Y(d.current_location::geometry), 'longitude', ST_X(d.current_location::geometry)) AS driver_location

       FROM scheduled_rides sr
       LEFT JOIN drivers d ON sr.driver_id = d.user_id
       LEFT JOIN users u ON sr.driver_id = u.id
	   LEFT JOIN driver_verifications dv ON sr.driver_id = dv.user_id
       WHERE sr.passenger_id = $1
       ORDER BY sr.scheduled_pickup_time DESC`, // Sort by most recent
      [passengerId]
    );

    res.json({ scheduled_rides: rows });

  } catch (e) {
    console.error(`[API-ERROR] Could not fetch all rides for passenger ${passengerId}:`, e);
    res.status(500).json({ error: 'server_error' });
  }
});





// --- CANCEL RIDE (✅ USE `pool` HERE) ---
router.post('/cancel', async (req, res) => {
	const pool = global.pool; 
    const { scheduleId, passengerId } = req.body;
    const PENALTY_AMOUNT = 50;
    if (!scheduleId || !passengerId) {
        return res.status(400).json({ error: 'missing_required_fields' });
    }
    // ✅ Use the imported 'pool'
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const rideQuery = await client.query(
            `SELECT scheduled_pickup_time FROM scheduled_rides WHERE external_id = $1 AND passenger_id = $2 AND status = 'SCHEDULED'`,
            [scheduleId, passengerId]
        );
        if (rideQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'scheduled_ride_not_found_or_already_cancelled' });
        }
        const scheduledTime = new Date(rideQuery.rows[0].scheduled_pickup_time);
        const now = new Date();
        const hoursUntilPickup = (scheduledTime.getTime() - now.getTime()) / (1000 * 60 * 60);
        let penaltyApplied = false;
        let message = 'Ride cancelled successfully. No penalty applied.';
        if (hoursUntilPickup <= 2) {
            await client.query(`UPDATE scheduled_rides SET schedule_penalty_due = $1 WHERE external_id = $2`, [PENALTY_AMOUNT, scheduleId]);
            penaltyApplied = true;
            message = `Ride cancelled late. A penalty of Rs.${PENALTY_AMOUNT} has been applied.`;
        }
        await client.query(
            `UPDATE scheduled_rides SET status = 'CANCELLED', cancelled_at = NOW(), cancellation_reason = $1, penalty_applied = $2 WHERE external_id = $3`,
            [penaltyApplied ? 'BY_PASSENGER_LATE' : 'BY_PASSENGER_EARLY', penaltyApplied, scheduleId]
        );
        await client.query('COMMIT');
        res.json({ ok: true, penalty_applied: penaltyApplied, message: message });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Error cancelling scheduled ride:', e);
        res.status(500).json({ error: 'server_error', details: e.message });
    } finally {
        client.release();
    }
});

// ✅✅✅ THIS IS THE FIX. EXPORT THE ROUTER DIRECTLY. ✅✅✅
module.exports = router;
