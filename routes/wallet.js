// routes/wallet.js
const express = require('express');
const router = express.Router();

// Helper: format INR labels for responses
function rupeesLabel(n) {
  const intVal = Number(n) || 0;
  return `₹${intVal}`;
}

// GET /api/wallet/me?driverId=7
router.get('/me', async (req, res) => {
  const pool = global.pool;
  if (!pool) return res.status(500).json({ error: 'db_pool_not_ready' });

  try {
    const driverId = Number(req.query.driverId);
    if (!driverId) return res.status(400).json({ error: 'driverId_required' });

    const w = await pool.query(
      `SELECT balance_paise, hold_paise
         FROM driver_wallets
        WHERE driver_id = $1`,
      [driverId]
    );

    const balanceInr = Number(w.rows[0]?.balance_paise || 0);
    const holdInr = Number(w.rows[0]?.hold_paise || 0);

    const ledger = await pool.query(
      `SELECT id, ride_external_id, type, direction, amount_paise, note, created_at
         FROM wallet_ledger
        WHERE driver_id = $1
        ORDER BY id DESC
        LIMIT 30`,
      [driverId]
    );

    res.json({
      balance: balanceInr,
      balance_label: rupeesLabel(balanceInr),
      balance_paise_legacy: balanceInr * 100,
      hold: holdInr,
      hold_label: rupeesLabel(holdInr),
      ledger: ledger.rows.map(l => {
        const amountInr = Number(l.amount_paise || 0);
        return {
          id: l.id,
          ride_external_id: l.ride_external_id,
          type: l.type,
          direction: l.direction,
          amount: amountInr,
          amount_label: rupeesLabel(amountInr),
          amount_paise_legacy: amountInr * 100,
          note: l.note,
          created_at: l.created_at,
        };
      }),
    });
  } catch (e) {
    console.error('wallet/me error', e);
    res.status(500).json({ error: 'wallet_fetch_failed' });
  }
});

/**
 * POST /api/wallet/cash-report
 * Client sends amountPaise (paise). Server converts to whole-rupees and stores that.
 */
// POST /api/wallet/cash-report
router.post('/cash-report', async (req, res) => {
  try {
    const pool = global.pool;
    const driverId = Number(req.body.driverId);
    const txnRef = (req.body.txnRef || '').trim();
    // Client may provide paise (e.g., 11800). Convert to whole rupees.
    const amountPaiseIn = Number(req.body.amountPaise || 0);
    const amountInr = Math.round(amountPaiseIn / 100);
    if (!driverId || !amountInr || !txnRef) return res.status(400).json({ ok:false, error:'missing_fields' });

    const { rows } = await pool.query(`
      INSERT INTO cash_deposits (driver_id, amount_paise, txn_ref, status)
      VALUES ($1,$2,$3,'REPORTED')
      RETURNING id
    `, [driverId, amountInr, txnRef]);

    res.json({ ok:true, depositId: String(rows[0].id) });
  } catch (e) {
    console.error('cash-report error', e);
    res.status(500).json({ ok:false, error:'cash_report_failed' });
  }
});


/**
 * PATCH /api/wallet/cash-match
 * - driverId, txnRef, amountPaise in request
 * - Server compares amount (converted to rupees) against pending CASH_RECEIVED rows
 * - If equal, marks those rows as DEPOSITED (updates note) and inserts deposit/credit/platform ledger entries
 */
// PATCH /api/wallet/cash-match
router.patch('/cash-match', async (req, res) => {
  try {
    const pool = global.pool;
    const driverId = Number(req.body.driverId);
    const txnRef = (req.body.txnRef || '').trim();
    const amountPaiseIn = Number(req.body.amountPaise || 0);
    const amountInr = Math.round(amountPaiseIn / 100);
    if (!driverId || !amountInr || !txnRef) return res.status(400).json({ ok:false, error:'missing_fields' });

    // Sum pending liabilities for the driver (CASH_RECEIVED and ADJUSTMENT)
    const { rows } = await pool.query(`
      SELECT COALESCE(SUM(amount_paise),0) AS pending
      FROM wallet_ledger
      WHERE driver_id=$1
        AND type = ANY (ARRAY['CASH_RECEIVED','ADJUSTMENT'])
        AND (note IS NULL OR note NOT LIKE 'DEPOSITED%')
    `, [driverId]);
    const pending = Number(rows[0].pending || 0);

    // If they differ, return required pending amount
    if (pending !== amountInr) {
      return res.status(400).json({ ok:false, reason:'amount_mismatch', required: pending });
    }

    await pool.query('BEGIN');

    // mark deposit (store whole-rupees)
    await pool.query(
      `INSERT INTO wallet_ledger (driver_id, ride_external_id, type, direction, amount_paise, note)
       VALUES ($1,NULL,'CASH_DEPOSITED','CR',$2,$3)`,
      [driverId, amountInr, `DEPOSITED ${txnRef}`]
    );

    const driverShare = Math.round(amountInr * 0.97);
    const platformShare = amountInr - driverShare;

    await pool.query(
      `INSERT INTO wallet_ledger (driver_id, ride_external_id, type, direction, amount_paise, note)
       VALUES ($1,NULL,'CREDIT_ONLINE','CR',$2,'65% cash credited post deposit')`,
      [driverId, driverShare]
    );

    await pool.query(
      `INSERT INTO platform_ledger (ride_external_id, type, direction, amount_paise, note)
       VALUES (NULL,'CASH_COMMISSION','CR',$1,'35% company share after cash deposit')`,
      [platformShare]
    );

    await pool.query(
      `UPDATE driver_wallets SET balance_paise = balance_paise + $2 WHERE driver_id=$1`,
      [driverId, driverShare]
    );

    await pool.query('COMMIT');
    res.json({ ok:true, credited_inr:driverShare, platform_inr:platformShare });

  } catch (e) {
    try { await pool.query('ROLLBACK'); } catch(e){}
    console.error('cash-match error', e);
    res.status(500).json({ ok:false, error:'cash_match_failed' });
  }
});


module.exports = router;
