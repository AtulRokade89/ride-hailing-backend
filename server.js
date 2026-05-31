// server.js (Corrected)
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const admin = require('firebase-admin');
const { Pool } = require('pg');

const authRoutes = require('./routes/auth.js');
const driverVerificationRoutes = require('./routes/driverVerification.js');
const rideRoutes = require('./routes/ride.js');
const initSocketServer = require('./socket.js'); // returns io
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
const initializeCronJobs = require('./cron_jobs'); 
const driverRoutes = require('./routes/driver.js');
const duesRoutes = require('./routes/dues');
const demand = require('./routes/demand');
const scheduleRoutes = require('./routes/schedule.js');
const adminWalletRoutes = require("./routes/adminWallet");
const userRoutes = require('./routes/user.js'); 
const { getPassengerBadge } = require('./utils/ratingUtils'); 
const adminDashboardRoutes = require('./routes/adminDashboard');
const adminDriverVerificationRoutes = require('./routes/adminDriverVerification');
const adsRoutes = require('./routes/ads.routes');
const ticketRoutes = require('./routes/tickets.routes');
const adminSupportRoutes = require('./routes/admin.support.routes');
const adminNotificationRoutes = require('./routes/admin.notification.routes');
const disputeRoutes = require('./routes/dispute.js');
const tollRouter = require('./routes/toll');


if (
  process.env.NODE_ENV === 'production' &&
  process.env.APP_ENV !== 'PRODUCTION'
) {
  console.error('❌ Non-production app cannot run with NODE_ENV=production');
  process.exit(1);
}


console.log(
  '🧪 SAFETY_TEST_MODE =',
  process.env.SAFETY_TEST_MODE
);

// --- DB Pool ---
const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     process.env.DB_PORT,
});

// Expose for routes that need them at runtime (MOVED THIS BLOCK UP)
global.pool = pool; // <--- Set global.pool BEFORE mounting routes
// io will be set after initSocketServer

// --- Express app ---
const app = express();
app.set('trust proxy', true);

const path = require('path');
const serviceAccount = require(path.join(__dirname, 'firebase-service-account-key.json'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

console.log('✅ Firebase Admin SDK initialized successfully!');

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'))
);

// Force connection close (fixes ngrok + Flutter)
app.use((req, res, next) => {
  res.setHeader('Connection', 'close');
  next();
});


app.use(cors());
app.use(express.json());
require('./scheduledNotification.job');

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
app.use('/api/admin', adminWalletRoutes);
app.use('/api/user', userRoutes); 
app.use('/api/admin', adminDashboardRoutes);
app.use('/api/admin', adminDriverVerificationRoutes);
app.use('/api/ads', adsRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/admin/support', require('./routes/admin.support.routes'));
app.use('/api/admin', require('./routes/admin.rides.routes'));
app.use('/api/admin', adminNotificationRoutes);
app.use('/api/admin', require('./routes/admin.payments.routes'));
app.use('/api/admin/driver-settlements', require('./Routes/driverSettlement.routes'));
app.use('/api/quote', require('./routes/quote'));
app.use('/api/dispute', disputeRoutes);
app.use('/api/toll', tollRouter);

// CORRECT:
//require('./cron_jobs');
const { isGstApplicable, roundedRupeesFromPaise } = require('./utils/tax'); // This import is correct

// function computeBaseFareINR(vehicleType, distanceKm) {
  // const vt = String(vehicleType || '').toUpperCase();
  // const base = vt === 'BIKE' ? 20 : vt === 'MINI' ? 40 : vt === 'SEDAN' ? 70 : vt === 'SUV' ? 100 : 40;
  // const perKm = vt === 'BIKE' ? 6 : vt === 'MINI' ? 10 : vt === 'SEDAN' ? 15 : vt === 'SUV' ? 20 : 10;
  // const km = Math.max(0, Number(distanceKm) || 0);
  // return Math.round((base + perKm * km) * 100) / 100;
// }

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
global.activeDrivers    = initSocketServer.getActiveDrivers();
global.activePassengers = initSocketServer.getActivePassengers();
initializeCronJobs(pool, io);



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
  try {
    const { startOfWeek, endOfWeek } = getWeekBounds();

    // 1. Existing Summary Logic (Totals)
    const currentWeekQuery = `
      SELECT type, SUM(amount_paise) AS total_paise
      FROM wallet_ledger
      WHERE driver_id = $1 AND created_at >= $2 AND created_at <= $3
        AND (type = 'CREDIT_ONLINE' OR type = 'CASH_RECEIVED' OR type = 'REFERRAL_BONUS')
      GROUP BY type;
    `;
    const summaryRes = await pool.query(currentWeekQuery, [driverId, startOfWeek, endOfWeek]);
    
    // 🎯 2. NEW: Get Referral List Logic
    const referralsQuery = `
       SELECT 
    wl.ride_external_id as "rideId",
    wl.amount_paise as amount,
    wl.is_settled as "isSettled",
    to_char(wl.created_at, 'DD Mon YYYY') as date,
    u.name as "passengerName"
  FROM wallet_ledger wl
  LEFT JOIN rides r ON r.external_id = wl.ride_external_id
  LEFT JOIN users u ON u.id = r.passenger_id
  WHERE wl.driver_id = $1 AND wl.type = 'REFERRAL_BONUS'
  ORDER BY wl.created_at DESC;
    `;
    const referralsRes = await pool.query(referralsQuery, [driverId]);

    let onlineEarningsPaise = 0;
    let cashLiabilityPaise = 0;
	let referralBonusPaise = 0;
    summaryRes.rows.forEach(row => {
      if (row.type === 'CREDIT_ONLINE') onlineEarningsPaise = parseInt(row.total_paise, 10);
      else if (row.type === 'CASH_RECEIVED') cashLiabilityPaise = parseInt(row.total_paise, 10);
	   else if (row.type === 'REFERRAL_BONUS') referralBonusPaise = parseInt(row.total_paise, 10);
    });

    const pastDuesResult = await pool.query(`
      SELECT SUM(CASE WHEN direction = 'CR' THEN amount_paise ELSE -amount_paise END) AS total_due_paise
      FROM wallet_ledger
      WHERE driver_id = $1 AND is_settled = FALSE AND created_at < $2;
    `, [driverId, startOfWeek]);

    res.json({
      onlineEarningsRupees: Math.round(onlineEarningsPaise / 100),
      cashLiabilityRupees: Math.round(cashLiabilityPaise / 100),
	    referralBonusRupees: Math.round(referralBonusPaise / 100), 
      netEarningsRupees: Math.round((onlineEarningsPaise - cashLiabilityPaise) / 100),
      previousDuesRupees: Math.round(Math.abs(parseInt(pastDuesResult.rows[0]?.total_due_paise || 0)) / 100),
      weekDisplay: `Week: ${startOfWeek.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} - ${endOfWeek.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`,
      // ✅ Referrals ki list yahan se jayegi
      referrals: referralsRes.rows 
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

// ✅ server.js mein ye daalo (Existing routes ke niche)
app.get('/api/passenger/free-ride-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Check in 'referrals' table
    const result = await pool.query(
      'SELECT first_ride_free_used FROM referrals WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Agar user referral list mein hi nahi hai, toh free ride nahi milegi
      return res.json({ canUseFreeRide: false,fareLimit: 700 });
    }

    const used = result.rows[0].first_ride_free_used; // true ya false
    
    res.json({ 
      canUseFreeRide: !used,  // Agar used false hai (f), toh canUseFreeRide true hoga
	  fareLimit: 700
    });
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/free-ride-payouts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pl.ride_external_id AS "rideId",
        pl.amount_paise AS "rideFarePaise",
        pl.is_settled AS "rideSettled",
        pl.created_at AS "date",
        -- Referral bonus for this same ride
        wl.amount_paise AS "referralBonusPaise",
        wl.is_settled AS "referralSettled",
        wl.driver_id AS "driverId",
        u.name AS "driverName",
        u.phone_number AS "driverPhone",
        (pl.amount_paise + COALESCE(wl.amount_paise, 0)) AS "totalOwedPaise"
      FROM platform_ledger pl
      LEFT JOIN wallet_ledger wl 
        ON wl.ride_external_id = pl.ride_external_id 
        AND wl.type = 'REFERRAL_BONUS'
      LEFT JOIN users u ON u.id = wl.driver_id
      WHERE pl.type = 'REFERRAL_SUBSIDY'
      ORDER BY pl.created_at DESC
    `);
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/free-ride-payouts/:rideId/mark-paid — dono ek saath settle karo
app.put('/api/admin/free-ride-payouts/:rideId/mark-paid', async (req, res) => {
  const { rideId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. platform_ledger mein REFERRAL_SUBSIDY settle karo
    await client.query(
      `UPDATE platform_ledger SET is_settled = TRUE, settled_at = NOW()
       WHERE ride_external_id = $1 AND type = 'REFERRAL_SUBSIDY'`,
      [rideId]
    );
    
    // 2. wallet_ledger mein REFERRAL_BONUS settle karo
    await client.query(
      `UPDATE wallet_ledger SET is_settled = TRUE, settled_at = NOW()
       WHERE ride_external_id = $1 AND type = 'REFERRAL_BONUS'`,
      [rideId]
    );
    
    await client.query('COMMIT');
    res.json({ success: true, message: 'Both ride fare and referral bonus marked as paid' });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/driver/referral-earnings/:driverId
app.get('/api/driver/referral-earnings/:driverId', async (req, res) => {
  const { driverId } = req.params;
  try {
    const result = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN is_settled = FALSE THEN amount_paise ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN is_settled = TRUE  THEN amount_paise ELSE 0 END), 0) AS paid
       FROM wallet_ledger
       WHERE driver_id = $1 AND type = 'REFERRAL_BONUS'`,
      [driverId]
    );
    res.json({
      pending: result.rows[0].pending,
      paid:    result.rows[0].paid,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

    // ✅✅✅ THIS IS THE FINAL, VICTORIOUS RATING FUNCTION ✅✅✅
    app.post('/api/ride/:rideId/rating', async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rideId: rideExternalId } = req.params;
        const { passengerId, driverId, rating, review, tags } = req.body;

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
		
		 if (Array.isArray(tags) && tags.length > 0) {
      for (const tag of tags) {
        await client.query(
          `
          INSERT INTO ride_rating_tags
            (ride_external_id, rated_by_role, tag_key, tag_value)
          VALUES
            ($1, 'PASSENGER', $2, $3)
          ON CONFLICT DO NOTHING
          `,
          [
            rideExternalId,
            tag.key,    // e.g. "driver_feedback"
            tag.value,  // e.g. "Polite behaviour"
          ]
        );
      }
    }
        
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

async function findDriverForRide(ride) {
  console.log(`[DISPATCHER] Initiating driver search for ride ${ride.external_id}`);
  
  // Use a database connection from the global pool
  const client = await global.pool.connect();
  
  try {
    // Step 1: Update the ride status to 'SEARCHING' immediately.
    // This prevents it from being dispatched again in the next cycle.
    await client.query(
      `UPDATE scheduled_rides SET status = 'SEARCHING' WHERE external_id = $1`,
      [ride.external_id]
    );

    // Step 2: Prepare the ride data to send to the driver.
    // We can add more details here later if needed.
    const rideRequestData = {
      rideId: ride.external_id,
      pickupAddress: ride.pickup_address,
      dropoffAddress: ride.dropoff_address,
      estimatedFare: ride.estimated_fare,
      scheduledPickupTime: ride.scheduled_pickup_time,
    };

    // Step 3: Emit a socket.io event to all connected drivers in the 'available_drivers' room.
    // ✅ CRITICAL FIX: Use `global.io` to access the initialized socket server instance.
    if (global.io) {
      global.io.to('available_drivers').emit('new-scheduled-ride-request', rideRequestData);
      console.log(`[DISPATCHER] Emitted ride request ${ride.external_id} to 'available_drivers' room.`);
    } else {
      console.error('[DISPATCHER] global.io is not initialized. Cannot emit socket event.');
    }

  } catch (e) {
    console.error(`[DISPATCHER] Error processing ride ${ride.external_id}:`, e);
    // If an error occurs, revert the status so the system can try again in the next minute.
    await client.query(
        `UPDATE scheduled_rides SET status = 'SCHEDULED' WHERE external_id = $1`,
        [ride.external_id]
    );
  } finally {
    // IMPORTANT: Always release the client back to the pool.
    client.release();
  }
}


// ✅✅✅ PASTE THIS ENTIRE NEW ENDPOINT INTO YOUR server.js FILE ✅✅✅

app.get('/api/drivers/:driverId/daily-summary', async (req, res) => {
  const { driverId } = req.params;
  const { date } = req.query;

  if (!driverId) {
    return res.status(400).json({ message: 'Driver ID is required' });
  }

  // IST-aware date bounds
  const targetDateStr = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const startIST = new Date(`${targetDateStr}T00:00:00+05:30`);
  const endIST   = new Date(`${targetDateStr}T23:59:59.999+05:30`);

  try {
    const client = await pool.connect();

    // ✅ Pull completed rides for the day, joining invoice for base+waiting breakdown
    const ridesQuery = `
      SELECT
    r.id,
    r.external_id,
    r.pickup_address,
    r.dropoff_address,
    r.final_fare,
    r.completed_at,
    r.payment_mode,
    COALESCE(ri.base_amount_paise, 0)  AS invoice_base,
    COALESCE(ri.waiting_amount, 0)     AS invoice_waiting,
    COALESCE(ri.extra_amount, 0)       AS invoice_extra,
	COALESCE(ri.toll_amount, 0)        AS invoice_toll,
    COALESCE(ri.actual_dropoff_address, '') AS actual_dropoff_address,
    COALESCE(ri.cgst_paise, 0)         AS invoice_cgst,
    COALESCE(ri.sgst_paise, 0)         AS invoice_sgst,
 
    COALESCE((
        SELECT SUM(pp.amount)
        FROM pending_payments pp
        WHERE pp.paid_in_ride_id = r.id
          AND pp.status = 'PAID'
    ), 0) AS penalty_amount
 
FROM rides r
LEFT JOIN ride_invoices ri ON ri.ride_external_id = r.external_id
    WHERE r.driver_id = $1
      AND r.status = 'COMPLETED'
      AND r.completed_at >= $2
      AND r.completed_at <= $3
    ORDER BY r.completed_at DESC
    `;

    const ridesResult = await client.query(ridesQuery, [driverId, startIST, endIST]);
    const rides = ridesResult.rows;

    // ✅ Also fetch actual wallet_ledger credits for this driver today
    // This is the ground truth — what was actually credited/debited
    const ledgerQuery = `
      SELECT
        wl.ride_external_id,
        wl.type,
        wl.direction,
        wl.amount_paise
      FROM wallet_ledger wl
      WHERE wl.driver_id = $1
        AND wl.created_at >= $2
        AND wl.created_at <= $3
        AND wl.type IN ('CREDIT_ONLINE', 'CASH_RECEIVED', 'WAITING_CREDIT')
    `;
    const ledgerResult = await client.query(ledgerQuery, [driverId, startIST, endIST]);

    // Index ledger rows by ride_external_id for easy lookup
    const ledgerByRide = {};
    for (const row of ledgerResult.rows) {
      if (!ledgerByRide[row.ride_external_id]) {
        ledgerByRide[row.ride_external_id] = { creditOnline: 0, cashReceived: 0, waitingCredit: 0 };
      }
      const amt = Number(row.amount_paise || 0);
      if (row.type === 'CREDIT_ONLINE')   ledgerByRide[row.ride_external_id].creditOnline  += amt;
      if (row.type === 'CASH_RECEIVED')   ledgerByRide[row.ride_external_id].cashReceived  += amt;
      if (row.type === 'WAITING_CREDIT')  ledgerByRide[row.ride_external_id].waitingCredit += amt;
    }

    let totalOnlineEarnings  = 0;
    let totalOfflineEarnings = 0;
    const onlineTransactions  = [];
    const offlineTransactions = [];

    for (const ride of rides) {
      const totalFare     = Number(ride.final_fare     || 0);
      const invoiceBase   = Number(ride.invoice_base   || 0); // base fare (pre-GST, excl. waiting)
      const invoiceWaiting= Number(ride.invoice_waiting|| 0); // waiting charges (no GST)
	   const invoiceExtra   = Number(ride.invoice_extra   || 0); 
	    const invoiceToll = Number(ride.invoice_toll || 0); 
      const invoiceCgst   = Number(ride.invoice_cgst   || 0);
      const invoiceSgst   = Number(ride.invoice_sgst   || 0);
	   const actualDropoff  = ride.actual_dropoff_address || null;

      const gstAmount = invoiceCgst + invoiceSgst;
const roundedBase       = Math.round(invoiceBase);           // align with what UI displays
const driverBaseShare   = Math.round(roundedBase * 0.97);    // e.g. Math.round(217*0.97) = 210
const platformBaseShare = roundedBase - driverBaseShare;     // 217 - 210 = 7 (exact, no float loss)
const driverShare       = driverBaseShare + invoiceWaiting + invoiceExtra + invoiceToll;
const companyCommission = platformBaseShare;     

    const ledger = ledgerByRide[ride.external_id] || {};
const isOnline = ride.payment_mode === 'ONLINE' || ledger.creditOnline > 0;

      const transactionDetail = {
        rideId:           ride.external_id,
        from:             ride.pickup_address,
        to:               ride.dropoff_address,
        totalFare:        totalFare,          // what passenger paid
		 actualDropoffAddress: actualDropoff, 
        invoiceBase:      invoiceBase,        // base fare pre-GST
        waitingCharges:   invoiceWaiting,     // waiting (no GST, 100% driver)
		extraDistanceCharges: invoiceExtra, 
		penaltyAmount: Number(ride.penalty_amount), 
        gstAmount:        gstAmount,          // GST on base only
        companyCommission:companyCommission,  // 3% of base
		tollCharges: invoiceToll,
        driverShare:      driverShare,        // 97% base + 100% waiting ✅
        // Ground-truth from ledger (what was actually written)
        actualCredited:   isOnline
                            ? (ledger.creditOnline  || driverShare)
                            : (ledger.cashReceived  || companyCommission), // for cash this is commission owed
        waitingCredited:  ledger.waitingCredit || 0,
      };

      if (isOnline) {
        // ✅ Online: driver actually receives 97% base + 100% waiting in wallet
      const actualDriverEarning = ledger.creditOnline || 0;
        totalOnlineEarnings += actualDriverEarning;
        onlineTransactions.push(transactionDetail);
      } else {
        // ✅ Offline/Cash: driver collected full cash, owes 3% commission to company
        // Show total cash collected (what driver has in hand = full fare)
        // Net after paying commission = totalFare - companyCommission
        totalOfflineEarnings += driverShare;
        offlineTransactions.push(transactionDetail);
      }
    }

    client.release();

    res.json({
      summaryDate: targetDateStr,
      totalRides:  rides.length,
      // ✅ Total shown = online credited to wallet + offline cash in hand
      totalEarnings: totalOnlineEarnings + totalOfflineEarnings,
      online: {
        totalAmount:  totalOnlineEarnings,  // 97% base + 100% waiting, actual wallet credit
        count:        onlineTransactions.length,
        transactions: onlineTransactions,
      },
      offline: {
        totalAmount:  totalOfflineEarnings, // full cash collected (driver owes 3% base back)
        count:        offlineTransactions.length,
        transactions: offlineTransactions,
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

async function reconcileStateOnStartup() {
  console.log('🔄 Reconciling system state after restart');

  await pool.query(`
    UPDATE rides
    SET status = 'COMPLETED'
    WHERE status IN ('IN_TRANSIT')
      AND completed_at IS NOT NULL
  `);
}

// --- Listen ---
const PORT = process.env.PORT || 3000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});