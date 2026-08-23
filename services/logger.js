// services/logger.js
// ═══════════════════════════════════════════════════════════════
// 🪵  PRODUCTION LOGGER — Ride Hailing Backend
// ═══════════════════════════════════════════════════════════════
// Covers  ✅ API        ✅ Ride       ✅ Payment
//         ✅ Socket     ✅ FCM        ✅ Slow Query
//         ✅ Health     ✅ Cron
//

const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || '500',  10);
const SLOW_API_MS   = parseInt(process.env.SLOW_API_MS   || '1000', 10);
const LOG_TO_DB     = process.env.LOG_TO_DB !== 'false';
const LOG_LEVEL     = process.env.LOG_LEVEL || 'info';

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

// ── Console printer ───────────────────────────────────────────
function print(level, tag, msg, meta) {
  if ((LEVEL_RANK[level] ?? 1) < (LEVEL_RANK[LOG_LEVEL] ?? 1)) return;

  const ts    = new Date().toISOString();
  const color = level === 'error' ? '\x1b[31m'
              : level === 'warn'  ? '\x1b[33m'
              : level === 'debug' ? '\x1b[2m'
              : '\x1b[0m';
  const reset = '\x1b[0m';
  const dim   = '\x1b[2m';
  const cyan  = '\x1b[36m';

  const metaStr = meta ? ' ' + dim + JSON.stringify(meta) + reset : '';
  console.log(
    `${dim}${ts}${reset} ${color}[${level.toUpperCase()}]${reset} ${cyan}[${tag}]${reset} ${msg}${metaStr}`
  );
}

// ── Async DB writer — fire-and-forget, NEVER throws ──────────
async function writeToDb(pool, table, data) {
  if (!LOG_TO_DB || !pool) return;
  try {
    const keys   = Object.keys(data);
    const vals   = Object.values(data);
    const cols   = keys.join(', ');
    const params = keys.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO ${table} (${cols}) VALUES (${params}) ON CONFLICT DO NOTHING`,
      vals
    );
  } catch (e) {
    // DB log failure MUST NOT crash the app
    console.error(`[LOGGER] DB write to ${table} failed:`, e.message);
  }
}


// ═══════════════════════════════════════════════════════════════
// 🚗  RIDE LOGGER
// ═══════════════════════════════════════════════════════════════
const rideLogger = {

  created(pool, { rideId, passengerId, vehicleType, estimatedFare, distanceKm, isScheduled = false }) {
    const type = isScheduled ? 'SCHEDULED' : 'INSTANT';
    print('info', 'RIDE', `🆕 ${type} ride CREATED | id=${rideId} passenger=${passengerId} vehicle=${vehicleType} fare=₹${estimatedFare}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'CREATED', ride_type: type,
      passenger_id: passengerId, vehicle_type: vehicleType,
      estimated_fare: estimatedFare, distance_km: distanceKm || null,
      meta: JSON.stringify({ isScheduled }),
    });
  },

  accepted(pool, { rideId, driverId, passengerId, vehicleType }) {
    print('info', 'RIDE', `✅ Ride ACCEPTED | id=${rideId} driver=${driverId} passenger=${passengerId}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'ACCEPTED',
      driver_id: driverId, passenger_id: passengerId, vehicle_type: vehicleType || null,
    });
  },

  started(pool, { rideId, driverId, passengerId }) {
    print('info', 'RIDE', `🚀 Ride STARTED | id=${rideId} driver=${driverId}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'STARTED',
      driver_id: driverId, passenger_id: passengerId,
    });
  },

  completed(pool, { rideId, driverId, passengerId, finalFare, paymentMode, distanceKm }) {
    print('info', 'RIDE', `🏁 Ride COMPLETED | id=${rideId} driver=${driverId} fare=₹${finalFare} mode=${paymentMode}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'COMPLETED',
      driver_id: driverId, passenger_id: passengerId,
      final_fare: finalFare, payment_mode: paymentMode, distance_km: distanceKm || null,
    });
  },

  cancelled(pool, { rideId, cancelledBy, passengerId, driverId, reason, penaltyApplied = false }) {
    print('warn', 'RIDE', `❌ Ride CANCELLED | id=${rideId} by=${cancelledBy} reason=${reason} penalty=${penaltyApplied}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'CANCELLED',
      driver_id: driverId || null, passenger_id: passengerId || null,
      meta: JSON.stringify({ cancelledBy, reason, penaltyApplied }),
    });
  },

  noDriverFound(pool, { rideId, passengerId, vehicleType, searchedCount = 0 }) {
    print('warn', 'RIDE', `🔍 NO DRIVER FOUND | id=${rideId} passenger=${passengerId} vehicle=${vehicleType} searched=${searchedCount}`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'NO_DRIVER_FOUND',
      passenger_id: passengerId, vehicle_type: vehicleType,
      meta: JSON.stringify({ searchedCount }),
    });
  },

  deviated(pool, { rideId, driverId, passengerId, distanceM, durationSec }) {
    print('warn', 'RIDE', `⚠️  Route DEVIATION | id=${rideId} driver=${driverId} dist=${distanceM}m dur=${durationSec}s`);
    writeToDb(pool, 'ride_event_logs', {
      ride_id: rideId, event: 'ROUTE_DEVIATION',
      driver_id: driverId, passenger_id: passengerId,
      meta: JSON.stringify({ distanceM, durationSec }),
    });
  },
};


// ═══════════════════════════════════════════════════════════════
// 💳  PAYMENT LOGGER
// ═══════════════════════════════════════════════════════════════
const paymentLogger = {

  orderCreated(pool, { rideId, passengerId, driverId, orderId, amount, type = 'RIDE' }) {
    print('info', 'PAYMENT', `📦 Order CREATED | ride=${rideId} order=${orderId} amount=₹${amount} type=${type}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: rideId, event: 'ORDER_CREATED', payment_type: type,
      passenger_id: passengerId || null, driver_id: driverId || null,
      razorpay_order_id: orderId, amount,
    });
  },

  verified(pool, { rideId, orderId, paymentId, passengerId }) {
    print('info', 'PAYMENT', `🔐 Payment VERIFIED | ride=${rideId} payment=${paymentId}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: rideId, event: 'PAYMENT_VERIFIED',
      passenger_id: passengerId || null,
      razorpay_order_id: orderId, razorpay_payment_id: paymentId,
    });
  },

  success(pool, { rideId, passengerId, driverId, orderId, paymentId, amount, mode }) {
    print('info', 'PAYMENT', `💚 Payment SUCCESS | ride=${rideId} payment=${paymentId} amount=₹${amount} mode=${mode}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: rideId, event: 'PAYMENT_SUCCESS',
      passenger_id: passengerId || null, driver_id: driverId || null,
      razorpay_order_id: orderId, razorpay_payment_id: paymentId,
      amount, payment_mode: mode,
    });
  },

  failed(pool, { rideId, orderId, passengerId, reason, errorCode }) {
    print('error', 'PAYMENT', `🔴 Payment FAILED | ride=${rideId} order=${orderId} reason=${reason}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: rideId, event: 'PAYMENT_FAILED',
      passenger_id: passengerId || null, razorpay_order_id: orderId,
      meta: JSON.stringify({ reason, errorCode }),
    });
  },

  duesSettled(pool, { driverId, orderId, paymentId, amount, rideCount }) {
    print('info', 'PAYMENT', `💰 Dues SETTLED | driver=${driverId} order=${orderId} amount=₹${amount} rides=${rideCount}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: `dues_${driverId}`, event: 'DUES_SETTLED',
      driver_id: driverId,
      razorpay_order_id: orderId, razorpay_payment_id: paymentId,
      amount, meta: JSON.stringify({ rideCount }),
    });
  },

  refund(pool, { rideId, passengerId, amount, reason }) {
    print('warn', 'PAYMENT', `↩️  Refund INITIATED | ride=${rideId} amount=₹${amount} reason=${reason}`);
    writeToDb(pool, 'payment_event_logs', {
      ride_id: rideId, event: 'REFUND_INITIATED',
      passenger_id: passengerId || null, amount,
      meta: JSON.stringify({ reason }),
    });
  },
};


// ═══════════════════════════════════════════════════════════════
// 🔌  SOCKET LOGGER  (console only — too high volume for DB)
// ═══════════════════════════════════════════════════════════════
const socketLogger = {
  connected(socketId, userId, role)    { print('info',  'SOCKET', `🟢 CONNECTED    | socket=${socketId} user=${userId} role=${role}`); },
  disconnected(socketId, userId, role) { print('info',  'SOCKET', `🔴 DISCONNECTED | socket=${socketId} user=${userId} role=${role}`); },
  event(socketId, event, data)         { print('debug', 'SOCKET', `📨 Event [${event}] | socket=${socketId}`, data); },
  error(socketId, event, err)          { print('error', 'SOCKET', `💥 Error in [${event}] | socket=${socketId} | ${err?.message}`, { stack: err?.stack }); },
  rideDispatched(rideId, driverCount)  { print('info',  'SOCKET', `📡 Ride DISPATCHED | ride=${rideId} notified_drivers=${driverCount}`); },
  noSocket(userId, role, event)        { print('warn',  'SOCKET', `👻 No socket for ${role} ${userId} — skipped [${event}]`); },
};


// ═══════════════════════════════════════════════════════════════
// 🔔  FCM LOGGER
// ═══════════════════════════════════════════════════════════════
const fcmLogger = {
  sent(userId, title, type) {
    print('info', 'FCM', `📬 Notification SENT | user=${userId} title="${title}" type=${type}`);
  },
  failed(userId, title, error) {
    print('error', 'FCM', `📵 Notification FAILED | user=${userId} title="${title}" error=${error?.message || error}`);
  },
  tokenMissing(userId) {
    print('warn', 'FCM', `🚫 FCM Token MISSING | user=${userId} — notification skipped`);
  },
  tokenUpdated(userId) {
    print('info', 'FCM', `🔑 FCM Token UPDATED | user=${userId}`);
  },
};


// ═══════════════════════════════════════════════════════════════
// 🌐  API LOGGER MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
// Usage in server.js:  app.use(apiLoggerMiddleware);
function apiLoggerMiddleware(req, res, next) {
  const start = Date.now();

  const originalEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms     = Date.now() - start;
    const status = res.statusCode;
    const level  = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const line   = `${req.method} ${req.originalUrl} → ${status} (${ms}ms)`;

    print(level, 'API', line);

    if (ms > SLOW_API_MS) {
      print('warn', 'SLOW_API', `⚠️  ${line} — exceeds ${SLOW_API_MS}ms threshold`);
    }
    return originalEnd(...args);
  };

  next();
}


// ═══════════════════════════════════════════════════════════════
// 🐢  SLOW QUERY TRACKER  (wraps pool.query)
// ═══════════════════════════════════════════════════════════════
// Usage in server.js:
// Slow query store — last 20 queries in memory
const slowQueryLog = [];
const MAX_SLOW_QUERIES = 20;

function addSlowQuery(entry) {
  slowQueryLog.unshift(entry); // latest first
  if (slowQueryLog.length > MAX_SLOW_QUERIES) slowQueryLog.pop();
}

// Export karo taaki monitoring route use kar sake
function getSlowQueries() {
  return [...slowQueryLog];
}

function wrapPoolWithLogger(pool) {
  const orig = pool.query.bind(pool);

  pool.query = async function (...args) {
    const t0 = Date.now();

    const queryText = typeof args[0] === 'string'
      ? args[0]
      : typeof args[0] === 'object' && args[0]?.text
        ? args[0].text
        : '?';

    try {
      const result = await orig(...args);
      const ms = Date.now() - t0;

      if (ms > SLOW_QUERY_MS) {
        const snippet = queryText.replace(/\s+/g, ' ').substring(0, 200);
        print('warn', 'SLOW_QUERY', `🐢 ${ms}ms | ${snippet}`);

        // ✅ Store karo — file aur line bhi capture karo
        const stack = new Error().stack || '';
        const callerLine = stack
          .split('\n')
          .find(l =>
            l.includes('.js') &&
            !l.includes('logger.js') &&
            !l.includes('node_modules')
          ) || '';

        addSlowQuery({
          ms,
          query:      snippet,
          caller:     callerLine.trim().replace(/.*at\s+/, ''),
          occurred_at: new Date().toISOString(),
        });
      }

      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      print('error', 'DB_ERROR', `💥 Query FAILED (${ms}ms): ${err.message}`, {
        query: queryText.substring(0, 200),
      });
      throw err;
    }
  };

  return pool;
}


// ═══════════════════════════════════════════════════════════════
// ⏰  CRON LOGGER
// ═══════════════════════════════════════════════════════════════
const cronLogger = {
  started(jobName)                { print('info',  'CRON', `▶️  Job STARTED  | ${jobName}`); },
  finished(jobName, ms)           { print('info',  'CRON', `✅ Job FINISHED | ${jobName} (${ms}ms)`); },
  skipped(jobName, reason)        { print('debug', 'CRON', `⏭️  Job SKIPPED  | ${jobName} reason=${reason}`); },
  error(jobName, err)             { print('error', 'CRON', `💥 Job FAILED   | ${jobName} | ${err?.message}`, { stack: err?.stack }); },
  processed(jobName, count, ms)   { print('info',  'CRON', `📋 ${jobName} | processed=${count} (${ms}ms)`); },
};


// ═══════════════════════════════════════════════════════════════
// ❤️   HEALTH CHECK HANDLER
// ═══════════════════════════════════════════════════════════════
// Usage:
//   app.get('/health',     logger.healthHandler);
//   app.get('/api/health', logger.healthHandler);
async function healthHandler(req, res) {
  const pool   = global.pool;
  const result = { status: 'ok', timestamp: new Date().toISOString() };

  // DB ping
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    result.db = { status: 'ok', ping_ms: Date.now() - t0 };
  } catch (e) {
    result.db     = { status: 'error', message: e.message };
    result.status = 'degraded';
  }

  // Memory
  const mem = process.memoryUsage();
  result.memory = {
    rss_mb:        (mem.rss        / 1024 / 1024).toFixed(1),
    heap_used_mb:  (mem.heapUsed   / 1024 / 1024).toFixed(1),
    heap_total_mb: (mem.heapTotal  / 1024 / 1024).toFixed(1),
  };

  // Uptime
  result.uptime_seconds = Math.floor(process.uptime());

  // Socket stats
  try {
    const initSocket      = require('../socket');
    const activeDrivers   = initSocket.getActiveDrivers?.() || {};
    const activePassengers= initSocket.getActivePassengers?.() || {};
    result.sockets = {
      active_drivers:    Object.keys(activeDrivers).length,
      active_passengers: Object.keys(activePassengers).length,
    };
  } catch (_) {}

  print('debug', 'HEALTH', `Health check | status=${result.status}`);
  return res.status(result.status === 'ok' ? 200 : 503).json(result);
}


// ═══════════════════════════════════════════════════════════════
// 📤  EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
  rideLogger,
  paymentLogger,
  socketLogger,
  fcmLogger,
  cronLogger,
  apiLoggerMiddleware,
  wrapPoolWithLogger,
  healthHandler,
  getSlowQueries,
  log: print, // raw print for custom one-off logs
};