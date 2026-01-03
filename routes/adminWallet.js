const express = require("express");
const router = express.Router();

router.post("/wallet/adjust", async (req, res) => {
  const pool = global.pool;
  if (!pool) return res.status(500).json({ error: "db_pool_not_ready" });

  const { driverId, amount, direction, note } = req.body;

  if (!driverId || !amount || !direction || !note) {
    return res.status(400).json({ error: "missing_fields" });
  }

  try {
    await pool.query("BEGIN");

    await pool.query(
      `INSERT INTO wallet_ledger
       (driver_id, ride_external_id, type, direction, amount_paise, note)
       VALUES ($1, NULL, 'ADJUSTMENT', $2, $3, $4)`,
      [driverId, direction, amount, `ADMIN: ${note}`]
    );

    // Update wallet balance
    const sign = direction === "CR" ? 1 : -1;
    await pool.query(
      `UPDATE driver_wallets
       SET balance_paise = balance_paise + $2
       WHERE driver_id = $1`,
      [driverId, sign * amount]
    );

    await pool.query("COMMIT");
    res.json({ ok: true });

  } catch (e) {
    await pool.query("ROLLBACK");
    console.error("admin wallet adjust error", e);
    res.status(500).json({ error: "adjust_failed" });
  }
});


module.exports = router;
