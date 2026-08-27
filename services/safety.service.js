// safety.service.js
const SafetyRepo = require('../repositories/safety.repo');
const RideRepo = require('../repositories/ride.repo');
const {
  SOFT_DEVIATION_DISTANCE_M,
  SOFT_DEVIATION_DURATION_SEC,
  MIN_SPEED_KMPH,
  DEVIATION_EVENT_COOLDOWN_SEC
} = require('../constants/safety.constants');


function bearingDiff(b1, b2) {
  let diff = Math.abs(b1 - b2);
  return diff > 180 ? 360 - diff : diff;
}



async function handleRouteDeviationSoft(socket, payload) {
  const pool = socket.dbPool;
  const consentMap = socket.routeDeviationConsent;

  if (!pool) return;

  const {
    rideExternalId,
    driverId,
    passengerId,
    distanceMeters,
    durationSeconds,
    lat,
    lng,
    speedKmph
  } = payload;
  

  // 🛡 Passenger already agreed → ignore all future deviations
  if (consentMap?.[rideExternalId] === 'AGREE') return;

  // 1️⃣ Validate ride
  const ride = await RideRepo.getByExternalId(pool, rideExternalId);
  if (!ride || ride.status !== 'IN_TRANSIT') return;
  if (String(ride.driver_id) !== String(driverId)) return;

  // 2️⃣ Threshold checks
  if (distanceMeters < SOFT_DEVIATION_DISTANCE_M) return;
  if (durationSeconds < SOFT_DEVIATION_DURATION_SEC) return;
  if (speedKmph < MIN_SPEED_KMPH) return;

  // 3️⃣ Cooldown check
  const lastEvent =
    await SafetyRepo.getLastDeviationEvent(pool, rideExternalId);

  if (lastEvent) {
    const diffSec =
      (Date.now() - new Date(lastEvent.created_at)) / 1000;
    if (diffSec < DEVIATION_EVENT_COOLDOWN_SEC) return;
  }

  // 4️⃣ Read current safety state
  const state =
    await SafetyRepo.getSafetyState(pool, rideExternalId);

  // ===============================
  // 🔴 HARD DEVIATION (3rd time)
  // ===============================
  if (
    state?.deviation_count >= 2 &&
    state.passenger_decision === 'DISAGREE'
  ) {
    await handleHardDeviation(socket, payload);
    return;
  }

  // ===============================
  // 🟠 SECOND DEVIATION (Final warning)
  // ===============================
  if (
    state?.deviation_count === 1 &&
    state.passenger_decision === 'DISAGREE'
  ) {
    await handleSecondDeviation(socket, payload);
    return;
  }

  // ===============================
  // 🟢 FIRST SOFT DEVIATION
  // ===============================

  // 5️⃣ Insert event (history)
  await SafetyRepo.insertRouteDeviation(pool, {
    rideExternalId,
    driverId,
    passengerId,
    distanceMeters,
    durationSeconds,
    lat,
    lng,
    speedKmph
  });

  // 6️⃣ Create / update safety state
await SafetyRepo.upsertSafetyState(
  pool,
  rideExternalId
);

  // 7️⃣ Notify passenger (soft info)
  socket.to(`passenger:${passengerId}`).emit(
    'ride_safety_warning',
    {
      type: 'SOFT_ROUTE_DEVIATION',
      rideExternalId,
      message:
        'Your driver seems to be taking a different route.'
    }
  );

  // 8️⃣ Notify driver (explain required)
  socket.to(`driver:${driverId}`).emit(
    'soft_route_deviation',
    {
      rideExternalId,
      allowExplain: true
    }
  );
}

/**
 * SECOND DEVIATION
 * Passenger already disagreed once
 */
async function handleSecondDeviation(socket, payload) {
  const pool = socket.dbPool;
  const { rideExternalId, driverId, passengerId } = payload;

  // Update state → deviation_count = 2
  await SafetyRepo.updateDeviationState(
    pool,
    rideExternalId,
    2
  );

  // Driver final warning
  socket.to(`driver:${driverId}`).emit(
    'route_warning_final',
    {
      message:
        'Passenger disagreed. Please follow the suggested route. Final warning.'
    }
  );

  // Passenger informational (NO ACTION REQUIRED)
  socket.to(`passenger:${passengerId}`).emit(
    'safety_update',
    {
      level: 'WARNING',
      message:
        'Driver is still off-route. We are monitoring closely.'
    }
  );
}

/**
 * HARD DEVIATION
 * Driver ignored warnings
 */
async function handleHardDeviation(socket, payload) {
  const pool = socket.dbPool;
  const { rideExternalId, driverId, passengerId } = payload;

  // Mark hard deviation
  await SafetyRepo.markHardDeviation(
    pool,
    rideExternalId
  );

  // Admin alert
  socket.to('admin_room').emit(
    'hard_safety_event',
    {
      type: 'ROUTE_NON_COMPLIANCE',
      rideExternalId,
      driverId
    }
  );

  // Passenger choice (NOT forced)
  socket.to(`passenger:${passengerId}`).emit(
    'ride_termination_choice',
    {
      reason:
        'Driver is not following the route despite warnings.',
      options: ['END_RIDE_NOW', 'CONTINUE_RIDE']
    }
  );
}

module.exports = {
  handleRouteDeviationSoft,
  handleSecondDeviation,
  handleHardDeviation
};
