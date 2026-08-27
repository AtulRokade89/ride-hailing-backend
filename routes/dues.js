// // In D:/rideapp/backend/routes/dues.js
// const express = require('express');
// const Razorpay = require('razorpay');
// const crypto = require('crypto');
// const router = express.Router();

 // const key_id = process.env.RZP_KEY_ID;
 // const key_secret = process.env.RZP_KEY_SECRET;
 // const rzp = new Razorpay({ key_id, key_secret });

// // const rzp = new Razorpay({
  // // key_id: process.env.RZP_KEY_ID,       // ✅ FIX: Use the 'RZP_' prefix
  // // key_secret: process.env.RZP_KEY_SECRET, // ✅ FIX: Use the 'RZP_' prefix
// // });

// // Creates a Razorpay order, now storing the ride IDs in the notes.
// router.post('/create-order', async (req, res) => {
  // try {
    // // ✅ FIX #1: Extract 'userId' from the request body.
    // const { amount, receipt, dueRideIds, userId } = req.body;

    // // You can also add a check for userId here for safety
    // if (!amount || !receipt || !dueRideIds || !Array.isArray(dueRideIds) || dueRideIds.length === 0 || !userId) {
      // console.error('[DUES] create-order missing required fields:', req.body);
      // return res.status(400).json({ error: 'missing_required_fields' });
    // }

    // const order = await rzp.orders.create({
      // amount,
      // currency: 'INR',
      // receipt,
      // notes: {
        // transaction_type: 'CASH_COMMISSION', // More accurate type
        // dueRideIds: dueRideIds.join(','),
        
        // // ✅ FIX #2: Add the extracted 'userId' to the notes object.
        // userId: userId,
      // },
    // });

    // console.log(`[DUES] Created Razorpay Order: ${order.id} for Driver: ${userId}`);
    
    // // Make sure to send back the key_id from process.env, not a loose variable
    // res.json({ orderId: order.id, key_id: process.env.RZP_KEY_ID });

  // } catch (e) {
    // console.error('[DUES] create-order error:', e);
    // res.status(500).json({ error: 'dues_order_create_failed' });
  // }
// });

// // Verifies the payment and now uses the specific ride IDs to update the ledger.
// // In D:/rideapp/backend/routes/dues.js
// // REPLACE your entire '/verify-payment' route with this one.

// router.post('/verify-payment', async (req, res) => {
  // const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  // const secret = process.env.RZP_KEY_SECRET;

  // try {
    // console.log(`[DUES] Starting verification for order: ${razorpay_order_id}`);

    // // Step 1: Verify the Razorpay signature to ensure the request is authentic
    // const shasum = crypto.createHmac('sha256', secret);
    // shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    // const digest = shasum.digest('hex');

    // if (digest !== razorpay_signature) {
      // console.error('[DUES] Signature mismatch!');
      // return res.status(400).json({ error: 'invalid_signature' });
    // }

    // console.log('[DUES] Signature verified successfully.');

    // // Step 2: CRITICAL - Fetch the order from Razorpay to get the notes
    // const order = await rzp.orders.fetch(razorpay_order_id);
    // if (!order) {
      // console.error(`[DUES] Could not fetch order ${razorpay_order_id} from Razorpay.`);
      // return res.status(500).json({ error: 'razorpay_order_fetch_failed' });
    // }

    // console.log('[DUES] Fetched order from Razorpay. Notes:', order.notes);

    // // Step 3: Extract data from the notes
    // const userId = order.notes.userId;
    // const dueRideIdsString = order.notes.dueRideIds;

    // if (!userId || !dueRideIdsString) {
      // console.error('[DUES] CRITICAL ERROR: userId or dueRideIds missing from order notes.');
      // return res.status(500).json({ error: 'data_missing_in_notes' });
    // }

    // const dueRideIds = dueRideIdsString.split(',');
    // const amountPaidPaise = order.amount; // The true amount from the source

    // console.log(`[DUES] Processing payment for Driver ID: ${userId} for rides: ${dueRideIds.join(', ')}`);

    // // Step 4: Start database transaction
    // await pool.query('BEGIN');
    // console.log('[DUES] Database transaction started.');

    // // Update wallet_ledger for all settled rides
    // const updateWalletQuery = await pool.query(
      // `UPDATE wallet_ledger
       // SET is_settled = TRUE, note = $1
       // WHERE driver_id = $2
         // AND type = 'CASH_RECEIVED'
         // AND is_settled = FALSE
         // AND ride_external_id = ANY($3::text[])`,
      // [`Settled via Txn: ${razorpay_payment_id}`, userId, dueRideIds]
    // );
    // console.log(`[DUES] Updated ${updateWalletQuery.rowCount} rows in wallet_ledger.`);

    // // Unblock the driver
    // await pool.query(
      // `UPDATE drivers SET is_blocked = FALSE WHERE user_id = $1`,
      // [userId]
    // );
    // console.log(`[DUES] Unblocked driver ${userId}.`);

    // // Insert records into platform_ledger
  // console.log(`[DUES] Inserting into platform_ledger. Amount: ${amountPaidPaise}, Rides: ${dueRideIds.join(',')}`);

// await pool.query(
  // `INSERT INTO platform_ledger (ride_external_id, type, direction, amount_paise, note)
   // VALUES ($1, 'CASH_COMMISSION', 'CR', $2, $3)`,
  // [
    // // FIX #1: Join the ride IDs into a single comma-separated string for the single column
    // dueRideIds.join(','),
    // // FIX #2: Insert the FULL payment amount, not the divided amount
    // amountPaidPaise/100,
    // // Use the clear note with the payment ID
    // `Online settlement via Txn: ${razorpay_payment_id}`
  // ]
// );

// console.log(`[DUES] Inserted 1 row into platform_ledger.`);
    // console.log(`[DUES] Inserted ${dueRideIds.length} rows into platform_ledger.`);

    // // Step 5: Commit the transaction
    // await pool.query('COMMIT');
    // console.log('[DUES] Database transaction committed.');

    // res.json({ ok: true });

  // } catch (e) {
    // if (pool) {
      // try {
        // await pool.query('ROLLBACK');
        // console.error('[DUES] Database transaction rolled back.');
      // } catch (rollbackError) {
        // console.error('[DUES] Rollback failed:', rollbackError);
      // }
    // }
    // console.error('[DUES] FINAL verify-payment error:', e);
    // res.status(500).json({ ok: false, error: 'dues_verification_failed' });
  // }
// });


// module.exports = router;


// routes/dues.js — WITH LOGGER INTEGRATED
const express  = require('express');
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const router   = express.Router();

const key_id     = process.env.RZP_KEY_ID;
const key_secret = process.env.RZP_KEY_SECRET;
const rzp        = new Razorpay({ key_id, key_secret });

const { paymentLogger } = require('../services/logger'); // ✅ NEW

// POST /api/dues/create-order
router.post('/create-order', async (req, res) => {
  const pool = global.pool;
  try {
    const { amount, receipt, dueRideIds, userId } = req.body;

    if (!amount || !receipt || !dueRideIds || !Array.isArray(dueRideIds) || dueRideIds.length === 0 || !userId) {
      console.error('[DUES] create-order missing required fields:', req.body);
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const order = await rzp.orders.create({
      amount,
      currency: 'INR',
      receipt,
      notes: {
        transaction_type: 'CASH_COMMISSION',
        dueRideIds: dueRideIds.join(','),
        userId,
      },
    });

    console.log(`[DUES] Created Razorpay Order: ${order.id} for Driver: ${userId}`);

    // ✅ LOG: Dues order created
    paymentLogger.orderCreated(pool, {
      rideId:    `dues_batch_${userId}`,
      driverId:  userId,
      orderId:   order.id,
      amount:    amount / 100,
      type:      'DUES',
    });

    res.json({ orderId: order.id, key_id: process.env.RZP_KEY_ID });

  } catch (e) {
    console.error('[DUES] create-order error:', e);

    // ✅ LOG: Dues order failed
    paymentLogger.failed(global.pool, {
      rideId:    `dues_${req.body?.userId}`,
      orderId:   null,
      reason:    e.message,
      errorCode: 'DUES_ORDER_CREATE_FAILED',
    });

    res.status(500).json({ error: 'dues_order_create_failed' });
  }
});

// POST /api/dues/verify-payment
router.post('/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const secret = process.env.RZP_KEY_SECRET;
  const pool   = global.pool;

  try {
    console.log(`[DUES] Starting verification for order: ${razorpay_order_id}`);

    // 1. Signature verify
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      console.error('[DUES] Signature mismatch!');
      paymentLogger.failed(pool, {
        rideId:    null,
        orderId:   razorpay_order_id,
        reason:    'signature_mismatch',
        errorCode: 'INVALID_SIGNATURE',
      });
      return res.status(400).json({ error: 'invalid_signature' });
    }

    // 2. Fetch order from Razorpay
    const order = await rzp.orders.fetch(razorpay_order_id);
    if (!order) {
      return res.status(500).json({ error: 'razorpay_order_fetch_failed' });
    }

    const userId          = order.notes.userId;
    const dueRideIdsString = order.notes.dueRideIds;

    if (!userId || !dueRideIdsString) {
      return res.status(500).json({ error: 'data_missing_in_notes' });
    }

    const dueRideIds    = dueRideIdsString.split(',');
    const amountPaidPaise = order.amount;

    console.log(`[DUES] Processing payment for Driver ID: ${userId} for rides: ${dueRideIds.join(', ')}`);

    await pool.query('BEGIN');

    const updateWalletQuery = await pool.query(
      `UPDATE wallet_ledger
       SET is_settled = TRUE, note = $1
       WHERE driver_id = $2
         AND type = 'CASH_RECEIVED'
         AND is_settled = FALSE
         AND ride_external_id = ANY($3::text[])`,
      [`Settled via Txn: ${razorpay_payment_id}`, userId, dueRideIds]
    );

    await pool.query(
      `UPDATE drivers SET is_blocked = FALSE WHERE user_id = $1`, [userId]
    );

    await pool.query(
      `INSERT INTO platform_ledger (ride_external_id, type, direction, amount_paise, note)
       VALUES ($1, 'CASH_COMMISSION', 'CR', $2, $3)`,
      [dueRideIds.join(','), amountPaidPaise / 100, `Online settlement via Txn: ${razorpay_payment_id}`]
    );

    await pool.query('COMMIT');

    // ✅ LOG: Dues settled
    paymentLogger.duesSettled(pool, {
      driverId:  userId,
      orderId:   razorpay_order_id,
      paymentId: razorpay_payment_id,
      amount:    amountPaidPaise / 100,
      rideCount: dueRideIds.length,
    });

    res.json({ ok: true });

  } catch (e) {
    if (pool) {
      try { await pool.query('ROLLBACK'); } catch (rb) { console.error('[DUES] Rollback failed:', rb); }
    }

    // ✅ LOG: Dues verification failed
    paymentLogger.failed(pool, {
      rideId:    null,
      orderId:   razorpay_order_id,
      reason:    e.message,
      errorCode: 'DUES_VERIFY_FAILED',
    });

    console.error('[DUES] FINAL verify-payment error:', e);
    res.status(500).json({ ok: false, error: 'dues_verification_failed' });
  }
});

module.exports = router;
