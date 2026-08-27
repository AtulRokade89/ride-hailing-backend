// utils/dispatcher.js

const initSocketServer = require('../socket');
const { getPassengerBadge } = require('./ratingUtils');


/**
 * Accurate distance calculation (Haversine formula)
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in KM
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Find and notify drivers for a scheduled ride
 */
async function findDriverForRide(ride, pool) {
  console.log(`[DISPATCHER] Initiating driver search for ${ride.external_id}`);

  const client = await pool.connect();
  
  // ⭐ Fetch passenger average rating for scheduled ride
let passengerAvgRating = 0;

try {
  const r = await client.query(
    `
    SELECT ROUND(AVG(rating), 1) AS avg_rating
    FROM passenger_ratings
    WHERE passenger_id = $1
    `,
    [ride.passenger_id]
  );

  passengerAvgRating = Number(r.rows[0]?.avg_rating || 0);
} catch (e) {
  console.warn(
    `[DISPATCHER] Passenger rating fetch failed for ${ride.external_id}:`,
    e.message
  );
}


  try {
    // --------------------------------------------------
    // 1️⃣ Lock the scheduled ride (CRITICAL)
    // --------------------------------------------------
    const result = await client.query(
      `
      UPDATE scheduled_rides
      SET status = 'SEARCHING',
          is_locked = TRUE,
          locked_until = NOW() + INTERVAL '2 minutes'
      WHERE external_id = $1
        AND status = 'SCHEDULED'
        AND is_locked = FALSE
      RETURNING id
      `,
      [ride.external_id]
    );

    // Already processed / locked
    if (result.rowCount === 0) {
      console.log(
        `[DISPATCHER] Ride ${ride.external_id} already locked or not eligible`
      );
      return;
    }

    // --------------------------------------------------
    // 2️⃣ Prepare socket + driver pool
    // --------------------------------------------------
    const io = initSocketServer.getIo();
    const activeDrivers = initSocketServer.getActiveDrivers();

    const vehicleType = String(ride.vehicle_type).toUpperCase();

    // Pickup location = SOURCE OF TRUTH
const pickupLat = Number(ride.pickup_lat);
const pickupLng = Number(ride.pickup_lng);

if (Number.isNaN(pickupLat) || Number.isNaN(pickupLng)) {
  console.error(
    `[DISPATCHER] Invalid pickup coordinates for ${ride.external_id}`,
    pickupLat,
    pickupLng
  );
  return;
}

    const MAX_KM = 10; // radius for scheduled rides
    const notifiedDrivers = new Set();
	if (!global.rideNotifiedDrivers) {
  global.rideNotifiedDrivers = {};
}

if (!global.rideNotifiedDrivers[ride.external_id]) {
  global.rideNotifiedDrivers[ride.external_id] = new Set();
}

    // --------------------------------------------------
    // 3️⃣ Filter + notify drivers
    // --------------------------------------------------
    for (const [driverId, d] of Object.entries(activeDrivers)) {
      if (!d) continue;
      if (!d.socketId) continue;
      if (d.isForeground === false) continue;
      if (String(d.vehicleType).toUpperCase() !== vehicleType) continue;
      if (d.latitude == null || d.longitude == null) continue;

      const distanceKm = haversineKm(
        pickupLat,
        pickupLng,
        d.latitude,
        d.longitude
      );

      if (distanceKm > MAX_KM) continue;
      if (notifiedDrivers.has(driverId)) continue;

      notifiedDrivers.add(driverId);

      io.to(d.socketId).emit('new-scheduled-ride-request', {
        rideId: ride.external_id,
		passengerId: ride.passenger_id, 
        pickupAddress: ride.pickup_address,
        dropoffAddress: ride.dropoff_address,
        pickupLatitude: pickupLat,
        pickupLongitude: pickupLng,
        estimatedFare: ride.estimated_fare,
        scheduledPickupTime: ride.scheduled_pickup_time,
        vehicleType,
        distanceToPickup: distanceKm.toFixed(2),
		passenger: {
    avgRating: passengerAvgRating,
    badge: getPassengerBadge(passengerAvgRating),
  },
      });
	  global.rideNotifiedDrivers[ride.external_id].add(String(driverId));

      console.log(
        `📨 Scheduled ride ${ride.external_id} sent to driver ${driverId} (${distanceKm.toFixed(2)} km)`
      );
    }

  console.log(
  `🧠 [DISPATCHER] rideNotifiedDrivers[${ride.external_id}] =`,
  Array.from(global.rideNotifiedDrivers[ride.external_id])
);

  } catch (error) {
    console.error(
      `[DISPATCHER] Error while dispatching ${ride.external_id}`,
      error
    );

    // --------------------------------------------------
    // 🔁 Rollback ONLY if ride was moved to SEARCHING
    // --------------------------------------------------
    try {
      await client.query(
        `
        UPDATE scheduled_rides
        SET status = 'SCHEDULED',
            is_locked = FALSE,
            locked_until = NULL
        WHERE external_id = $1
          AND status = 'SEARCHING'
        `,
        [ride.external_id]
      );
      console.log(`[DISPATCHER] Rollback completed for ${ride.external_id}`);
    } catch (rollbackErr) {
      console.error(
        `[DISPATCHER] Rollback failed for ${ride.external_id}`,
        rollbackErr
      );
    }
	
	delete global.rideNotifiedDrivers[ride.external_id];

  } finally {
    client.release();
  }
}

module.exports = { findDriverForRide };





