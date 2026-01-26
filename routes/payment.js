


// // routes/payment.js
// const express = require('express');
// const Razorpay = require('razorpay');
// const crypto = require('crypto');

// const router = express.Router();

// // Use the pool created in server.js
// // REMOVED: const pool = global.pool;

// // Razorpay keys from .env
// const key_id     = process.env.RZP_KEY_ID;
// const key_secret = process.env.RZP_KEY_SECRET;

// // Razorpay client
// const rzp = new Razorpay({ key_id, key_secret });

// // Health
// router.get('/ping', (_req, res) => res.json({ up: true }));

// /**
 // * POST /api/payment/create-order
 // * Body: { amount, currency, rideId }
 // * - amount MUST be in **paise** for Razorpay (e.g., ₹190.00 => 19000)
 // */
// router.post('/create-order', async (req, res) => {
  // try {
    // const { amount, currency = 'INR', rideId } = req.body;
    // if (!rideId) return res.status(400).json({ error: 'missing_rideId' });
    // if (!amount || amount < 1) return res.status(400).json({ error: 'invalid_amount' });

    // const order = await rzp.orders.create({
      // amount,            // paise (Razorpay requirement)
      // currency,
      // receipt: `ride_${rideId}`,
      // notes: { rideId }
    // });

    // // Return test key for Checkout
    // res.json({ orderId: order.id, key_id });
  // } catch (e) {
    // const detail = (e && e.error && (e.error.description || e.error.reason)) ||
                   // e.message || String(e);
    // console.error('create-order error:', detail);
    // res.status(500).json({ error: 'order_create_failed', detail });
  // }
// });

// /**
 // * POST /api/payment/verify
 // * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, rideId }
 // * - Verifies signature
 // * - Splits fare 65/35 **in INR**, rounded to nearest rupee
 // * - Writes rounded INR to wallet & ledgers
 // */
// router.post('/verify', async (req, res) => {
  // try {
    // const { razorpay_order_id, razorpay_payment_id, razorpay_signature, rideId } = req.body;
    
    // // Use global.pool inside the handler where it is guaranteed to be set
    // const pool = global.pool;
    // if (!pool) throw new Error('DB pool not initialized.');

    // // 0) Verify Razorpay signature
    // const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    // const expected = crypto.createHmac('sha256', key_secret).update(body).digest('hex');
    // if (expected !== razorpay_signature) {
      // return res.status(400).json({ ok: false, reason: 'signature_mismatch' });
    // }

    // // 1) Fetch ride -> driver + fare (INR)
    // const r1 = await pool.query(
      // `SELECT driver_id, COALESCE(final_fare, estimated_fare) AS fare
         // FROM rides
        // WHERE external_id = $1
        // LIMIT 1`,
      // [rideId]
    // );
    // if (!r1.rows.length) {
      // return res.status(404).json({ ok: false, reason: 'ride_not_found' });
    // }

    // const driverId = Number(r1.rows[0].driver_id);
    // const fareInr  = Number(r1.rows[0].fare || 0); // INR, e.g., 190.00

    // // 2) Split 65 / 35 in **INR**, then round to nearest rupee
    // const driverShareRoundedInr   = Math.round(fareInr * 0.65); // e.g., 123.5 => 124
    // const platformShareRoundedInr = Math.round(fareInr * 0.35); // e.g., 66.5  => 67

    // await pool.query('BEGIN');

    // // 3) Mark ride paid (only columns you actually have)
    // await pool.query(
      // `UPDATE rides
          // SET payment_status = 'PAID_ONLINE',
              // payment_txn_id = $1
        // WHERE external_id = $2`,
      // [razorpay_payment_id, rideId]
    // );

    // // 4) Driver ledger (idempotent) + wallet upsert
    // // IMPORTANT: amount_paise column now stores **whole INR** (historical name kept).
    // await pool.query(
      // `INSERT INTO wallet_ledger
         // (driver_id, ride_external_id, type, direction, amount_paise, note)
       // VALUES ($1,$2,'CREDIT_ONLINE','CR',$3,'Online payment settled; 65% credited')
       // ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
      // [driverId, rideId, driverShareRoundedInr]
    // );

    // await pool.query(
      // `INSERT INTO driver_wallets (driver_id, balance_paise)
       // VALUES ($1, $2)
       // ON CONFLICT (driver_id)
       // DO UPDATE SET balance_paise = driver_wallets.balance_paise + EXCLUDED.balance_paise,
                     // updated_at = now()`,
      // [driverId, driverShareRoundedInr]
    // );

    // // 5) Platform 35% revenue (idempotent)
    // await pool.query(
      // `INSERT INTO platform_ledger
         // (ride_external_id, type, direction, amount_paise, note)
       // VALUES ($1,'ONLINE_COMMISSION','CR',$2,'35% platform commission (online)')
       // ON CONFLICT (ride_external_id, type) DO NOTHING`,
      // [rideId, platformShareRoundedInr]
    // );

    // await pool.query('COMMIT');
    // res.json({ ok: true });
  // } catch (e) {
    // try { 
      // // Safely access global.pool for rollback
      // if (global.pool) await global.pool.query('ROLLBACK'); 
    // } catch {}
    // console.error('verify error', e);
    // res.status(500).json({ ok: false });
  // }
// });

// module.exports = router;


// routes/payment.js
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const router = express.Router();

// Razorpay keys from .env
const key_id     = process.env.RZP_KEY_ID;
const key_secret = process.env.RZP_KEY_SECRET;

// Razorpay client
const rzp = new Razorpay({ key_id, key_secret });

// Small helper: half-up int rounding (consistent with your invoices)
function roundHalfUpToInt(value) {
  const n = Number(value) || 0;
  const f = Math.floor(n);
  return (n - f) >= 0.5 ? f + 1 : f;
}

// Health
router.get('/ping', (_req, res) => res.json({ up: true }));

/**
 * POST /api/payment/create-order
 * Body: { amount, currency, rideId }
 * - amount MUST be in **paise** for Razorpay (e.g., ₹190.00 => 19000)
 */
router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', rideId } = req.body;
    if (!rideId) return res.status(400).json({ error: 'missing_rideId' });
    if (!amount || amount < 1) return res.status(400).json({ error: 'invalid_amount' });

    const order = await rzp.orders.create({
      amount,            // paise (Razorpay requirement)
      currency,
      receipt: `ride_${rideId}`,
      notes: { rideId }
    });

    // Return test key for Checkout
    res.json({ orderId: order.id, key_id });
  } catch (e) {
    const detail = (e && e.error && (e.error.description || e.error.reason)) ||
                   e.message || String(e);
    console.error('create-order error:', detail);
    res.status(500).json({ error: 'order_create_failed', detail });
  }
});

/**
 * POST /api/payment/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, rideId }
 * - Verifies signature
 * - Splits **on BASE (pre-GST)** at 65/35 in whole INR
 * - Writes rounded INR to wallet & ledgers (keeps your existing flow)
 */
// router.post('/verify', async (req, res) => {
	
	  // console.log("📌 VERIFY DEBUG:", {
  // body: req.body,
  // expectedBody: `${req.body.razorpay_order_id}|${req.body.razorpay_payment_id}`,
  // computedSignature: crypto.createHmac('sha256', key_secret).update(`${req.body.razorpay_order_id}|${req.body.razorpay_payment_id}`).digest('hex'),
// });
  // try {
    // const { razorpay_order_id, razorpay_payment_id, razorpay_signature, rideId,driverId } = req.body;

    // // Use global.pool inside the handler where it is guaranteed to be set
    // const pool = global.pool;
    // if (!pool) throw new Error('DB pool not initialized.');

    // // 0) Verify Razorpay signature
    // const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    // const expected = crypto.createHmac('sha256', key_secret).update(body).digest('hex');
    // if (expected !== razorpay_signature) {
      // return res.status(400).json({ ok: false, reason: 'signature_mismatch' });
    // }

    // // 1) Fetch ride -> driver + fare (INR). fare may be total incl. GST.
    // const r1 = await pool.query(
      // `SELECT driver_id, COALESCE(final_fare, estimated_fare) AS fare, status, payment_status
   // FROM rides
   // WHERE external_id = $1
     // AND driver_id = $2
     // AND status IN ('IN_TRANSIT','COMPLETED')
     // AND (payment_status IS NULL OR payment_status != 'PAID_ONLINE')
   // LIMIT 1
// `,
      // [rideId,driverId]
    // );
	// if (r1.rows.length === 0) {
  // console.error('❌ Payment verify failed: ride not found or invalid state', {
    // rideId
  // });

  // return res.status(400).json({
    // ok: false,
    // reason: 'ride_not_eligible',
    // message: 'Ride not found, driver not assigned, or invalid status'
  // });
// }

	
	// const rideRow = r1.rows[0];
// if (!['IN_TRANSIT', 'COMPLETED'].includes(rideRow.status)) {
  // return res.status(400).json({
    // ok: false,
    // reason: 'invalid_ride_state',
    // message: 'Ride not eligible for payment'
  // });
// }


// const rawDriverId = rideRow.driver_id;


// if (!rawDriverId || Number(rawDriverId) <= 0) {
  // console.error('❌ Payment verify failed: invalid driver_id', {
    // rideId,
    // driver_id: rawDriverId
  // });

  // return res.status(400).json({
    // ok: false,
    // reason: 'invalid_driver',
    // message: 'Driver not assigned to this ride yet'
  // });
// }

// const driverId = Number(rawDriverId);

	
   // const fareInr = Number(rideRow.fare || 0); // total in INR (if that’s what you store)

    // // 2) Get the invoice BASE (pre-GST) in whole INR from ride_invoices
    // //    Your schema stores whole INR in *_paise columns by design.
    // let baseInr = null;
    // try {
      // const inv = await pool.query(
        // `SELECT base_amount_paise
           // FROM ride_invoices
          // WHERE ride_external_id = $1
          // LIMIT 1`,
        // [rideId]
      // );
      // if (inv.rows.length) {
        // baseInr = Number(inv.rows[0].base_amount_paise || 0);
      // }
    // } catch (e) {
      // console.warn('payment.verify: invoice lookup failed, will fallback to invert GST', e.message);
    // }

    // // Fallback if invoice doesn’t exist yet: invert 5% GST and round half-up
    // if (!baseInr || baseInr <= 0) {
      // baseInr = roundHalfUpToInt((Number.isFinite(fareInr) ? fareInr : 0) / 1.05);
    // }

    // // 3) Split 65/35 **on base only** (whole INR)
    // const driverShareRoundedInr = Math.round(baseInr * 0.65);
    // const platformShareRoundedInr = baseInr - driverShareRoundedInr; // complement prevents rounding drift

    // await pool.query('BEGIN');

    // // 4) Mark ride paid (only columns you actually have)
    // await pool.query(
      // `UPDATE rides
          // SET payment_status = 'PAID_ONLINE',
              // payment_txn_id = $1
        // WHERE external_id = $2`,
      // [razorpay_payment_id, rideId]
    // );

    // // 5) Driver ledger (idempotent) + wallet upsert
    // // NOTE: amount_paise columns store whole INR in your schema.
    // await pool.query(
      // `INSERT INTO wallet_ledger
         // (driver_id, ride_external_id, type, direction, amount_paise, note)
       // VALUES ($1,$2,'CREDIT_ONLINE','CR',$3,'Online payment: 65% of BASE credited')
       // ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
      // [driverId, rideId, driverShareRoundedInr]
    // );

    // await pool.query(
      // `INSERT INTO driver_wallets (driver_id, balance_paise)
       // VALUES ($1, $2)
       // ON CONFLICT (driver_id)
       // DO UPDATE SET balance_paise = driver_wallets.balance_paise + EXCLUDED.balance_paise,
                     // updated_at = now()`,
      // [driverId, driverShareRoundedInr]
    // );

    // // 6) Platform 35% of base (idempotent)
    // await pool.query(
      // `INSERT INTO platform_ledger
         // (ride_external_id, type, direction, amount_paise, note)
       // VALUES ($1,'ONLINE_COMMISSION','CR',$2,'Online: 35% of BASE commission')
       // ON CONFLICT (ride_external_id, type) DO NOTHING`,
      // [rideId, platformShareRoundedInr]
    // );

    // await pool.query('COMMIT');

    // // Optional: include debug figures so you can verify quickly
    // res.json({
      // ok: true,
      // split_basis: 'BASE_INR',
      // base_inr: baseInr,
      // computed_from: (baseInr && baseInr > 0) ? 'invoice' : 'fallback_invert_gst',
      // driver_share_inr: driverShareRoundedInr,
      // platform_share_inr: platformShareRoundedInr
    // });
  // } catch (e) {
    // try {
      // if (global.pool) await global.pool.query('ROLLBACK');
    // } catch {}
    // console.error('verify error', e);
    // res.status(500).json({ ok: false, error: 'verify_failed' });
  // }
  
  // console.log('[PAYMENT VERIFY]', {
  // rideId,
  // rideStatus: ride.status,
  // paymentStatus: ride.payment_status,
  // driverId,
// });

  // });
  
 router.post('/verify', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      rideId,
      driverId
    } = req.body;

    const pool = global.pool;
    if (!pool) throw new Error('DB pool not initialized');

    /* 1️⃣ Verify Razorpay signature */
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac('sha256', key_secret)
      .update(body)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({
        ok: false,
        reason: 'signature_mismatch'
      });
    }

    /* 2️⃣ Fetch ride (ALLOW ACCEPTED ALSO) */
    const rideRes = await pool.query(
      `
    SELECT
  driver_id,
  COALESCE(final_fare, estimated_fare) AS fare,
  status,
  payment_status
FROM rides
WHERE external_id = $1
  AND status IN ('ACCEPTED','IN_TRANSIT','COMPLETED')
  AND COALESCE(payment_status,'') != 'PAID_ONLINE'
  AND (driver_id IS NULL OR driver_id = $2)
LIMIT 1
      `,
      [rideId, driverId]
    );

    if (rideRes.rows.length === 0) {
      console.error('❌ Payment verify failed: ride not eligible', {
        rideId,
        driverId
      });

      return res.status(400).json({
        ok: false,
        reason: 'ride_not_eligible',
        message: 'Ride not found, already paid, or invalid state'
      });
    }

    const ride = rideRes.rows[0];
    const fareInr = Number(ride.fare || 0);

    /* 3️⃣ Fetch base fare from invoice (if exists) */
    let baseInr = null;
    const inv = await pool.query(
      `SELECT base_amount_paise FROM ride_invoices WHERE ride_external_id=$1 LIMIT 1`,
      [rideId]
    );

    if (inv.rows.length) {
      baseInr = Number(inv.rows[0].base_amount_paise);
    }

    if (!baseInr || baseInr <= 0) {
      baseInr = Math.round(fareInr / 1.05);
    }

    /* 4️⃣ Split 65/35 */
    const driverShare = Math.round(baseInr * 0.65);
    const platformShare = baseInr - driverShare;

    await pool.query('BEGIN');

    /* 5️⃣ Mark ride paid */
    await pool.query(
      `
      UPDATE rides
      SET payment_status='PAID_ONLINE',
          payment_txn_id=$1
      WHERE external_id=$2
      `,
      [razorpay_payment_id, rideId]
    );

    /* 6️⃣ Driver wallet credit (idempotent) */
    await pool.query(
      `
      INSERT INTO wallet_ledger
        (driver_id, ride_external_id, type, direction, amount_paise, note)
      VALUES
        ($1,$2,'CREDIT_ONLINE','CR',$3,'Online ride earning')
      ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING
      `,
      [driverId, rideId, driverShare]
    );

    await pool.query(
      `
      INSERT INTO driver_wallets (driver_id, balance_paise)
      VALUES ($1,$2)
      ON CONFLICT (driver_id)
      DO UPDATE SET
        balance_paise = driver_wallets.balance_paise + EXCLUDED.balance_paise,
        updated_at = NOW()
      `,
      [driverId, driverShare]
    );

    /* 7️⃣ Platform ledger */
    await pool.query(
      `
      INSERT INTO platform_ledger
        (ride_external_id, type, direction, amount_paise, note)
      VALUES
        ($1,'ONLINE_COMMISSION','CR',$2,'Online commission')
      ON CONFLICT (ride_external_id, type) DO NOTHING
      `,
      [rideId, platformShare]
    );

    await pool.query('COMMIT');

    return res.json({
      ok: true,
      base_inr: baseInr,
      driver_share_inr: driverShare,
      platform_share_inr: platformShare
    });

  } catch (e) {
    try { await global.pool.query('ROLLBACK'); } catch {}
    console.error('verify error', e);
    res.status(500).json({ ok:false, error:'verify_failed' });
  }
});




router.post('/create-upi-order', async (req, res) => {
  try {
    const { orderId, amountPaise, payeeUpi, payeeName = 'Merchant', note } = req.body;

    if (!orderId) return res.status(400).json({ error: 'missing_orderId' });
    if (!amountPaise || Number(amountPaise) <= 0)
      return res.status(400).json({ error: 'invalid_amountPaise' });
    if (!payeeUpi) return res.status(400).json({ error: 'missing_payeeUpi' });

    // Convert paise → rupees (for display & UPI link)
    const amountRu = (Number(amountPaise) / 100).toFixed(2);

    // Build canonical UPI URI (percent-encoded)
    const pa = encodeURIComponent(String(payeeUpi));
    const pn = encodeURIComponent(String(payeeName));
    const am = encodeURIComponent(String(amountRu));
    const tn = encodeURIComponent(String(note || `Ride ${orderId}`));
    const upi_uri = `upi://pay?pa=${pa}&pn=${pn}&am=${am}&tn=${tn}&cu=INR`;

    //console.log('[UPI] created', { orderId, amountPaise, amountRu, payeeUpi, payeeName, upi_uri });

    // Respond with both rupees + paise for clarity
    return res.json({
      upi_uri,
      orderId,
      amountPaise,
      amountRupees: amountRu
    });

  } catch (err) {
    console.error('create-upi-order error:', err);
    return res.status(500).json({ error: 'create_upi_order_failed' });
  }
});


module.exports = router;

