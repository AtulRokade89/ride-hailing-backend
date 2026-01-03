// // routes/ride.js
// const express = require('express');
// const router = express.Router();

// const {
  // computeGstPaise,
  // isGstApplicable,
  // roundedRupeesFromPaise
// } = require('../utils/tax');

// // === Base fare calculator (keep in sync with your client estimates) ===
// function computeBaseFareINR(vehicleType, distanceKm) {
  // const vt = String(vehicleType || '').toUpperCase();

  // // Mirrors your MapScreen defaults (AUTO removed per your current file)
  // const base =
    // vt === 'BIKE'  ? 20 :
    // vt === 'MINI'  ? 40 :
    // // vt === 'AUTO'  ? 30 :
    // vt === 'SEDAN' ? 70 :
    // vt === 'SUV'   ? 100 : 40;

  // const perKm =
    // vt === 'BIKE'  ? 6  :
    // vt === 'MINI'  ? 10 :
    // // vt === 'AUTO'  ? 8  :
    // vt === 'SEDAN' ? 15 :
    // vt === 'SUV'   ? 20 : 10;

  // const km = Math.max(0, Number(distanceKm) || 0);
  // // round to 2 decimals (INR)
  // return Math.round((base + perKm * km) * 100) / 100;
// }

// /**
 // * QUOTE ENDPOINT
 // * Mounted at /api/quote in server.js, so handler must be GET '/' here.
 // * Example: GET /api/quote?vehicleType=MINI&distanceKm=10.25
 // * Returns rupees & final_amount (.50 rule) that your app displays.
 // */
// router.get('/', async (req, res) => {
  // try {
    // const vehicleType = String(req.query.vehicleType || '').toUpperCase();
    // const distanceKm = Number(req.query.distanceKm || 0);

    // const baseInr = computeBaseFareINR(vehicleType, distanceKm);
    // const basePaise = Math.round(baseInr * 100);

    // const { cgst, sgst } = computeGstPaise(basePaise, vehicleType);
    // const totalPaise = basePaise + cgst + sgst;

    // // Convert to rupees for display
    // const baseRupees  = basePaise  / 100;
    // const cgstRupees  = cgst       / 100;
    // const sgstRupees  = sgst       / 100;
    // const totalRupees = totalPaise / 100;

    // // .50 rule for final whole rupees
    // const roundToNearestHalf = (value) => {
      // const intPart = Math.floor(value);
      // const decimal = value - intPart;
      // if (decimal < 0.5)  return intPart;       // below .50 -> down
      // if (decimal === 0.5) return intPart + 0.5; // exactly .50 -> keep .50
      // return intPart + 1;                       // above .50 -> up
    // };
    // const roundedTotalRupees = roundToNearestHalf(totalRupees);

    // return res.json({
      // vehicle_type: vehicleType,
      // base_rupees:  baseRupees.toFixed(2),
      // cgst_rupees:  cgstRupees.toFixed(2),
      // sgst_rupees:  sgstRupees.toFixed(2),
      // total_rupees: totalRupees.toFixed(2),
      // final_amount: roundedTotalRupees, // whole amount per .50 rule
      // gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
    // });
  // } catch (e) {
    // console.error('quote route error:', e);
    // return res.status(500).json({ ok: false, message: 'Server error' });
  // }
// });

// /**
 // * RIDE REQUEST (consistent with /api/quote)
 // * POST /api/ride/request
 // */
// router.post('/request', async (req, res) => {
  // try {
    // const io = global.io;
    // const pool = global.pool;

    // if (!pool) {
      // return res.status(500).json({ success: false, message: 'DB not available' });
    // }

    // let { passengerId, pickup, destination, vehicleType, distanceKm } = req.body;
    // if (!passengerId || !pickup || !destination || !vehicleType) {
      // return res.status(400).json({ success: false, message: 'Missing required fields' });
    // }

    // vehicleType = String(vehicleType).toUpperCase();
    // const externalId = `ride_${Date.now()}`;
    // const otp = Math.floor(1000 + Math.random() * 9000).toString();
    // const etaMinutes = Math.floor(Math.random() * 10) + 5;
    // const km = Math.max(0, Number(distanceKm) || 0);

    // // Pricing (mirror /api/quote)
    // const baseInr = computeBaseFareINR(vehicleType, km); // e.g., 142.50
    // const basePaise = Math.round(baseInr * 100);
    // const { cgst, sgst } = computeGstPaise(basePaise, vehicleType);
    // const totalPaise = basePaise + cgst + sgst;
    // const finalAmountRupees = roundedRupeesFromPaise(totalPaise); // whole rupees (.50 rule)

    // // Persist to rides (store precise paise total)
    // await pool.query(
      // `INSERT INTO rides
         // (external_id, passenger_id, pickup_address, dropoff_address, vehicle_type,
          // estimated_fare_paise, distance_km, otp, eta_minutes)
       // VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      // [
        // externalId,
        // passengerId,
        // pickup,
        // destination,
        // vehicleType,
        // totalPaise,
        // km,
        // otp,
        // etaMinutes
      // ]
    // );

    // // Emit to drivers room (drivers:<VEHICLETYPE>)
    // io.to(`drivers:${vehicleType}`).emit('newRideRequest', {
      // externalId,
      // passengerId,
      // pickup,
      // destination,
      // vehicleType,
      // etaMinutes,
      // otp,
      // pricing: {
        // gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,

        // // rupees (UI-friendly)
        // base_rupees:  (basePaise / 100).toFixed(2),
        // cgst_rupees:  (cgst / 100).toFixed(2),
        // sgst_rupees:  (sgst / 100).toFixed(2),
        // total_rupees: (totalPaise / 100).toFixed(2),
        // final_amount: finalAmountRupees, // INT rupees after .50-up rule

        // // paise (precision/legacy)
        // base_paise: basePaise,
        // cgst_paise: cgst,
        // sgst_paise: sgst,
        // total_paise: totalPaise,
      // }
    // });

    // return res.json({
      // success: true,
      // externalId,
      // otp,
      // etaMinutes,
      // vehicleType,
      // fare: {
        // final_amount: finalAmountRupees,
        // total_rupees: (totalPaise / 100).toFixed(2),
        // gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0
      // }
    // });
  // } catch (e) {
    // console.error('ride request error:', e);
    // return res.status(500).json({ success: false, message: 'Server error' });
  // }
// });

// /**
 // * COMPLETE RIDE + CREATE INVOICE
 // * POST /api/ride/complete
 // * Body: { rideId: "<external_id>" }
 // */
 // function roundHalfUpToInt(value) {
  // const floor = Math.floor(value);
  // return (value - floor) >= 0.5 ? floor + 1 : floor;
// }
 
// router.post('/complete', async (req, res) => {
  // const pool = global.pool;
  // if (!pool) return res.status(500).json({ error: 'DB not available' });

  // const { rideId } = req.body;
  // if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  // const client = await pool.connect();
  // try {
    // await client.query('BEGIN');

    // // 1) Mark ride as completed
    // const rideRes = await client.query(
      // `UPDATE rides
         // SET status = 'COMPLETED',
             // completed_at = NOW()
       // WHERE external_id = $1
       // RETURNING external_id, passenger_id, driver_id, vehicle_type,
                 // pickup_address, dropoff_address, requested_at, completed_at, distance_km`,
      // [rideId]
    // );
    // const ride = rideRes.rows[0];
    // if (!ride) {
      // await client.query('ROLLBACK');
      // return res.status(404).json({ error: 'ride_not_found' });
    // }

    // // 2️⃣ Calculate base and GST (rupees, not paise)
    // const baseInr = computeBaseFareINR(ride.vehicle_type, ride.distance_km || 0); // 853.70
    // const baseRoundedR = roundHalfUpToInt(baseInr);                                // 854

    // // Calculate GST on the original base
    // const basePaiseExact = Math.round(baseInr * 100);
    // const { cgst, sgst } = computeGstPaise(basePaiseExact, ride.vehicle_type);

    // // Convert GST to rupees and round
    // const cgstRoundedR = roundHalfUpToInt(cgst / 100); // e.g. 21.34 → 21
    // const sgstRoundedR = roundHalfUpToInt(sgst / 100); // e.g. 21.34 → 21

    // const totalRoundedR = baseRoundedR + cgstRoundedR + sgstRoundedR; // 896

    // // ✅ Save **whole rupees directly** (no ×100)
    // const baseRoundedRupees  = baseRoundedR;
    // const cgstRoundedRupees  = cgstRoundedR;
    // const sgstRoundedRupees  = sgstRoundedR;
    // const totalRoundedRupees = totalRoundedR;

    // // 3️⃣ Insert invoice with whole rupee values
    // const insertRes = await client.query(
      // `INSERT INTO ride_invoices (
          // ride_external_id, invoice_number, passenger_id, driver_id,
          // vehicle_type, pickup_address, dropoff_address,
          // ride_started_at, ride_completed_at,
          // base_amount_paise, cgst_paise, sgst_paise, total_paise, rounded_rupees
        // )
        // VALUES (
          // $1, NULL, $2, $3,
          // $4, $5, $6,
          // $7, $8,
          // $9, $10, $11, $12, $13
        // )
        // ON CONFLICT (ride_external_id) DO NOTHING
        // RETURNING id`,
      // [
        // ride.external_id,
        // ride.passenger_id,
        // ride.driver_id,
        // ride.vehicle_type,
        // ride.pickup_address,
        // ride.dropoff_address,
        // ride.requested_at,
        // ride.completed_at,
        // baseRoundedRupees,   // ✅ store rupees directly
        // cgstRoundedRupees,   // ✅ store rupees directly
        // sgstRoundedRupees,   // ✅ store rupees directly
        // totalRoundedRupees,  // ✅ store rupees directly
        // totalRoundedRupees
      // ]
    // );

    // if (insertRes.rowCount === 0) {
      // await client.query('COMMIT');
      // return res.json({ ok: true, message: 'Ride completed; invoice already existed.' });
    // }

    // const newId = insertRes.rows[0].id;
    // const year = new Date().getFullYear();
    // const padded = String(newId).padStart(6, '0');
    // const invoiceNumber = `INV-${year}-${padded}`;

    // await client.query(
      // `UPDATE ride_invoices SET invoice_number = $1 WHERE id = $2`,
      // [invoiceNumber, newId]
    // );

    // await client.query('COMMIT');

    // return res.json({
      // ok: true,
      // invoice_number: invoiceNumber,
      // amounts: {
        // base_rupees: baseRoundedRupees,
        // cgst_rupees: cgstRoundedRupees,
        // sgst_rupees: sgstRoundedRupees,
        // total_rupees: totalRoundedRupees
      // }
    // });
  // } catch (e) {
    // await client.query('ROLLBACK');
    // console.error('complete route error:', e);
    // return res.status(500).json({ error: 'server_error' });
  // } finally {
    // client.release();
  // }
// });

// /**
 // * CANCEL RIDE
 // * POST /api/ride/cancel
 // */
// router.post('/cancel', async (req, res) => {
  // try {
    // const { rideId } = req.body;
    // const io = global.io;
    // const pool = global.pool;

    // if (!rideId) return res.status(400).json({ error: 'rideId_required' });

    // const result = await pool.query(
      // `UPDATE rides
         // SET status = 'CANCELLED', completed_at = NOW()
       // WHERE external_id = $1
       // RETURNING driver_id, vehicle_type`,
      // [rideId]
    // );

    // const driverId = result.rows[0]?.driver_id;
    // const vehicleType = result.rows[0]?.vehicle_type;

    // if (driverId) {
      // const dSock = global.activeDrivers?.[String(driverId)]?.socketId || null;
      // if (dSock) global.io.to(dSock).emit('rideCancelled', { rideId });
    // } else if (vehicleType) {
      // global.io.to(`drivers:${vehicleType}`).emit('rideRemoved', { rideId });
    // }

    // return res.json({ ok: true });
  // } catch (e) {
    // console.error('cancel route error:', e);
    // return res.status(500).json({ ok: false, message: 'Server error' });
  // }
// });

// /**
 // * PASSENGER RATING
 // * POST /api/ride/rating
 // */
// router.post('/rating', async (req, res) => {
  // try {
    // const { rideId, rating } = req.body;
    // const pool = global.pool;

    // if (!rideId || !rating) return res.status(400).json({ error: 'rideId_and_rating_required' });

    // const result = await pool.query(
      // `UPDATE rides
         // SET passenger_rating = $1, updated_at = NOW()
       // WHERE external_id = $2
       // RETURNING driver_id`,
      // [Number(rating), rideId]
    // );

    // const driverId = result.rows[0]?.driver_id;

    // try {
      // const dSock = global.activeDrivers?.[String(driverId)]?.socketId || null;
      // if (dSock) global.io.to(dSock).emit('ratingReceived', { rideId, rating: Number(rating) });
    // } catch (e) {
      // console.warn('[rating] socket notify failed:', e?.message || e);
    // }

    // return res.json({ ok: true });
  // } catch (e) {
    // console.error('rating route error:', e);
    // return res.status(500).json({ ok: false, message: 'Server error' });
  // }
// });

// module.exports = router;





// routes/ride.js
const express = require('express');
const router = express.Router();

const {
  computeGstPaise,
  isGstApplicable,
  roundedRupeesFromPaise
} = require('../utils/tax');

// === Base fare calculator (keep in sync with your client estimates) ===
function computeBaseFareINR(vehicleType, distanceKm) {
  const vt = String(vehicleType || '').toUpperCase();

  // Mirrors your MapScreen defaults (AUTO removed per your current file)
  const base =
    vt === 'BIKE'  ? 20 :
    vt === 'MINI'  ? 40 :
    // vt === 'AUTO'  ? 30 :
    vt === 'SEDAN' ? 70 :
    vt === 'SUV'   ? 100 : 40;

  const perKm =
    vt === 'BIKE'  ? 6  :
    vt === 'MINI'  ? 10 :
    // vt === 'AUTO'  ? 8  :
    vt === 'SEDAN' ? 15 :
    vt === 'SUV'   ? 20 : 10;

  const km = Math.max(0, Number(distanceKm) || 0);
  // round to 2 decimals (INR)
  return Math.round((base + perKm * km) * 100) / 100;
}

/**
 * QUOTE ENDPOINT
 * Mounted at /api/quote in server.js, so handler must be GET '/' here.
 * Example: GET /api/quote?vehicleType=MINI&distanceKm=10.25
 * Returns rupees & final_amount (.50 rule) that your app displays.
 */
// router.get('/', async (req, res) => {
  // try {
    // const vehicleType = String(req.query.vehicleType || '').toUpperCase();
    // const distanceKm = Number(req.query.distanceKm || 0);

    // const baseInr = computeBaseFareINR(vehicleType, distanceKm);
    // const basePaise = Math.round(baseInr * 100);

    // const { cgst, sgst } = computeGstPaise(basePaise, vehicleType);
    // const totalPaise = basePaise + cgst + sgst;

    // // Convert to rupees for display
    // const baseRupees  = basePaise  / 100;
    // const cgstRupees  = cgst       / 100;
    // const sgstRupees  = sgst       / 100;
    // const totalRupees = totalPaise / 100;

    // // .50 rule for final whole rupees
    // const roundToNearestHalf = (value) => {
      // const intPart = Math.floor(value);
      // const decimal = value - intPart;
      // if (decimal < 0.5)  return intPart;       // below .50 -> down
      // if (decimal === 0.5) return intPart + 0.5; // exactly .50 -> keep .50
      // return intPart + 1;                       // above .50 -> up
    // };
    // const roundedTotalRupees = roundToNearestHalf(totalRupees);

    // return res.json({
      // vehicle_type: vehicleType,
      // base_rupees:  baseRupees.toFixed(2),
      // cgst_rupees:  cgstRupees.toFixed(2),
      // sgst_rupees:  sgstRupees.toFixed(2),
      // total_rupees: totalRupees.toFixed(2),
      // final_amount: roundedTotalRupees, // whole amount per .50 rule
      // gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
    // });
  // } catch (e) {
    // console.error('quote route error:', e);
    // return res.status(500).json({ ok: false, message: 'Server error' });
  // }
// });

// ✅ =final, and surge-aware version in its place. et('/') endpoint.
// In ride.js
// ❌ DELETE the flawed router.get('/') endpoint I gave you.
// ✅ PASTE this new, correct version that restores your GST logic.
// In your ride.js file
// ❌ DELETE the flawed router.get('/') I gave you previously.
// ✅ PASTE this new, correct version that restores your GST logic.

router.get('/', async (req, res) => {
  const pool = global.pool;
  if (!pool) {
    return res.status(500).json({ ok: false, message: 'DB not available' });
  }

  try {
    const vehicleType = String(req.query.vehicleType || '').toUpperCase();
    const distanceKm = Number(req.query.distanceKm || 0);
    const lat = parseFloat(req.query.latitude);
    const lon = parseFloat(req.query.longitude);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ ok: false, message: 'Missing or invalid latitude/longitude for quote.' });
    }

    // --- 1. SURGE CALCULATION (Your logic from before, which is perfect) ---
    const pickupPointGeog = `ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;
    const surgeQueryText = `
        WITH last_15_min_pings AS (
          SELECT id, location AS geom FROM rider_demand_pings
          WHERE ping_time > NOW() - INTERVAL '15 minutes'
        ),
        clusters AS (
          SELECT ST_ClusterDBSCAN(geom, eps := 500, minpoints := 5) OVER () AS cluster_id, geom
          FROM last_15_min_pings
        ),
        surge_zones AS (
          SELECT
            cluster_id,
            1.0 + (FLOOR((COUNT(*) - 5) / 5.0) * 0.1) AS surge_multiplier,
            ST_ConvexHull(ST_Collect(geom)) AS zone
          FROM clusters
          WHERE cluster_id IS NOT NULL
          GROUP BY cluster_id
          HAVING COUNT(*) >= 5
        )
        SELECT surge_multiplier FROM surge_zones
        WHERE ST_Intersects(zone, ST_Transform(${pickupPointGeog}::geometry, ST_SRID(zone)))
        LIMIT 1;
      `;
    const surgeResult = await pool.query(surgeQueryText);
    let finalSurgeMultiplier = 1.0;
    if (surgeResult.rows.length > 0 && surgeResult.rows[0].surge_multiplier) {
      finalSurgeMultiplier = parseFloat(surgeResult.rows[0].surge_multiplier);
    }
    console.log(`[QUOTE] Surge check for [${lat}, ${lon}]. Multiplier: ${finalSurgeMultiplier}`);


    // --- 2. FARE CALCULATION WITH YOUR ORIGINAL, CORRECT GST LOGIC ---

    // A. Calculate base fare in INR and apply surge
    const baseInr = computeBaseFareINR(vehicleType, distanceKm);
    const surgedBaseInr = baseInr * finalSurgeMultiplier;

    // B. Convert surged base to paise
    const surgedBasePaise = Math.round(surgedBaseInr * 100);

    // C. ✅ Use your correct computeGstPaise function on the surged amount
    const { cgst, sgst } = computeGstPaise(surgedBasePaise, vehicleType);

    // D. ✅ Calculate the final total in paise
    const totalPaise = surgedBasePaise + cgst + sgst;

    // E. ✅ Use your correct roundedRupeesFromPaise function for the final display amount
    const finalAmountRupees = roundedRupeesFromPaise(totalPaise);


    // --- 3. RETURN THE FULL, DETAILED RESPONSE (like your original) ---
    return res.json({
      vehicle_type: vehicleType,
      base_rupees:  baseInr.toFixed(2), // Original base fare for transparency
      cgst_rupees:  (cgst / 100).toFixed(2),
      sgst_rupees:  (sgst / 100).toFixed(2),
      total_rupees: (totalPaise / 100).toFixed(2), // The precise total before final rounding
      final_amount: finalAmountRupees, // The final, rounded amount the user sees and pays
      gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
      surge_multiplier: finalSurgeMultiplier, // Also inform the app about the surge
    });

  } catch (e) {
    console.error('quote route error:', e);
    return res.status(500).json({ ok: false, message: 'Server error during quote generation' });
  }
});





// In your backend 'rides.js' file

router.post('/request', async (req, res) => {
  try {
    const io = global.io;
    const pool = global.pool;

    if (!pool) {
      return res.status(500).json({ success: false, message: 'DB not available' });
    }

    // === SURGE: Destructure latitude and longitude from the pickup object
    let { passengerId, pickup, destination, vehicleType, distanceKm } = req.body;
    if (!passengerId || !pickup || !pickup.latitude || !pickup.longitude || !destination || !vehicleType) {
      return res.status(400).json({ success: false, message: 'Missing required fields, including pickup coordinates.' });
    }

    const { latitude, longitude, address } = pickup;

    // === SURGE: Start database transaction for safety ===
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); // Start transaction

      // === SURGE: Advanced SQL query to find the surge multiplier ===
      const pickupPointGeog = `ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;
      const surgeQueryText = `
        WITH last_15_min_pings AS (
          SELECT id, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geometry AS geom
          FROM passenger_pings
          WHERE created_at > NOW() - INTERVAL '15 minutes'
        ),
        clusters AS (
          SELECT ST_ClusterDBSCAN(geom, eps := 500, minpoints := 5) OVER () AS cluster_id, geom
          FROM last_15_min_pings
        ),
        surge_zones AS (
          SELECT
            cluster_id,
            1.0 + (FLOOR((COUNT(*) - 5) / 5.0) * 0.1) AS surge_multiplier,
            ST_ConvexHull(ST_Collect(geom)) AS zone
          FROM clusters
          WHERE cluster_id IS NOT NULL
          GROUP BY cluster_id
          HAVING COUNT(*) >= 5
        )
        SELECT surge_multiplier FROM surge_zones
        WHERE ST_Intersects(zone, ST_Transform(${pickupPointGeog}::geometry, ST_SRID(zone)))
        LIMIT 1;
      `;

      const surgeResult = await client.query(surgeQueryText);

      let finalSurgeMultiplier = 1.0;
      if (surgeResult.rows.length > 0 && surgeResult.rows[0].surge_multiplier) {
        finalSurgeMultiplier = parseFloat(surgeResult.rows[0].surge_multiplier);
      }
      console.log(`Ride request at [${latitude}, ${longitude}]. Surge multiplier found: ${finalSurgeMultiplier}`);


      vehicleType = String(vehicleType).toUpperCase();
      const externalId = `ride_${Date.now()}`;
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      const etaMinutes = Math.floor(Math.random() * 10) + 5;
      const km = Math.max(0, Number(distanceKm) || 0);

      // --- Pricing Calculation (with Surge) ---
      const baseInr = computeBaseFareINR(vehicleType, km);
      const basePaise = Math.round(baseInr * 100);
      
      // === SURGE: Apply the multiplier to the base fare before taxes ===
      const surgedBasePaise = Math.round(basePaise * finalSurgeMultiplier);

      const { cgst, sgst } = computeGstPaise(surgedBasePaise, vehicleType); // Calculate GST on the surged amount
      const totalPaise = surgedBasePaise + cgst + sgst;
      const finalAmountRupees = roundedRupeesFromPaise(totalPaise);

      // --- Persist to rides table ---
      await client.query(
        `INSERT INTO rides
           (external_id, passenger_id, pickup_address, dropoff_address, vehicle_type,
            estimated_fare_paise, distance_km, otp, eta_minutes, surge_multiplier) -- SURGE: Added column
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, // SURGE: Added parameter
        [
          externalId,
          passengerId,
          address, // Using the string address from the pickup object
          destination,
          vehicleType,
          totalPaise,
          km,
          otp,
          etaMinutes,
          finalSurgeMultiplier // === SURGE: Saving the multiplier to the DB
        ]
      );

      // --- Emit to drivers room ---
      io.to(`drivers:${vehicleType}`).emit('newRideRequest', {
        externalId,
        passengerId,
        pickup: { address, latitude, longitude }, // Send full pickup object
        destination,
        vehicleType,
        etaMinutes,
        otp,
        pricing: {
          gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
          surge_multiplier: finalSurgeMultiplier, // === SURGE: Inform the driver's app about the surge
          base_rupees:  (basePaise / 100).toFixed(2), // Original base fare
          final_amount: finalAmountRupees,
          total_rupees: (totalPaise / 100).toFixed(2),
        }
      });
      
      await client.query('COMMIT'); // Commit transaction

      return res.json({
        success: true,
        externalId,
        otp,
        etaMinutes,
        vehicleType,
        fare: {
          final_amount: finalAmountRupees,
          total_rupees: (totalPaise / 100).toFixed(2),
          gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
          surge_multiplier: finalSurgeMultiplier, // === SURGE: Inform the passenger app about the surge
        }
      });
    } catch (e) {
      await client.query('ROLLBACK'); // Rollback on error
      console.error('ride request transaction error:', e);
      return res.status(500).json({ success: false, message: 'Server error during ride creation' });
    } finally {
      client.release(); // Release client back to the pool
    }
  } catch (e) {
    console.error('ride request connection error:', e);
    return res.status(500).json({ success: false, message: 'Server connection error' });
  }
});


/**
 * COMPLETE RIDE + CREATE INVOICE
 * POST /api/ride/complete
 * Body: { rideId: "<external_id>" }
 */
 function roundHalfUpToInt(value) {
 return Math.round(value);
}
// In routes/ride.js
// ✅ REPLACE your entire router.post('/complete', ...) endpoint with this new version.
router.post('/complete', async (req, res) => {
  const pool = global.pool;
  if (!pool) return res.status(500).json({ error: 'DB not available' });

  const { rideId, paidByCash } = req.body;
  if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch ride details
    const rideRes = await client.query(
      `UPDATE rides SET status = 'COMPLETED', completed_at = NOW()
       WHERE external_id = $1
       RETURNING external_id, passenger_id, driver_id, vehicle_type,
                 pickup_address, dropoff_address, requested_at, completed_at, distance_km`,
      [rideId]
    );
    const ride = rideRes.rows[0];
    if (!ride) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ride_not_found' });
    }

    // --- ✅ START: THE FINAL, CORRECTED & SIMPLIFIED LOGIC ---

    // 2. Calculate the precise base fare in INR (e.g., 3735.90)
    const baseInr = computeBaseFareINR(ride.vehicle_type, ride.distance_km || 0);

    // 3. Calculate the precise total fare by adding GST *before* any rounding.
    const gstRate = isGstApplicable(ride.vehicle_type) ? 0.05 : 0;
    const totalInr = baseInr * (1 + gstRate); // e.g., 3735.90 * 1.05 = 3922.695

    // 4. Round the FINAL total ONCE. This is the official amount for everything.
    const finalTotalRoundedR = roundHalfUpToInt(totalInr); // e.g., round(3922.695) = 3923. This is correct.

    // 5. Update the main rides table with this definitive final fare.
    await client.query(
      `UPDATE rides SET final_fare = $1 WHERE external_id = $2`,
      [finalTotalRoundedR, ride.external_id]
    );

    // 6. For the invoice, work backward from the final rounded total.
    //    This ensures all invoice components perfectly sum up to the final amount.
    const invoiceBasePrecise = finalTotalRoundedR / (1 + gstRate);
    const invoiceCgstR = roundHalfUpToInt(invoiceBasePrecise * (gstRate / 2));
    const invoiceSgstR = roundHalfUpToInt(invoiceBasePrecise * (gstRate / 2));
    // The invoice base is what's left. This guarantees accuracy for the invoice.
    const invoiceBaseR = finalTotalRoundedR - invoiceCgstR - invoiceSgstR;

    // 7. For CASH rides, calculate the commission driver owes on the INVOICE base amount.
    if (paidByCash) {
      const companyCommissionRate = 0.35; // 35%
      // Using invoiceBaseR ensures the commission is based on what's shown on the invoice.
      const amountDueInr = invoiceBaseR * companyCommissionRate;
      const amountDueRoundedR = roundHalfUpToInt(amountDueInr); // e.g., round(invoiceBaseR * 0.35)

      // This logic will now correctly round 899.50 to 900.
      if (amountDueRoundedR > 0) {
        await client.query(
          `INSERT INTO wallet_ledger
            (driver_id, ride_external_id, type, direction, amount_paise, note, is_settled, due_date)
           VALUES ($1, $2, 'CASH_RECEIVED', 'DR', $3, $4, FALSE, NOW() + interval '7 day')`,
          [ride.driver_id, ride.external_id, amountDueRoundedR, `Commission for cash ride ${ride.external_id}`]
        );
      }
    }

    // 8. Insert the balanced invoice details into the database.
    const insertRes = await client.query(
      `INSERT INTO ride_invoices (ride_external_id, passenger_id, driver_id, vehicle_type, base_amount_paise, cgst_paise, sgst_paise, total_paise, rounded_rupees, pickup_address, dropoff_address, ride_started_at, ride_completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (ride_external_id) DO NOTHING RETURNING id`,
      [
        ride.external_id, ride.passenger_id, ride.driver_id, ride.vehicle_type,
        invoiceBaseR, invoiceCgstR, invoiceSgstR, finalTotalRoundedR, finalTotalRoundedR, // Use the balanced, correct values
        ride.pickup_address, ride.dropoff_address, ride.requested_at, ride.completed_at
      ]
    );


    // Update invoice number logic (remains the same)
    if (insertRes.rowCount > 0) {
      const newId = insertRes.rows[0].id;
      const year = new Date().getFullYear();
      const padded = String(newId).padStart(6, '0');
      const invoiceNumber = `INV-${year}-${padded}`;
      await client.query(`UPDATE ride_invoices SET invoice_number = $1 WHERE id = $2`, [invoiceNumber, newId]);
    }
    
    await client.query('COMMIT');

    // 7. Inform both passenger and driver that the ride is complete
    const passengerSocket = global.onlineUsers?.[String(ride.passenger_id)]?.socketId;
    if(passengerSocket) {
      global.io.to(passengerSocket).emit('rideCompleted', { 
        rideId: ride.external_id, 
        finalFare: totalRoundedR,
        paidByCash: paidByCash 
      });
    }

    const driverSocket = global.activeDrivers?.[String(ride.driver_id)]?.socketId;
    if(driverSocket) {
      global.io.to(driverSocket).emit('rideCompleted', { 
        rideId: ride.external_id, 
        finalFare: totalRoundedR,
        paidByCash: paidByCash 
      });
    }
    
    // Return a generic success message to the original caller (which could be the driver)
    return res.json({ ok: true, message: 'Ride completed successfully.' });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('complete route error:', e);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});


/**
 * CANCEL RIDE
 * POST /api/ride/cancel
 */
router.post('/cancel', async (req, res) => {
  try {
    const { rideId } = req.body;
    const io = global.io;
    const pool = global.pool;

    if (!rideId) return res.status(400).json({ error: 'rideId_required' });

    const result = await pool.query(
      `UPDATE rides
         SET status = 'CANCELLED', completed_at = NOW()
       WHERE external_id = $1
       RETURNING driver_id, vehicle_type`,
      [rideId]
    );

    const driverId = result.rows[0]?.driver_id;
    const vehicleType = result.rows[0]?.vehicle_type;

    if (driverId) {
      const dSock = global.activeDrivers?.[String(driverId)]?.socketId || null;
      if (dSock) global.io.to(dSock).emit('rideCancelled', { rideId });
    } else if (vehicleType) {
      global.io.to(`drivers:${vehicleType}`).emit('rideRemoved', { rideId });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('cancel route error:', e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/**
 * PASSENGER RATING
 * POST /api/ride/rating
 */
router.post('/rating', async (req, res) => {
  try {
    const { rideId, rating } = req.body;
    const pool = global.pool;

    if (!rideId || !rating) return res.status(400).json({ error: 'rideId_and_rating_required' });

    const result = await pool.query(
      `UPDATE rides
         SET passenger_rating = $1, updated_at = NOW()
       WHERE external_id = $2
       RETURNING driver_id`,
      [Number(rating), rideId]
    );

    const driverId = result.rows[0]?.driver_id;

    try {
      const dSock = global.activeDrivers?.[String(driverId)]?.socketId || null;
      if (dSock) global.io.to(dSock).emit('ratingReceived', { rideId, rating: Number(rating) });
    } catch (e) {
      console.warn('[rating] socket notify failed:', e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('rating route error:', e);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});


// In routes/ride.js (Add this at the end of the file, before `module.exports = router;`)

/**
 * ACTIVE RIDE STATUS CHECK
 * GET /api/ride/active-status/:passengerId
 * This is the API endpoint the Flutter MapScreen should call on startup.
 */
router.get('/active-status/:passengerId', async (req, res) => {
  const pool = global.pool;
  if (!pool) return res.status(500).json({ error: 'DB not available' });

  const passengerId = req.params.passengerId;

  try {
    // 🛑 CRITICAL FIX: Filter for ONLY TRULY ACTIVE STATUSES 🛑
    // This query ensures 'SCHEDULED' rides are ignored.
    const result = await pool.query(
      `SELECT external_id, status, driver_id, pickup_address
       FROM rides 
       WHERE passenger_id = $1 
         AND driver_id is not null -- <--- ADDED CONDITION
         AND status IN ('PENDING', 'ACCEPTED', 'ARRIVED', 'IN_TRANSIT') 
AND completed_at IS NULL
  AND cancelled_at IS NULL
       ORDER BY id DESC
       LIMIT 1`,
      [passengerId]
    );

    if (result.rows.length === 0) {
      // Correctly reports no active ride (includes scheduled, completed, cancelled)
      return res.json({ isActive: false });
    }

    const ride = result.rows[0];
    return res.json({ 
      isActive: true, 
      rideId: ride.external_id, 
      status: ride.status,
      driverId: ride.driver_id,
      pickupAddress: ride.pickup_address,
      // Include any other necessary fields the MapScreen needs
    });

  } catch (e) {
    console.error('active-status route error:', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;









