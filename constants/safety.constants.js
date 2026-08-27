//D:\ride-hailing-project\ride-hailing-backend\constants\safety.constants.js

const isTest = process.env.SAFETY_TEST_MODE === 'true';

module.exports = {
  SOFT_DEVIATION_DISTANCE_M: isTest ? 50 : 300,
  SOFT_DEVIATION_DURATION_SEC: isTest ? 5 : 25,
  MIN_SPEED_KMPH: isTest ? 1 : 5,
  DEVIATION_EVENT_COOLDOWN_SEC: isTest ? 10 : 120
};
