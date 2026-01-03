const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto'); // For signature verification
const router = express.Router();

// Your existing Razorpay instance setup
const key_id = process.env.RZP_KEY_ID;
const key_secret = process.env.RZP_KEY_SECRET;
const rzp = new Razorpay({ key_id, key_secret });

// 1. Endpoint to get all unsettled liabilities for a driver
// In settlement.js
// ✅ REPLACE the entire router.get('/pending/:driverId', ...) with this version.
router.get('/pending/:driverId', async (req, res) => {
  const { driverId } = req.params;
  const pool = global.pool;

  try {
    // This query correctly joins ride_invoices to get the base fare.
    const { rows } = await pool.query(
      `SELECT
         wl.ride_external_id,
         wl.amount_paise,      -- This is the rounded commission in Rupees
         wl.due_date,
         ri.base_amount_paise,   -- This is the rounded base fare in Rupees
		 ri.rounded_rupees
       FROM wallet_ledger wl
       LEFT JOIN ride_invoices ri ON wl.ride_external_id = ri.ride_external_id
       WHERE wl.driver_id = $1
         AND wl.type = 'CASH_RECEIVED'
         AND wl.direction = 'DR'
         AND wl.is_settled = FALSE
       ORDER BY wl.created_at ASC`,
      [driverId]
    );

    // ✅ Calculate total due from the `amount_paise` column (which contains rupees)
	  const rawTotal = rows.reduce((sum, row) => sum + Number(row.amount_paise), 0);
    const totalDueInRupees = Math.floor(rawTotal);

    res.json({
      // ✅ Send the raw `rows` array. The frontend will know how to parse it.
      unsettled_rides: rows,
      total_due_rupees: totalDueInRupees,
      company_account_details: {
        bankName: 'Global Commercial Bank',
        accountNumber: '123456789012',
        ifscCode: 'GCBL0001234',
        beneficiaryName: 'LetsRide Technologies Pvt Ltd'
      }
    });
  } catch (e) {
    console.error('Error fetching pending dues:', e);
    res.status(500).json({ error: 'server_error' });
  }
});




router.post('/create-order', async (req, res) => {
  const { driverId, amount, ride_ids } = req.body;

  if (!driverId || !amount || amount <= 0 || !ride_ids || ride_ids.length === 0) {
    return res.status(400).json({ error: 'driverId, amount, and ride_ids are required.' });
  }

  try {
    const options = {
      amount: Math.round(amount * 100), // Razorpay requires paise
      currency: 'INR',
      receipt: `settlement-${driverId}-${Date.now()}`,
      notes: {
        // ✅ CRITICAL: Embed the ride_ids into the order notes.
        // We stringify the array to store it as a string.
        ride_ids_json: JSON.stringify(ride_ids),
        driverId: driverId // Also good to have driverId here
      }
    };

    const order = await rzp.orders.create(options);
    if (!order) {
      return res.status(500).json({ error: 'Razorpay order creation failed' });
    }

    res.json({ orderId: order.id, key_id: key_id }); // Assuming key_id is defined globally
  } catch (e) {
    console.error('Razorpay order creation failed:', e);
    res.status(500).json({ error: 'order_create_failed' });
  }
});




// ✅ REPLACE the existing '/verify-payment' route with this final, robust version.
router.post('/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const pool = global.pool;

  // --- Step 1: Signature Verification (No change here) ---
  try {
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto.createHmac('sha256', key_secret)
                                    .update(body.toString())
                                    .digest('hex');
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'signature_mismatch' });
    }
  } catch (e) {
    console.error("Signature verification error:", e);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }

  // --- Step 2: Signature is valid, now perform idempotent update ---
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the ride_ids and driverId from the Razorpay order's notes
    const orderDetails = await rzp.orders.fetch(razorpay_order_id);
    if (!orderDetails?.notes?.ride_ids_json) {
      throw new Error('No ride IDs found in Razorpay order notes.');
    }
    const driverId = orderDetails.notes.driverId;
    const rideIdsToSettle = JSON.parse(orderDetails.notes.ride_ids_json);

    if (!driverId || !rideIdsToSettle || rideIdsToSettle.length === 0) {
        throw new Error('Driver ID or Ride IDs are missing from order notes.');
    }

    // --- START: IDEMPOTENT & COMPLETE LEDGER LOGIC ---

    // 1. ✅ CRITICAL FIX: Get the details ONLY for rides that are NOT YET settled.
    // This is the check that prevents the duplicate key error.
    const duesResult = await client.query(
        `SELECT ride_external_id, amount_paise
         FROM wallet_ledger
         WHERE driver_id = $1
           AND is_settled = FALSE  -- Only fetch unsettled dues
           AND ride_external_id = ANY($2::text[])`,
        [driverId, rideIdsToSettle]
    );
    const duesToSettle = duesResult.rows;

    // 2. ✅ If there are no dues to settle, it means they were already paid. Exit gracefully.
    if (duesToSettle.length === 0) {
        await client.query('COMMIT'); // Commit to do nothing.
        return res.json({ ok: true, message: 'Rides already settled or not found.'});
    }

    // Extract the specific IDs that we are actually going to process now.
    const idsToProcess = duesToSettle.map(due => due.ride_external_id);

    // 3. Mark the selected rides as settled in the wallet_ledger.
    const updateResult = await client.query(
      `UPDATE wallet_ledger
       SET is_settled = TRUE,
           settlement_ref = $1,
           due_date = NOW()
       WHERE driver_id = $2 AND ride_external_id = ANY($3::text[])`,
      [razorpay_payment_id, driverId, idsToProcess]
    );

    // 4. Loop and insert one row PER settled ride into platform_ledger.
    for (const due of duesToSettle) {
        await client.query(
            `INSERT INTO platform_ledger
           (ride_external_id, type, direction, amount_paise, note)
         VALUES ($1, 'CASH_COMMISSION', 'CR', $2, $3)
         ON CONFLICT (ride_external_id, type) DO NOTHING`,
            [
                due.ride_external_id,     // The specific ride ID
                due.amount_paise,         // The specific commission for that ride
                `Driver cash settlement via ${razorpay_payment_id}`
            ]
        );
    }

    // --- END: IDEMPOTENT & COMPLETE LEDGER LOGIC ---

    await client.query('COMMIT');
    res.json({ ok: true, message: 'Dues settled successfully.', settled_count: updateResult.rowCount });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Settlement verification failed:', e);
    // Send a more specific error message if it's the unique constraint violation
    if (e.code === '23505') {
        return res.status(409).json({ error: 'conflict', message: 'This transaction is already being processed or has been completed.' });
    }
    res.status(500).json({ error: 'settlement_failed' });
  } finally {
    client.release();
  }
});




module.exports = router;
