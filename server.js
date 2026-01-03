// server.js (Corrected)
require('dotenv').config();



const express = require('express');
const http = require('http');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const admin = require('firebase-admin');

const authRoutes = require('./routes/auth.js');
const driverVerificationRoutes = require('./routes/driverVerification.js');
const rideRoutes = require('./routes/ride.js');
const initSocketServer = require('./socket.js'); // returns io
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
//const initializeCronJobs = require('./cron_jobs'); 
const driverRoutes = require('./routes/driver.js');
const duesRoutes = require('./routes/dues');
const demand = require('./routes/demand');
const scheduleRoutes = require('./routes/schedule.js');
const adminWalletRoutes = require("./routes/adminWallet");
const userRoutes = require('./routes/user.js'); 
const pool = require('./db');






// --- DB Pool ---
// const pool = new Pool({
  // connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false },
// });

// Expose for routes that need them at runtime (MOVED THIS BLOCK UP)
global.pool = pool; // <--- Set global.pool BEFORE mounting routes
// io will be set after initSocketServer

// --- Express app ---
const app = express();
app.use(cors());
app.use(express.json());

app.set('trust proxy', true);



admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

console.log('✅ Firebase Admin initialized via ENV');

console.log('✅ Firebase Admin initialized via ENV');

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

// Force connection close (fixes ngrok + Flutter)
app.use((req, res, next) => {
  res.setHeader('Connection', 'close');
  next();
});




// Simple check
app.get('/', (_req, res) => res.send('Ride Hailing Backend is running!'));
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/driver', driverVerificationRoutes);
app.use('/api/ride', rideRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/payment', paymentRoutes); // Now paymentRoutes can access global.pool safely
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/settlement', require('./routes/settlement'));
app.use('/api/driver', driverRoutes);
app.use('/api/dues', duesRoutes);
app.use('/api/demand', demand);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/admin', require('./routes/adminDrivers'));
app.use("/api/admin", adminWalletRoutes);
app.use('/api/user', userRoutes); 


// CORRECT:
//require('./cron_jobs');
const { isGstApplicable, roundedRupeesFromPaise } = require('./utils/tax'); // This import is correct

function computeBaseFareINR(vehicleType, distanceKm) {
  const vt = String(vehicleType || '').toUpperCase();
  const base = vt === 'BIKE' ? 20 : vt === 'MINI' ? 40 : vt === 'SEDAN' ? 70 : vt === 'SUV' ? 100 : 40;
  const perKm = vt === 'BIKE' ? 6 : vt === 'MINI' ? 10 : vt === 'SEDAN' ? 15 : vt === 'SUV' ? 20 : 10;
  const km = Math.max(0, Number(distanceKm) || 0);
  return Math.round((base + perKm * km) * 100) / 100;
}

app.get('/api/quote', async (req, res) => {
  try {
    const { vehicleType, distanceKm, latitude, longitude } = req.query;

    if (!vehicleType || !distanceKm) {
      return res.status(400).json({ error: 'Missing vehicleType or distanceKm' });
    }

    // --- 1. Surge Calculation ---
    let surgeMultiplier = 1.0;
    try {
      // =================================================================
      // ✅ THIS IS THE FINAL FIX. IT USES YOUR CORRECT TABLE NAME.
      // =================================================================
      const surgeResult = await pool.query(
        `-- We now query YOUR 'rider_demand_pings' table.
         SELECT COUNT(*) as ping_count
         FROM rider_demand_pings
         WHERE ping_time >= NOW() - INTERVAL '15 minutes'
           AND ST_DWithin(
             location,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             2000 -- Look for pings within a 2km radius
           );`,
        [longitude, latitude] // Use longitude, then latitude for PostGIS
      );

      const pingCount = parseInt(surgeResult.rows[0]?.ping_count, 10) || 0;

      // This is a simple surge logic: if more than 5 pings are in an area, apply surge.
      // You can make this logic more advanced later.
      if (pingCount > 5) {
        surgeMultiplier = 1.2; // Apply a 1.2x surge
      }
      if (pingCount > 10) {
        surgeMultiplier = 1.5; // Apply a 1.5x surge for very high demand
      }
      // =================================================================

    } catch (e) {
      // This will now only run if there's a major database error.
      console.warn('Surge multiplier lookup failed, using 1.0. Error:', e.message);
    }

    // --- 2. Fare Calculation ---
    const baseFare = computeBaseFareINR(vehicleType, distanceKm);
    const surgedBaseFare = baseFare * surgeMultiplier;

    let finalAmount = surgedBaseFare;
    let cgst = 0;
    let sgst = 0;
    let gstRate = 0;

    if (isGstApplicable(vehicleType)) {
      gstRate = 5; // 5% total
      cgst = surgedBaseFare * 0.025; // 2.5%
      sgst = surgedBaseFare * 0.025; // 2.5%
      finalAmount = surgedBaseFare + cgst + sgst;
    }

    // --- 3. Send Response ---
    res.json({
      base_rupees: baseFare.toFixed(2), // The original base fare before surge
      cgst_rupees: cgst.toFixed(2),
      sgst_rupees: sgst.toFixed(2),
      final_amount: roundedRupeesFromPaise(finalAmount * 100), // Final rounded integer amount
      gst_rate_percent: gstRate,
      surge_multiplier: surgeMultiplier,
    });

  } catch (error) {
    console.error('[GET /api/quote] Major error:', error);
    res.status(500).json({ error: 'Server error while fetching quote' });
  }
});

// --- HTTP server + Socket.IO ---
const server = http.createServer(app);
const io = initSocketServer(server, pool);  // initialise ONCE

global.io = io; // <--- global.io set here
//initializeCronJobs(pool, io);



//weekly report data
function getWeekBounds(date) {
  const now = date ? new Date(date) : new Date();
  const dayOfWeek = now.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday

  // Set to Monday of the current week
  const startOfWeek = new Date(now);
  const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust for Sunday
  startOfWeek.setDate(diff);
  startOfWeek.setHours(0, 0, 0, 0);

  // Set to Sunday of the current week
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  return { startOfWeek, endOfWeek };
}

app.get('/api/drivers/:driverId/weekly-summary', async (req, res) => {
  const { driverId } = req.params;
  if (!driverId) {
    return res.status(400).json({ message: 'Driver ID is required' });
  }

  try {
    const { startOfWeek, endOfWeek } = getWeekBounds();

    // --- 1. Get Current Week's Data ---
    const currentWeekQuery = `
      SELECT
        type,
        SUM(amount_paise) AS total_paise
      FROM wallet_ledger
      WHERE driver_id = $1
        AND created_at >= $2
        AND created_at <= $3
        AND (type = 'CREDIT_ONLINE' OR type = 'CASH_RECEIVED')
      GROUP BY type;
    `;
    const currentWeekResult = await pool.query(currentWeekQuery, [driverId, startOfWeek, endOfWeek]);

    let onlineEarningsPaise = 0;
    let cashLiabilityPaise = 0;

    currentWeekResult.rows.forEach(row => {
      if (row.type === 'CREDIT_ONLINE') {
        onlineEarningsPaise = parseInt(row.total_paise, 10);
      } else if (row.type === 'CASH_RECEIVED') {
        cashLiabilityPaise = parseInt(row.total_paise, 10);
      }
    });

    // --- 2. Get Past Unsettled Dues (from before this Monday) ---
    const pastDuesQuery = `
      SELECT
        SUM(CASE WHEN direction = 'CR' THEN amount_paise ELSE -amount_paise END) AS total_due_paise
      FROM wallet_ledger
      WHERE driver_id = $1
        AND is_settled = FALSE
        AND created_at < $2;
    `;
    const pastDuesResult = await pool.query(pastDuesQuery, [driverId, startOfWeek]);

    const previousDuesPaise = parseInt(pastDuesResult.rows[0]?.total_due_paise, 10) || 0;

    // --- 3. Format Response ---
    const response = {
      onlineEarningsRupees: Math.round(onlineEarningsPaise / 100),
      cashLiabilityRupees: Math.round(cashLiabilityPaise / 100),
      netEarningsRupees: Math.round((onlineEarningsPaise - cashLiabilityPaise) / 100),
      previousDuesRupees: Math.round(Math.abs(previousDuesPaise) / 100),
      weekDisplay: `Week: ${startOfWeek.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} - ${endOfWeek.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`
    };

    res.json(response);

  } catch (error) {
    console.error('Error fetching weekly summary:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// ✅ REPLACE the rating endpoint with this corrected version

// app.post('/api/ride/:rideId/rating', async (req, res) => {
  // try {
    // const { rideId: rideExternalId } = req.params; // Get the string ID like 'ride_123'
    // const { passengerId, driverId, rating, review } = req.body;

    // if (!rideExternalId || !driverId || !passengerId || rating == null) {
      // return res.status(400).json({ message: 'Missing required fields for rating.' });
    // }

    // // 1. First, get the integer `id` from the `rides` table using the external ID.
    // const rideQuery = await pool.query(
      // `SELECT id FROM rides WHERE external_id = $1 LIMIT 1`,
      // [rideExternalId]
    // );

    // if (rideQuery.rows.length === 0) {
      // return res.status(404).json({ message: 'Ride not found with the given external ID.' });
    // }
    // const internalRideId = rideQuery.rows[0].id; // This is the integer ID your table needs.

    // // 2. Insert the rating using the correct integer `ride_id`.
    // await pool.query(
      // // --- THIS SQL QUERY IS NOW CORRECT FOR YOUR TABLE ---
      // `INSERT INTO ride_ratings (ride_id, driver_id, passenger_id, rating, review, created_at)
       // VALUES ($1, $2, $3, $4, $5, NOW())`,
      // [internalRideId, driverId, passengerId, rating, review]
    // );

    // // 3. Update the driver's average rating in the 'drivers' table.
    // await pool.query(
      // `UPDATE drivers
          // SET rating = (
              // SELECT AVG(rating) FROM ride_ratings WHERE driver_id = $1
          // ),
          // rating_count = (
              // SELECT COUNT(*) FROM ride_ratings WHERE driver_id = $1
          // )
        // WHERE user_id = $1`,
      // [driverId]
    // );

    // console.log(`✅ Rating received for ride ${rideExternalId}. New average calculated.`);
    // res.status(201).json({ message: 'Rating submitted successfully' });

  // } catch (error) {
    // console.error('Error processing ride rating:', error);
    // res.status(500).json({ message: 'Internal Server Error while saving rating.' });
  // }
// });


    // ✅✅✅ THIS IS THE FINAL, VICTORIOUS RATING FUNCTION ✅✅✅
    app.post('/api/ride/:rideId/rating', async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rideId: rideExternalId } = req.params;
        const { passengerId, driverId, rating, review } = req.body;

        if (!rideExternalId || !driverId || !passengerId || rating == null) {
          return res.status(400).json({ message: 'Missing required fields for rating.' });
        }

        const rideQuery = await pool.query(
          `SELECT id FROM rides WHERE external_id = $1 LIMIT 1`,
          [rideExternalId]
        );

        if (rideQuery.rows.length === 0) {
          return res.status(404).json({ message: 'Ride not found with the given external ID.' });
        }
        const internalRideId = rideQuery.rows[0].id;

        // --- Update the 'rides' table status to COMPLETED ---
        // This is the line that was causing the error before.
        // It is now corrected. It does NOT mention 'finished_at'.
        await client.query(
          `UPDATE rides SET status = 'COMPLETED' WHERE id = $1`,
          [internalRideId]
        );

        // --- If it's a scheduled ride, update that table too ---
        if (rideExternalId.startsWith('sched_')) {
          await client.query(
            `UPDATE scheduled_rides SET status = 'COMPLETED' WHERE external_id = $1`,
            [rideExternalId]
          );
        }

        // --- Insert the new rating ---
        await client.query(
          `INSERT INTO ride_ratings (ride_id, driver_id, passenger_id, rating, review, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [internalRideId, driverId, passengerId, rating, review]
        );
        
        // --- Update the driver's average rating ---
        await client.query(
          `WITH NewRatingSummary AS (
              SELECT
                  r.driver_id,
                  COUNT(r.rating) AS new_rating_count,
                  AVG(r.rating) AS new_average_rating
              FROM
                  ride_ratings r
              WHERE
                  r.driver_id = $1
              GROUP BY
                  r.driver_id
          )
          UPDATE drivers d
          SET
              rating = nrs.new_average_rating,
              rating_count = nrs.new_rating_count
          FROM
              NewRatingSummary nrs
          WHERE
              d.user_id = nrs.driver_id;`,
          [driverId]
        );

        await client.query('COMMIT');
        console.log(`✅ Rating received for ride ${rideExternalId}. Status updated to COMPLETED.`);
        res.status(201).json({ message: 'Rating submitted successfully' });

      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing ride rating:', error);
        res.status(500).json({ message: 'Internal Server Error while saving rating.' });
      } finally {
        client.release();
      }
    });
    // ✅✅✅ END OF THE FINAL FUNCTION ✅✅✅
    

// ✅ ADD THIS ENDPOINT TO YOUR server.js or index.js FILE

app.get('/api/user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: 'User ID is required.' });
    }

    // This query fetches the name from your 'users' table
    const { rows } = await pool.query(
      `SELECT name FROM users WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Send the user's data back as JSON
    // The key here is "name", which matches what the Flutter app expects.
    res.json({
      id: id,
      name: rows[0].name
    });

  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// In server.js, replace the existing findDriverForRide function with this one.

// async function findDriverForRide(ride) {
  // console.log(`[DISPATCHER] Initiating driver search for ride ${ride.external_id}`);
  
  // // Use a database connection from the global pool
  // const client = await global.pool.connect();
  
  // try {
    // // Step 1: Update the ride status to 'SEARCHING' immediately.
    // // This prevents it from being dispatched again in the next cycle.
    // await client.query(
      // `UPDATE scheduled_rides SET status = 'SEARCHING' WHERE external_id = $1`,
      // [ride.external_id]
    // );

    // // Step 2: Prepare the ride data to send to the driver.
    // // We can add more details here later if needed.
    // const rideRequestData = {
      // rideId: ride.external_id,
      // pickupAddress: ride.pickup_address,
      // dropoffAddress: ride.dropoff_address,
      // estimatedFare: ride.estimated_fare,
      // scheduledPickupTime: ride.scheduled_pickup_time,
    // };

    // // Step 3: Emit a socket.io event to all connected drivers in the 'available_drivers' room.
    // // ✅ CRITICAL FIX: Use `global.io` to access the initialized socket server instance.
    // if (global.io) {
      // global.io.to('available_drivers').emit('new-scheduled-ride-request', rideRequestData);
      // console.log(`[DISPATCHER] Emitted ride request ${ride.external_id} to 'available_drivers' room.`);
    // } else {
      // console.error('[DISPATCHER] global.io is not initialized. Cannot emit socket event.');
    // }

  // } catch (e) {
    // console.error(`[DISPATCHER] Error processing ride ${ride.external_id}:`, e);
    // // If an error occurs, revert the status so the system can try again in the next minute.
    // await client.query(
        // `UPDATE scheduled_rides SET status = 'SCHEDULED' WHERE external_id = $1`,
        // [ride.external_id]
    // );
  // } finally {
    // // IMPORTANT: Always release the client back to the pool.
    // client.release();
  // }
// }

// ✅✅✅ PASTE THIS ENTIRE NEW ENDPOINT INTO YOUR server.js FILE ✅✅✅

app.get('/api/drivers/:driverId/daily-summary', async (req, res) => {
  const { driverId } = req.params;
  const { date } = req.query; // Expects a date string like 'YYYY-MM-DD'

  if (!driverId) {
    return res.status(400).json({ message: 'Driver ID is required' });
  }

  // --- Date Calculation: Default to today if no date is provided ---
  const targetDate = date ? new Date(date) : new Date();
  targetDate.setHours(0, 0, 0, 0); // Start of the day (00:00:00)

  const dayAfter = new Date(targetDate);
  dayAfter.setDate(targetDate.getDate() + 1); // Start of the next day

  try {
    const client = await pool.connect();

    // --- Query to get ALL completed rides for the target day ---
    const ridesQuery = `
      SELECT
        external_id,
        pickup_address,
        dropoff_address,
        final_fare,       -- The total amount the passenger paid
        completed_at,
        (SELECT type FROM wallet_ledger wl WHERE wl.ride_external_id = r.external_id AND wl.driver_id = r.driver_id LIMIT 1) as payment_type
      FROM rides r
      WHERE driver_id = $1
        AND status = 'COMPLETED'
        AND completed_at >= $2
        AND completed_at < $3
      ORDER BY completed_at DESC;
    `;

    const ridesResult = await client.query(ridesQuery, [driverId, targetDate, dayAfter]);
    const rides = ridesResult.rows;

    let totalOnlineEarnings = 0;
    let totalOfflineEarnings = 0;
    const onlineTransactions = [];
    const offlineTransactions = [];

    // --- Process each ride to calculate earnings and create transaction details ---
    for (const ride of rides) {
      const totalFare = parseFloat(ride.final_fare);

      // Your magnificent formula to find the amount before GST
      // (e.g., if fare is 105, base before GST is 100)
      const fareExcludingGst = totalFare / 1.05;

      // Driver's share is 65% of the fare *before* GST
      const driverShare = fareExcludingGst * 0.65;
      const companyCommission = fareExcludingGst * 0.35;

      const transactionDetail = {
        rideId: ride.external_id,
        from: ride.pickup_address,
        to: ride.dropoff_address,
        totalFare: totalFare,
        fareExcludingGst: fareExcludingGst,
        driverShare: driverShare,
        companyCommission: companyCommission
      };

      if (ride.payment_type === 'CREDIT_ONLINE') {
        totalOnlineEarnings += driverShare;
        onlineTransactions.push(transactionDetail);
      } else { // Assumes CASH_RECEIVED or any other type is offline
        totalOfflineEarnings += totalFare; // For offline, driver collects the full fare
        offlineTransactions.push(transactionDetail);
      }
    }

    client.release();

    // --- Send the final, glorious summary object ---
    res.json({
      summaryDate: targetDate.toISOString().split('T')[0], // 'YYYY-MM-DD'
      totalRides: rides.length,
      totalEarnings: totalOnlineEarnings, // Driver's net earning for the day
      online: {
        totalAmount: totalOnlineEarnings,
        count: onlineTransactions.length,
        transactions: onlineTransactions
      },
      offline: {
        // For offline, we show the total cash collected by the driver
        totalAmount: totalOfflineEarnings,
        count: offlineTransactions.length,
        transactions: offlineTransactions
      }
    });

  } catch (error) {
    console.error('Error fetching daily summary:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// --- Listen ---
const PORT = process.env.PORT || 3000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});