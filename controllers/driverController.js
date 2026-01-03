// In controllers/driverController.js
// const { Pool } = require('pg');

// const pool = new Pool({
    // user: process.env.DB_USER,
    // host: process.env.DB_HOST,
    // database: process.env.DB_NAME,
    // password: process.env.DB_PASSWORD,
    // port: process.env.DB_PORT,
// });

const pool = global.pool;

// ✅ FINAL, COMPLETE VERSION
const unblockAfterPayment = async (req, res) => {
  const { driverId } = req.body;

  if (!driverId) {
    return res.status(400).json({ error: 'Driver ID is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Start transaction

    // --- NEW: Step 1: Find all unsettled cash dues for this driver ---
    // We need to know what to insert into the platform_ledger.
    const duesResult = await client.query(
        `SELECT ride_external_id, amount_paise
         FROM wallet_ledger
         WHERE driver_id = $1
           AND is_settled = FALSE
           AND type = 'DEBIT_CASH_COLLECTED'`,
        [driverId]
    );
    const duesToSettle = duesResult.rows;

    if (duesToSettle.length > 0) {
        // --- NEW: Step 2: For each unsettled due, credit the platform_ledger ---
        console.log(`[Unblock] Found ${duesToSettle.length} unsettled dues to record in platform_ledger for driver ${driverId}.`);
        const paymentReference = `online_payment_${Date.now()}`; // A unique reference for this batch

        for (const due of duesToSettle) {
            await client.query(
                `INSERT INTO platform_ledger
                   (ride_external_id, type, direction, amount_paise, note)
                 VALUES ($1, 'CASH_COMMISSION', 'CR', $2, $3)
                 ON CONFLICT (ride_external_id, type) DO NOTHING`, // This prevents errors if a record somehow already exists
                [
                    due.ride_external_id,
                    due.amount_paise,
                    `Driver cash settlement via ${paymentReference}`
                ]
            );
        }

        // --- Step 3: Mark all pending cash dues as settled in the wallet_ledger ---
        console.log(`[Unblock] Settling all pending cash dues in wallet_ledger for driver ${driverId}`);
        const unsettledRideIds = duesToSettle.map(due => due.ride_external_id);
        await client.query(
          `UPDATE wallet_ledger
           SET is_settled = TRUE, note = $1
           WHERE driver_id = $2 AND ride_external_id = ANY($3::text[])`,
          [`Settled via ${paymentReference}`, driverId, unsettledRideIds]
        );
    } else {
        console.log(`[Unblock] No pending cash dues found for driver ${driverId}. Only unblocking.`);
    }

    // --- Step 4: Unblock the driver in the 'drivers' table ---
    console.log(`[Unblock] Unblocking driver ID: ${driverId}`);
    const updateDriverQuery = `UPDATE drivers SET is_blocked = FALSE WHERE user_id = $1;`;
    const driverUpdateResult = await client.query(updateDriverQuery, [driverId]);

    if (driverUpdateResult.rowCount === 0) {
      throw new Error(`Driver with user_id ${driverId} not found in drivers table.`);
    }

    await client.query('COMMIT'); // All steps successful, commit transaction
    res.status(200).json({ success: true, message: 'Driver unblocked and all cash dues settled.' });

  } catch (error) {
    await client.query('ROLLBACK'); // Something failed, undo all changes
    console.error(`[Unblock] Error during reactivation for driver ${driverId}:`, error);
    res.status(500).json({ error: 'Server error during account reactivation.' });
  } finally {
    client.release(); // ALWAYS release the client
  }
};

module.exports = {
  unblockAfterPayment,
};
