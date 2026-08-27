//driverSettlement.service.js

const pool = require('../db');

/**
 * 🔹 Pending settlements
 * Fixed: includes REFERRAL_BONUS, returns rupees, adds phone + breakdown columns
 */
exports.getPendingSettlements = async () => {
  const { rows } = await pool.query(`
    SELECT
      w.driver_id,
      u.name,
      u.phone_number,
      -- Online earnings breakdown
      COALESCE(SUM(w.amount_paise) FILTER (
        WHERE w.type = 'CREDIT_ONLINE'
      ), 0)  AS online_earnings_rupees,
      -- Referral bonus breakdown
      COALESCE(SUM(w.amount_paise) FILTER (
        WHERE w.type = 'REFERRAL_BONUS'
      ), 0)  AS referral_bonus_rupees,
	  COALESCE(SUM(w.amount_paise) FILTER (
  WHERE w.type = 'WAITING_CREDIT'
), 0) AS waiting_charges_rupees,
      -- Grand total to pay driver
      COALESCE(SUM(w.amount_paise), 0) AS need_pay_driver_rupees,
      d.bank_name,
      d.bank_account_number,
      d.ifsc_code
    FROM wallet_ledger w
    JOIN users u ON w.driver_id = u.id
    JOIN driver_verifications d ON d.user_id = w.driver_id
    WHERE
      w.direction = 'CR'
      AND w.type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
      AND w.is_settled = false
      AND u.role = 'driver'
    GROUP BY
      w.driver_id,
      u.name,
      u.phone_number,
      d.bank_name,
      d.bank_account_number,
      d.ifsc_code
    HAVING COALESCE(SUM(w.amount_paise), 0) > 0
    ORDER BY need_pay_driver_rupees DESC
  `);

  return rows;
};

/**
 * 🔹 Mark settlement as paid (manual UTR)
 * Fixed: settles BOTH CREDIT_ONLINE and REFERRAL_BONUS entries
 */
exports.markSettlementPaid = async (driverId, utr) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Calculate total unsettled amount (both types)
    const { rows } = await client.query(`
      SELECT SUM(amount_paise)::bigint AS total
      FROM wallet_ledger
      WHERE driver_id = $1
        AND is_settled = false
        AND direction = 'CR'
        AND type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
    `, [driverId]);

    const total = Number(rows[0]?.total || 0);
    if (total <= 0) throw new Error('No unpaid amount found for this driver');

    // Settle both CREDIT_ONLINE and REFERRAL_BONUS together
    await client.query(`
      UPDATE wallet_ledger
      SET
        is_settled = true,
        settlement_ref = $2,
        settled_at = NOW()
      WHERE driver_id = $1
        AND is_settled = false
        AND direction = 'CR'
        AND type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
    `, [driverId, utr]);

    await client.query('COMMIT');
    return { driverId, total, utr };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * 🔹 Settlement history (date range)
 * Fixed: adds phone_number, converts paise→rupees correctly
 */
exports.getSettlementHistory = async (fromDate, toDate) => {
  const { rows } = await pool.query(`
    SELECT
      u.name AS driver_name,
      u.phone_number,
      SUM(w.amount_paise)::numeric AS amount_rupees,
      w.settlement_ref AS utr,
      MAX(w.settled_at) AS settled_at
    FROM wallet_ledger w
    JOIN users u ON u.id = w.driver_id
    WHERE
      w.is_settled = true
      AND w.settled_at IS NOT NULL
      AND w.direction = 'CR'
      AND w.type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
      AND (
        ($1::date IS NULL AND w.settled_at::date >= CURRENT_DATE)
        OR ($1::date IS NOT NULL AND w.settled_at::date >= $1)
      )
      AND ($2::date IS NULL OR w.settled_at::date <= $2)
    GROUP BY u.name, u.phone_number, w.settlement_ref
    ORDER BY settled_at DESC
  `, [fromDate || null, toDate || null]);

  return rows;
};

/**
 * 🔹 Weekly settlement summary
 * Fixed: adds driver_count, week_end, converts paise→rupees
 */
exports.getWeeklySettlementSummary = async () => {
  const { rows } = await pool.query(`
    SELECT
      DATE_TRUNC('week', settled_at)                          AS week_start,
      DATE_TRUNC('week', settled_at) + INTERVAL '6 days'     AS week_end,
      SUM(amount_paise)::numeric                      AS total_paid_rupees,
      COUNT(DISTINCT driver_id)                               AS driver_count
    FROM wallet_ledger
    WHERE
      is_settled = true
      AND settled_at IS NOT NULL
      AND direction = 'CR'
      AND type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
    GROUP BY DATE_TRUNC('week', settled_at)
    ORDER BY week_start DESC
  `);

  return rows;
};

/**
 * 🔹 Export settlement history for CSV
 * Fixed: converts paise→rupees, includes phone_number
 */
exports.getSettlementHistoryForExport = async (fromDate, toDate) => {
  const { rows } = await pool.query(`
    SELECT
      u.name        AS driver_name,
      u.phone_number,
      SUM(w.amount_paise)::numeric  AS amount_rupees,
      w.settlement_ref                       AS utr,
      MAX(w.settled_at)                      AS settled_at
    FROM wallet_ledger w
    JOIN users u ON u.id = w.driver_id
    WHERE
      w.is_settled = true
      AND w.settled_at IS NOT NULL
      AND w.direction = 'CR'
      AND w.type IN ('CREDIT_ONLINE', 'REFERRAL_BONUS', 'WAITING_CREDIT')
      AND ($1::date IS NULL OR w.settled_at >= $1)
      AND ($2::date IS NULL OR w.settled_at <= $2)
    GROUP BY u.name, u.phone_number, w.settlement_ref
    ORDER BY settled_at DESC
  `, [fromDate || null, toDate || null]);

  return rows;
};