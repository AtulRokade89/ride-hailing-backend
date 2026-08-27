// routes/monitoring.js
// Add in server.js:  app.use('/api/admin/monitoring', require('./routes/monitoring'));

const express = require('express');
const router  = express.Router();

// ── GET /api/admin/monitoring/summary ─────────────────────
// Top stat cards — ride events + payment events
router.get('/summary', async (req, res) => {
  const pool = global.pool;
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'CREATED'  AND created_at >= NOW() - INTERVAL '24h') AS rides_created_24h,
        COUNT(*) FILTER (WHERE event = 'COMPLETED' AND created_at >= NOW() - INTERVAL '24h') AS rides_completed_24h,
        COUNT(*) FILTER (WHERE event = 'CANCELLED' AND created_at >= NOW() - INTERVAL '24h') AS rides_cancelled_24h,
        COUNT(*) FILTER (WHERE event = 'NO_DRIVER_FOUND' AND created_at >= NOW() - INTERVAL '24h') AS no_driver_24h,
        COUNT(*) FILTER (WHERE event = 'ROUTE_DEVIATION' AND created_at >= NOW() - INTERVAL '24h') AS deviations_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24h') AS total_events_24h
      FROM ride_event_logs
    `);

    const pay = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'PAYMENT_SUCCESS'  AND created_at >= NOW() - INTERVAL '24h') AS payments_success,
        COUNT(*) FILTER (WHERE event = 'PAYMENT_FAILED'   AND created_at >= NOW() - INTERVAL '24h') AS payments_failed,
        COUNT(*) FILTER (WHERE event = 'ORDER_CREATED'    AND created_at >= NOW() - INTERVAL '24h') AS orders_created,
        COUNT(*) FILTER (WHERE event = 'DUES_SETTLED'     AND created_at >= NOW() - INTERVAL '24h') AS dues_settled,
        COALESCE(SUM(amount) FILTER (WHERE event = 'PAYMENT_SUCCESS' AND created_at >= NOW() - INTERVAL '24h'), 0) AS revenue_24h
      FROM payment_event_logs
    `);

    res.json({ ...rows[0], ...pay.rows[0] });
  } catch (e) {
    console.error('[MONITORING] summary error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


// ── GET /api/admin/monitoring/ride-events ──────────────────
// Recent ride events with filter
router.get('/ride-events', async (req, res) => {
  const pool  = global.pool;
  const { event, limit = 50 } = req.query;

  try {
    const where = event ? `WHERE event = $1` : '';
    const params = event ? [event, parseInt(limit)] : [parseInt(limit)];
    const paramIdx = event ? '$2' : '$1';

    const { rows } = await pool.query(`
      SELECT id, ride_id, event, ride_type, driver_id, passenger_id,
             vehicle_type, estimated_fare, final_fare, distance_km,
             payment_mode, meta, created_at
      FROM ride_event_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${paramIdx}
    `, params);

    res.json(rows);
  } catch (e) {
    console.error('[MONITORING] ride-events error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


// ── GET /api/admin/monitoring/payment-events ───────────────
router.get('/payment-events', async (req, res) => {
  const pool  = global.pool;
  const { event, limit = 50 } = req.query;

  try {
    const where = event ? `WHERE event = $1` : '';
    const params = event ? [event, parseInt(limit)] : [parseInt(limit)];
    const paramIdx = event ? '$2' : '$1';

    const { rows } = await pool.query(`
      SELECT id, ride_id, event, payment_type, passenger_id, driver_id,
             razorpay_order_id, razorpay_payment_id, amount, payment_mode,
             meta, created_at
      FROM payment_event_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${paramIdx}
    `, params);

    res.json(rows);
  } catch (e) {
    console.error('[MONITORING] payment-events error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});


// ── GET /api/admin/monitoring/issues ──────────────────────
// Errors + warnings only — for Issues tab
router.get('/issues', async (req, res) => {
  const pool = global.pool;
  try {
    const rides = await pool.query(`
      SELECT id, ride_id, event, driver_id, passenger_id, vehicle_type, meta, created_at,
             'ride' AS source
      FROM ride_event_logs
      WHERE event IN ('CANCELLED','NO_DRIVER_FOUND','ROUTE_DEVIATION')
      ORDER BY created_at DESC
      LIMIT 30
    `);

    const payments = await pool.query(`
      SELECT id, ride_id, event, passenger_id, driver_id,
             razorpay_order_id, meta, created_at,
             'payment' AS source
      FROM payment_event_logs
      WHERE event IN ('PAYMENT_FAILED','REFUND_INITIATED')
      ORDER BY created_at DESC
      LIMIT 30
    `);

    const combined = [...rides.rows, ...payments.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 50);

    res.json(combined);
  } catch (e) {
    console.error('[MONITORING] issues error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/admin/monitoring/slow-queries ────────────────
// From ride_logs + payment_logs meta field
router.get('/health', async (req, res) => {
  const pool = global.pool;
  try {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const dbPing = Date.now() - t0;

    const mem = process.memoryUsage();

    let activeDrivers = 0, activePassengers = 0;
    try {
      const initSocket = require('../socket');
      activeDrivers    = Object.keys(initSocket.getActiveDrivers?.()    || {}).length;
      activePassengers = Object.keys(initSocket.getActivePassengers?.() || {}).length;
    } catch (_) {}

    res.json({
      status:            dbPing < 3000 ? 'ok' : 'degraded', // ← 200ms → 3000ms
      db_ping_ms:        dbPing,
      uptime_seconds:    Math.floor(process.uptime()),
      heap_used_mb:      (mem.heapUsed  / 1024 / 1024).toFixed(1),
      heap_total_mb:     (mem.heapTotal / 1024 / 1024).toFixed(1),
      rss_mb:            (mem.rss       / 1024 / 1024).toFixed(1),
      active_drivers:    activeDrivers,
      active_passengers: activePassengers,
    });
  } catch (e) {
    res.status(500).json({ error: 'health_check_failed' });
  }
});


// ── GET /api/admin/monitoring/fcm-stats ───────────────────
// Table: fcm_tokens, Column: fcm_token
router.get('/fcm-stats', async (req, res) => {
	
  const pool = global.pool;
    console.log('FCM ROUTE FILE VERSION: fcm_tokens table');
  
  try {
	     const test = await pool.query(`SELECT COUNT(*) FROM public.fcm_tokens`);
    console.log('FCM TABLE COUNT:', test.rows[0]);
	
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE fcm_token IS NOT NULL AND fcm_token != '') AS with_token,
        COUNT(*) FILTER (WHERE fcm_token IS NULL OR fcm_token = '')       AS missing_token,
        COUNT(*) AS total_registered
      FROM public.fcm_tokens
    `);

    const usersRes = await pool.query(`SELECT COUNT(*) AS total FROM users`);

    res.json({
      with_token:       parseInt(rows[0].with_token),
      missing_token:    parseInt(rows[0].missing_token),
      total_registered: parseInt(rows[0].total_registered),
      total_users:      parseInt(usersRes.rows[0].total),
    });

  } catch (e) {
    console.error('[MONITORING] fcm-stats error:', e);
    res.status(500).json({ error: 'server_error', detail: e.message });
  }
});



  

// ── GET /api/admin/monitoring/ride-funnel ─────────────────
router.get('/ride-funnel', async (req, res) => {
  const pool = global.pool;
  const { hours = 24 } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT event, COUNT(*) AS count
      FROM ride_event_logs
      WHERE created_at >= NOW() - INTERVAL '${parseInt(hours)} hours'
      GROUP BY event
      ORDER BY count DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('[MONITORING] ride-funnel error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── GET /api/admin/monitoring/slow-queries ─────────────────
router.get('/slow-queries', (req, res) => {
  try {
    const { getSlowQueries } = require('../services/logger');
    res.json(getSlowQueries());
  } catch (e) {
    console.error('[MONITORING] slow-queries error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/admin/monitoring/client-error
router.post('/client-error', async (req, res) => {
  const pool = global.pool;
  try {
    const {
      errorType,    // 'API_ERROR' | 'SOCKET_ERROR' | 'SCREEN_CRASH'
      message,      // error message
      stackTrace,   // dart stack trace — exact file + line
      screenName,   // 'MapScreen' | 'MyBookingsScreen' etc
      userId,
      role,         // 'passenger' | 'driver'
      rideId,
      extra,        // any extra context
    } = req.body;

    await pool.query(
  `INSERT INTO client_error_logs
   (error_type, message, stack_trace, screen_name, 
    user_id, role, ride_id, extra, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())`,
  [
    errorType,
    message,
    stackTrace?.substring(0, 1000) || null,
    screenName || null,
    userId || null,
    role || null,
    rideId || null,
    extra ? JSON.stringify(extra) : null,
  ]
);

    res.json({ ok: true });
  } catch (e) {
    console.error('[MONITORING] client-error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/admin/monitoring/client-errors
router.get('/client-errors', async (req, res) => {
  const pool = global.pool;

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);

  try {
    const { rows } = await pool.query(
      `
      SELECT id, error_type, message, stack_trace,
             screen_name, user_id, role, ride_id, extra,
             resolved, resolved_at, created_at
      FROM client_error_logs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
         OR (
           resolved = false
           AND error_type IN (
             'PAYMENT_FAILED',
             'API_ERROR',
             'SCREEN_CRASH',
             'SOCKET_ERROR'
           )
         )
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json(rows);
  } catch (e) {
    console.error('[monitoring/client-errors]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.patch('/client-errors/:id/resolve', async (req, res) => {
  const pool = global.pool;

  try {
    const { rows } = await pool.query(
      `
      UPDATE client_error_logs
      SET resolved = true,
          resolved_at = NOW()
      WHERE id = $1
      RETURNING id, resolved, resolved_at
      `,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found' });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error('[monitoring/client-errors/resolve]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;