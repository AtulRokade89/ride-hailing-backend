const express = require('express');
const router = express.Router();

router.get('/drivers', async (_req, res) => {
  try {
    const { rows } = await global.pool.query(`
      SELECT 
        d.user_id AS id,
        u.name,
        u.phone_number,
        CASE WHEN d.is_blocked THEN 'Offline' ELSE 'Active' END AS status,
        COALESCE(r.total_rides, 0) AS rides
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN (
        SELECT driver_id, COUNT(*) AS total_rides
        FROM rides
        GROUP BY driver_id
      ) r ON r.driver_id = d.user_id
      ORDER BY u.name
    `);

    res.json(rows);
  } catch (e) {
    console.error('Admin driver list error:', e);
    res.status(500).json({ message: 'Failed to load drivers' });
  }
});



router.get('/drivers/:driverId/wallet', async (req, res) => {
  const { driverId } = req.params;
  const client = await pool.connect();

  try {
    // 1️⃣ Wallet summary
    const summaryResult = await client.query(
      `SELECT
  d.user_id AS driver_id,
  u.name,
  u.phone_number,

  -- Earnings
  COALESCE(SUM(
    CASE
      WHEN wl.type = 'CREDIT_ONLINE' AND wl.direction = 'CR'
      THEN wl.amount_paise ELSE 0
    END
  ), 0) AS online_credited,

  -- Platform commission
  COALESCE(SUM(
    CASE
      WHEN wl.type = 'PLATFORM_COMMISSION' AND wl.direction = 'DR'
      THEN wl.amount_paise ELSE 0
    END
  ), 0) AS platform_commission,

  -- Admin adjustments
  COALESCE(SUM(
    CASE
      WHEN wl.type = 'ADJUSTMENT'
      THEN CASE
        WHEN wl.direction = 'CR' THEN wl.amount_paise
        ELSE -wl.amount_paise
      END
      ELSE 0
    END
  ), 0) AS admin_adjustments,

  -- Final wallet balance
  COALESCE(dw.balance_paise, 0) AS wallet_balance,
--gst colelction
  COALESCE(SUM(
  CASE
    WHEN wl.type = 'GST_COLLECTED' AND wl.direction = 'DR'
    THEN wl.amount_paise ELSE 0
  END
), 0) AS gst_collected

FROM drivers d
JOIN users u ON u.id = d.user_id
LEFT JOIN wallet_ledger wl ON wl.driver_id = d.user_id
LEFT JOIN driver_wallets dw ON dw.driver_id = d.user_id
WHERE d.user_id =  $1
GROUP BY d.user_id, u.name, u.phone_number, dw.balance_paise;`,
      [driverId]
    );

    if (!summaryResult.rows.length) {
      return res.status(404).json({ message: 'Driver not found' });
    }

    const summaryRow = summaryResult.rows[0];

    // 2️⃣ Ledger
    const ledgerResult = await client.query(
      `SELECT
  id,
  ride_external_id,
  type,
  direction,
  amount_paise,
  note,
  created_at
FROM wallet_ledger
WHERE driver_id = $1
ORDER BY created_at DESC;`,
      [driverId]
    );

    res.json({
      driver: {
        id: summaryRow.driver_id,
        name: summaryRow.name,
        phone: summaryRow.phone_number
      },
      summary: {
        online_credited: Number(summaryRow.online_credited),
        platform_commission: Number(summaryRow.platform_commission),
        gst_collected: Number(summaryRow.gst_collected),
        admin_adjustments: Number(summaryRow.admin_adjustments),
        wallet_balance: Number(summaryRow.wallet_balance)
      },
      ledger: ledgerResult.rows.map(r => ({
        id: r.id,
        ride_external_id: r.ride_external_id,
        type: r.type,
        direction: r.direction,
        amount: Number(r.amount_paise),
        note: r.note,
        created_at: r.created_at
      }))
    });

  } catch (err) {
    console.error('Wallet API error:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
});


module.exports = router;
