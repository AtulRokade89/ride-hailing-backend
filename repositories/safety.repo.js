//D:\ride-hailing-project\ride-hailing-backend\repositories\safety.repo.js

async function insertRouteDeviation(pool, data) {
  return pool.query(
    `
    INSERT INTO ride_safety_events (
      ride_external_id,
      driver_id,
      passenger_id,
      event_type,
      deviation_distance_m,
      deviation_duration_sec,
      latitude,
      longitude,
      speed_kmph,
      triggered_by
    )
    VALUES ($1,$2,$3,'SOFT_ROUTE_DEVIATION',$4,$5,$6,$7,$8,'SYSTEM')
    `,
    [
      data.rideExternalId,
      data.driverId,
      data.passengerId,
      data.distanceMeters,
      data.durationSeconds,
      data.lat,
      data.lng,
      data.speedKmph
    ]
  );
}

async function getLastDeviationEvent(pool, rideExternalId) {
  const { rows } = await pool.query(
    `
    SELECT created_at
    FROM ride_safety_events
    WHERE ride_external_id = $1
      AND event_type = 'SOFT_ROUTE_DEVIATION'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [rideExternalId]
  );

  return rows[0] || null;
}

async function getSafetyState(pool, rideExternalId) {
  const { rows } = await pool.query(
    `SELECT *
     FROM ride_safety_state
     WHERE ride_external_id = $1
     LIMIT 1`,
    [rideExternalId]
  );
  return rows[0] || null;
}

async function upsertSafetyState(pool, { rideExternalId, deviationCount }) {
  return pool.query(
    `
    INSERT INTO ride_safety_state (
      ride_external_id,
      deviation_count,
      last_event_at
    )
    VALUES ($1, $2, NOW())
    ON CONFLICT (ride_external_id)
    DO UPDATE
      SET deviation_count = ride_safety_state.deviation_count + 1,
          last_event_at = NOW()
    `,
    [rideExternalId, deviationCount]
  );
}



module.exports = {
  insertRouteDeviation,
  getLastDeviationEvent,
  getSafetyState,
  upsertSafetyState,  
};

