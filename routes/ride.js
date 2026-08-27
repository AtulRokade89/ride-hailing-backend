// routes/ride.js
const express = require('express');
const router = express.Router();

const {
  computeGstPaise,
  isGstApplicable,
  roundedRupeesFromPaise,
  computeBaseFareINR
} = require('../utils/tax');


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
      base_rupees:  surgedBaseInr.toFixed(2), // Original base fare for transparency
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
  SELECT
    id,
    location::geometry AS geom
  FROM rider_demand_pings
  WHERE ping_time > NOW() - INTERVAL '15 minutes'
),
clusters AS (
  SELECT
    ST_ClusterDBSCAN(geom, eps := 500, minpoints := 5) OVER () AS cluster_id,
    geom
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
SELECT surge_multiplier
FROM surge_zones
WHERE ST_Intersects(
  zone,
  ST_Transform(
    ST_SetSRID(ST_MakePoint($1, $2), 4326),
    ST_SRID(zone)
  )
)
LIMIT 1;

      `;

     const surgeResult = await client.query(
  surgeQueryText,
  [longitude, latitude]
);


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
            estimated_fare, distance_km, otp, eta_minutes, surge_multiplier,status) -- SURGE: Added column
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,'PENDING')`, // SURGE: Added parameter
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


 function roundHalfUpToInt(value) {
 return Math.round(value);
}

router.post('/complete', async (req, res) => {
  const pool = global.pool;
  if (!pool) return res.status(500).json({ error: 'DB not available' });

  const { rideId, paidByCash } = req.body;
  if (!rideId) return res.status(400).json({ error: 'rideId_required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Fetch ride details
  await client.query(
  `UPDATE rides SET status = 'COMPLETED', completed_at = NOW()
   WHERE external_id = $1`,
  [rideId]
);
const rideRes = await client.query(
  `SELECT external_id, passenger_id, driver_id, vehicle_type,
          pickup_address, dropoff_address, requested_at, completed_at,
          distance_km, extra_amount, waiting_amount, estimated_fare
   FROM rides
   WHERE external_id = $1`,
  [rideId]
);

    const ride = rideRes.rows[0];
    if (!ride) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ride_not_found' });
    }

    // --- ✅ START: THE FINAL, CORRECTED & SIMPLIFIED LOGIC ---

const lockedFare  = Number(ride.final_fare || ride.estimated_fare || 0);
const waiting     = Number(ride.waiting_amount || 0);
const extra       = Number(ride.extra_amount   || 0);

const gstRate = isGstApplicable(ride.vehicle_type) ? 0.05 : 0;

// ✅ GST sirf base pe lagega (waiting/extra hatao)
const taxableTotal = lockedFare - waiting - extra;

// ✅ exact base (NO ROUND)
const baseExact = taxableTotal / (1 + gstRate);

// ✅ GST exact
const cgstExact = baseExact * 0.025;
const sgstExact = baseExact * 0.025;

// ✅ store decimals (IMPORTANT)
const invoiceBaseR = Number(baseExact.toFixed(2));
const invoiceCgstR = Number(cgstExact.toFixed(2));
const invoiceSgstR = Number(sgstExact.toFixed(2));

// ✅ FINAL TOTAL (sirf yaha round)
const finalTotalRoundedR = Math.round(
  invoiceBaseR + invoiceCgstR + invoiceSgstR + waiting + extra
);  

console.log('🔍 DEBUG /complete:', {
  rideId: ride.external_id,
  raw_waiting_amount: ride.waiting_amount,
  parsed_waiting: waiting,
  raw_extra_amount: ride.extra_amount,
  parsed_extra: extra,
  vehicle_type: ride.vehicle_type,
  distance_km: ride.distance_km,
  baseInr: baseInr,
});

// 3. GST applies ONLY on (base + extra), NOT on waiting
// const gstRate        = isGstApplicable(ride.vehicle_type) ? 0.05 : 0;
// const taxableAmount  = baseInr + extra;                          // GST base
// const gstAmount      = taxableAmount * gstRate;                  // e.g. 500 * 0.05 = 25
// const totalInr       = taxableAmount + gstAmount + waiting;      // ✅ waiting added flat after GST

// 4. Round the FINAL total ONCE.
//const finalTotalRoundedR = roundHalfUpToInt(totalInr);

// 5. Update rides table with final fare.
await client.query(
  `UPDATE rides SET final_fare = $1, payment_mode = $2 WHERE external_id = $3`,
  [finalTotalRoundedR, paidByCash ? 'CASH' : 'ONLINE', ride.external_id]
);

// 6. Build invoice components cleanly (no back-calculation needed now).
//    GST is only on taxableAmount — this is clean and exact.
// const invoiceCgstR   = roundHalfUpToInt((taxableAmount * (gstRate / 2)));  // CGST 2.5%
// const invoiceSgstR   = roundHalfUpToInt((taxableAmount * (gstRate / 2)));  // SGST 2.5%
// const invoiceBaseR   = roundHalfUpToInt(taxableAmount);                    // base+extra, pre-GST
// const waitingRounded = roundHalfUpToInt(waiting);                          // waiting, no GST

// 7. For CASH rides: commission is 3% of taxable base only. Waiting = 100% driver, no commission.
if (paidByCash) {
  const companyCommissionR = roundHalfUpToInt(invoiceBaseR * 0.03); // 3% of base+extra only

  if (companyCommissionR > 0) {
    await client.query(
      `INSERT INTO wallet_ledger
        (driver_id, ride_external_id, type, direction, amount_paise, note, is_settled, due_date)
       VALUES ($1, $2, 'CASH_RECEIVED', 'DR', $3, $4, FALSE, NOW() + interval '7 day')`,
      [ride.driver_id, ride.external_id, companyCommissionR,
       `Commission 3% of base (excl. waiting) for cash ride ${ride.external_id}`]
    );
  }
}

// 8. Insert invoice — now also saves waiting_amount separately.
const insertRes = await client.query(
  `INSERT INTO ride_invoices
    (ride_external_id, passenger_id, driver_id, vehicle_type,
     base_amount_paise, cgst_paise, sgst_paise, total_paise, rounded_rupees,
     waiting_amount,
     pickup_address, dropoff_address, ride_started_at, ride_completed_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
   ON CONFLICT (ride_external_id) DO UPDATE SET
     waiting_amount   = EXCLUDED.waiting_amount,
     base_amount_paise= EXCLUDED.base_amount_paise,
     total_paise      = EXCLUDED.total_paise,
     rounded_rupees   = EXCLUDED.rounded_rupees
     RETURNING id`,
  [
    ride.external_id, ride.passenger_id, ride.driver_id, ride.vehicle_type,
    invoiceBaseR, invoiceCgstR, invoiceSgstR, finalTotalRoundedR, finalTotalRoundedR,
    waitingRounded,
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
        finalFare: finalTotalRoundedR,
        paidByCash: paidByCash 
      });
    }

    const driverSocket = global.activeDrivers?.[String(ride.driver_id)]?.socketId;
    if(driverSocket) {
      global.io.to(driverSocket).emit('rideCompleted', { 
        rideId: ride.external_id, 
        finalFare: finalTotalRoundedR,
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
		const result = await pool.query(
		`SELECT external_id, status, driver_id, pickup_address FROM rides WHERE passenger_id = $1 
      AND driver_id is not null 
      AND status IN ('PENDING', 'ACCEPTED', 'ARRIVED', 'IN_TRANSIT', 'DISPUTED')
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
	
	
	console.log(e.position);
console.log(e.message);
console.log(resultQuery);
  }
});

module.exports = router;









