//adminDashboard.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

/**
 * Ride summary (pie chart)
 */
router.get('/dashboard/rides-summary', async (req, res) => {
  try {
    const { from, to } = req.query;

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,

        COUNT(*) FILTER (
          WHERE status = 'CANCELLED'
          AND cancelled_by = 'PASSENGER'
        ) AS cancelled_passenger,

        COUNT(*) FILTER (
          WHERE status = 'CANCELLED'
          AND cancelled_by = 'DRIVER'
        ) AS cancelled_driver,

        COUNT(*) FILTER (
          WHERE status = 'PENDING'
        ) AS rejected_driver
      FROM rides
      WHERE requested_at BETWEEN $1 AND $2
    `, [from, to]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Dashboard summary error');
  }
});


/**
 * Route deviation alerts
 */
router.get('/dashboard/deviations', async (req, res) => {
  try {
    const { from, to } = req.query;

    const result = await pool.query(`
      SELECT
        s.ride_external_id,
        r.driver_id,
        s.deviation_count,
        s.passenger_decision,
        s.driver_ignored,
        s.hard_event_raised,
        s.last_event_at
      FROM ride_safety_state s
      JOIN rides r ON r.external_id = s.ride_external_id
      WHERE
        DATE(s.last_event_at) BETWEEN $1 AND $2
        AND (
          s.passenger_decision = 'DISAGREE'
          OR s.hard_event_raised = true
        )
      ORDER BY s.last_event_at DESC
    `, [from, to]);

    res.json(result.rows);
  } catch (err) {
    console.error("Deviation fetch error", err);
    res.status(500).json({ error: "Deviation fetch error" });
  }
});


/**
 * Live map data
 */
router.get('/dashboard/live-map', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (ride_external_id)
        ride_external_id,
        latitude,
        longitude,
        recorded_at
      FROM ride_route_snapshots
      ORDER BY ride_external_id, recorded_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Live map error');
  }
});

/**
 * Top stat cards
 */
router.get("/dashboard/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_rides,

        COUNT(*) FILTER (
          WHERE status = 'IN_TRANSIT'
        ) AS active_rides,

        COUNT(DISTINCT driver_id) FILTER (
          WHERE status = 'IN_TRANSIT'
          AND driver_id IS NOT NULL
        ) AS active_drivers,

        COALESCE(
          SUM(COALESCE(final_fare, 0)) FILTER (
            WHERE status = 'COMPLETED'
          ),
          0
        ) AS revenue_today
      FROM rides
      WHERE DATE(requested_at) = CURRENT_DATE
    `);

    const row = result.rows[0];

    res.json({
      totalRides: Number(row.total_rides || 0),
      activeDrivers: Number(row.active_drivers || 0),
      revenueToday: Number(row.revenue_today || 0),
      surgeZones: 0,
      ridesChart: [],
      revenueChart: [],
    });
  } catch (err) {
    console.error("❌ dashboard stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Live alerts summary
 */
router.get("/dashboard/alerts", async (req, res) => {
  try {
    const hardDeviations = await pool.query(`
      SELECT COUNT(*) FROM ride_safety_state
      WHERE hard_event_raised = true
        AND DATE(last_event_at) = CURRENT_DATE
    `);

    const softDeviations = await pool.query(`
      SELECT COUNT(*) FROM ride_safety_state
      WHERE passenger_decision = 'DISAGREE'
        AND hard_event_raised = false
        AND DATE(last_event_at) = CURRENT_DATE
    `);

    const paymentOnlineCompleted = await pool.query(`
      SELECT COUNT(*) FROM rides
      WHERE payment_status = 'PAID_ONLINE'
        AND DATE(completed_at) = CURRENT_DATE
    `);

    res.json({
      hardDeviations: Number(hardDeviations.rows[0].count),
      softDeviations: Number(softDeviations.rows[0].count),
      paymentOnlineCompleted: Number(paymentOnlineCompleted.rows[0].count),
      apiStatus: "OK",
      dbStatus: "OK",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      apiStatus: "DOWN",
      dbStatus: "DOWN",
    });
  }
});
//Top 5 Drivers Today
router.get("/top-drivers-today", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        u.name,
        u.phone_number,
        COUNT(*) AS total_rides
      FROM rides r
      JOIN users u ON r.driver_id = u.id
      WHERE 
        u.role = 'driver'
        AND r.status = 'COMPLETED'
        AND DATE(r.completed_at) = CURRENT_DATE
      GROUP BY u.id, u.name, u.phone_number
      ORDER BY total_rides DESC
      LIMIT 5
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch top drivers" });
  }
});

//Top 5 Drivers Today
router.get("/best-day", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        DATE(r.completed_at) AS ride_date,
        COUNT(*) AS total_rides,
        ROUND(SUM(i.base_amount_paise * 0.03), 0) AS company_profit
      FROM rides r
      JOIN ride_invoices i ON i.ride_external_id = r.external_id
      WHERE r.status = 'COMPLETED'
      GROUP BY ride_date
      ORDER BY total_rides DESC, company_profit DESC
      LIMIT 1
    `);

    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch best day" });
  }
});

//Star Driver of Current Month (₹25k+ company profit)
router.get("/star-driver", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        u.name,
        COUNT(*) AS total_rides,
        ROUND(SUM(i.base_amount_paise * 0.03), 0) AS company_profit
      FROM rides r
      JOIN users u ON r.driver_id = u.id
      JOIN ride_invoices i ON i.ride_external_id = r.external_id
      WHERE 
        u.role = 'driver'
        AND r.status = 'COMPLETED'
        AND DATE_TRUNC('month', r.completed_at) = DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY u.id, u.name
      HAVING ROUND(SUM(i.base_amount_paise * 0.03), 0) >= 25000
      ORDER BY company_profit DESC
      LIMIT 1
    `);

    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch star driver" });
  }
});

router.put('/referral-subsidy/:rideId/mark-paid', async (req, res) => {
  const { rideId } = req.params;
  try {
    const result = await pool.query(
      `UPDATE platform_ledger 
       SET is_settled = TRUE, settled_at = NOW() 
       WHERE ride_external_id = $1 AND type = 'REFERRAL_SUBSIDY'
       RETURNING id`,
      [rideId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Referral subsidy not found for this ride." });
    }

    res.json({ success: true, message: 'Referral payment marked as settled' });
  } catch (e) {
    console.error("Error marking referral as paid:", e.message);
    res.status(500).json({ error: e.message });
  }
});

//dispute logic
router.post('/dispute/resolve', async (req, res) => {
  const pool = global.pool;
  const { disputeId, decision, finalAmount, adminNotes } = req.body;
 
  // ── Validate ──────────────────────────────────────────────────────────────
  if (!disputeId || !decision) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (!['driver', 'passenger', 'custom'].includes(decision)) {
    return res.status(400).json({ error: 'invalid_decision' });
  }
  if (decision === 'custom' && (!finalAmount || Number(finalAmount) <= 0)) {
    return res.status(400).json({
      error  : 'missing_final_amount',
      message: 'finalAmount is required when decision is custom',
    });
  }
 
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
 
    // ── 1. Fetch dispute ──────────────────────────────────────────────────
    const { rows: disputeRows } = await client.query(
      `SELECT * FROM ride_disputes WHERE id = $1 FOR UPDATE`,
      [disputeId]
    );
    if (disputeRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'dispute_not_found' });
    }
 
    const dispute = disputeRows[0];
 
    if (dispute.status !== 'PENDING_ADMIN_REVIEW') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error  : 'dispute_not_pending',
        status : dispute.status,
        message: 'Only PENDING_ADMIN_REVIEW disputes can be resolved here.',
      });
    }
 
    // ── 2. Fetch ride details from correct table ───────────────────────────
    let ride = null;
 
    if (dispute.ride_type === 'SCHEDULED') {
      const { rows } = await client.query(
        `SELECT
            sr.external_id,
            sr.passenger_id,
            sr.driver_id,
            sr.vehicle_type,
            sr.estimated_fare,
            'CASH' AS payment_mode
         FROM scheduled_rides sr
         WHERE sr.external_id = $1`,
        [dispute.ride_external_id]
      );
      ride = rows[0];
    } else {
      const { rows } = await client.query(
        `SELECT
            r.external_id,
            r.passenger_id,
            r.driver_id,
            r.vehicle_type,
            r.estimated_fare,
            COALESCE(r.payment_mode, 'CASH') AS payment_mode
         FROM rides r
         WHERE r.external_id = $1`,
        [dispute.ride_external_id]
      );
      ride = rows[0];
    }
 
    if (!ride) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ride_not_found' });
    }
 
    // ── 3. Decide final fare ──────────────────────────────────────────────
    // driver   → partial_fare (system calculated)
    // passenger→ 0 (no charge)
    // custom   → admin provided amount
    const resolvedFare =
      decision === 'driver'    ? Number(dispute.partial_fare) :
      decision === 'passenger' ? 0                            :
      Number(finalAmount);
 
    // ── 4. Update dispute → ADMIN_RESOLVED ───────────────────────────────
    await client.query(
      `UPDATE ride_disputes
       SET status      = 'ADMIN_RESOLVED',
           final_fare  = $1,
           resolved_at = NOW(),
           resolved_by = 'admin',
           admin_notes = $2
       WHERE id = $3`,
      [resolvedFare, adminNotes || null, disputeId]
    );
 
    // ── 5. Update ride → PARTIAL_COMPLETE ─────────────────────────────────
    const rideTable = dispute.ride_type === 'SCHEDULED' ? 'scheduled_rides' : 'rides';
    await client.query(
      `UPDATE ${rideTable}
       SET status     = 'PARTIAL_COMPLETE',
           final_fare = $1
       WHERE external_id = $2`,
      [resolvedFare, dispute.ride_external_id]
    );
 
    // ── 6. Passenger sahi tha → nothing to charge, just close ─────────────
    if (decision === 'passenger' || resolvedFare === 0) {
      await client.query('COMMIT');
 
      // Notify both
      await _notifyBothParties(ride, disputeId, dispute.ride_external_id, {
        resolution : 'ADMIN_RESOLVED',
        decidedFor : 'passenger',
        finalFare  : 0,
        message    : 'Admin reviewed your dispute. No charge applied.',
      });
 
      return res.json({
        ok        : true,
        resolution: 'ADMIN_RESOLVED',
        decidedFor: 'passenger',
        finalFare : 0,
        message   : 'Dispute resolved. Passenger was right. No charge applied.',
      });
    }
 
    // ── 7. Driver sahi tha → credit driver, add pending for passenger ──────
 
    // 7a. Driver wallet credit (97% of resolved fare)
    // Using ADJUSTMENT type since this is a dispute settlement, not normal ride
    const driverShare   = Math.round(resolvedFare * 0.97);
    const platformShare = resolvedFare - driverShare; // 3%
 
    await client.query(
      `INSERT INTO wallet_ledger
         (driver_id, ride_external_id, type, direction, amount_paise, note)
       VALUES ($1, $2, 'ADJUSTMENT', 'CR', $3, $4)
       ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
      [
        ride.driver_id,
        dispute.ride_external_id,
        driverShare,
        `Dispute settlement credit — admin resolved (dispute #${disputeId})`,
      ]
    );
 
    // 7b. Driver wallet balance update
    await client.query(
      `INSERT INTO driver_wallets (driver_id, balance_paise)
       VALUES ($1, $2)
       ON CONFLICT (driver_id)
       DO UPDATE SET
         balance_paise = driver_wallets.balance_paise + EXCLUDED.balance_paise,
         updated_at    = NOW()`,
      [ride.driver_id, driverShare]
    );
 
    // 7c. Platform ledger — 3% commission
    await client.query(
      `INSERT INTO platform_ledger
         (ride_external_id, type, direction, amount_paise, note)
       VALUES ($1, 'ONLINE_COMMISSION', 'CR', $2, $3)
       ON CONFLICT (ride_external_id, type) DO NOTHING`,
      [
        dispute.ride_external_id,
        platformShare,
        `Dispute settlement commission (dispute #${disputeId})`,
      ]
    );
 
    // 7d. Passenger pending payment entry
    // Cash ride  → passenger owes cash (collect next ride)
    // Online ride → same — no Razorpay was triggered yet, so treat same as cash
    //               (fresh Razorpay order is a separate optional step)
    await client.query(
      `INSERT INTO pending_payments
         (user_id, ride_id, driver_id, amount, status, source_type)
       VALUES (
         $1,
         (SELECT id FROM rides WHERE external_id = $2 LIMIT 1),
         $3,
         $4,
         'PENDING',
         'DISPUTE_RECOVERY'
       )`,
      [
        ride.passenger_id,
        dispute.ride_external_id,
        ride.driver_id,
        resolvedFare,
      ]
    );
 
    await client.query('COMMIT');
 
    // ── 8. Notify both parties ────────────────────────────────────────────
    await _notifyBothParties(ride, disputeId, dispute.ride_external_id, {
      resolution : 'ADMIN_RESOLVED',
      decidedFor : 'driver',
      finalFare  : resolvedFare,
      message    : `Admin reviewed your dispute. Final fare ₹${resolvedFare} has been decided.`,
    });
 
    return res.json({
      ok            : true,
      resolution    : 'ADMIN_RESOLVED',
      decidedFor    : decision,
      finalFare     : resolvedFare,
      driverCredit  : driverShare,
      platformShare : platformShare,
      message       : `Dispute resolved. Driver credited ₹${driverShare}. Passenger owes ₹${resolvedFare} (pending_payments entry created).`,
    });
 
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error resolving dispute:', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  } finally {
    client.release();
  }
});
 
 
// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Notify driver + passenger via socket + push
// (Internal function — not an endpoint)
// ─────────────────────────────────────────────────────────────────────────────
async function _notifyBothParties(ride, disputeId, rideExternalId, payload) {
  // Socket
  try {
    const initSocketServer = require('../socket');
    const io               = initSocketServer.getIo();
    const activeDrivers    = initSocketServer.getActiveDrivers();
 
    const dSock = activeDrivers[String(ride.driver_id)]?.socketId;
    if (dSock) io.to(dSock).emit('disputeResolved', { disputeId, rideExternalId, ...payload });
    io.to(`passenger:${ride.passenger_id}`).emit('disputeResolved', { disputeId, rideExternalId, ...payload });
  } catch (se) {
    console.error('❌ Socket notify failed (resolve):', se.message);
  }
 
  // Push notifications
  try {
    const { sendNotificationToUser } = require('../services/notification_sender');
 
    await sendNotificationToUser(
      ride.driver_id,
      'Dispute Resolved',
      payload.decidedFor === 'driver'
        ? `Admin reviewed your dispute. ₹${payload.finalFare} credited to your wallet.`
        : 'Admin reviewed your dispute. No charge was applied this time.',
      { type: 'DISPUTE_RESOLVED', rideId: rideExternalId, disputeId: String(disputeId) }
    );
 
    await sendNotificationToUser(
      ride.passenger_id,
      'Dispute Resolved',
      payload.decidedFor === 'driver'
        ? `Admin reviewed your dispute. ₹${payload.finalFare} is due for your incomplete ride.`
        : 'Admin reviewed your dispute. No charge has been applied.',
      { type: 'DISPUTE_RESOLVED', rideId: rideExternalId, disputeId: String(disputeId) }
    );
  } catch (ne) {
    console.error('❌ Push notification failed (resolve):', ne.message);
  }
}

module.exports = router;
