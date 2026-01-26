// const cron = require('node-cron');
// const pool = require('./db').pool;


// // This job runs every 3 hours
// cron.schedule('0 */3 * * *', async () => {
  // console.log('Running job: Send settlement reminders...');
  // const io = require('./socket').getIo(); // Get the socket.io instance

  // try {
    // const { rows } = await pool.query(
      // `SELECT driver_id, SUM(amount_paise) as total_due, MIN(due_date) as first_due_date
       // FROM wallet_ledger
       // WHERE is_settled = FALSE AND type = 'CASH_RECEIVED'
       // GROUP BY driver_id`
    // );

    // for (const driver of rows) {
      // const remainingDays = Math.ceil((new Date(driver.first_due_date) - Date.now()) / (1000 * 60 * 60 * 24));
      // if (remainingDays > 0) {
        // const dSock = global.activeDrivers[driver.driver_id]?.socketId;
        // if (dSock) {
          // io.to(dSock).emit('settlementReminder', {
            // message: `You have a pending due of ₹${driver.total_due}. Please settle within ${remainingDays} days.`,
          // });
        // }
      // }
    // }
  // } catch (e) {
    // console.error('Reminder job failed:', e);
  // }
// });

// // This job runs once a day (e.g., at midnight) to block overdue drivers
// cron.schedule('0 0 * * *', async () => {
  // console.log('Running job: Block overdue drivers...');

  // try {
    // const { rows } = await pool.query(
        // `UPDATE drivers
         // SET is_blocked = TRUE
         // WHERE id IN (
             // SELECT DISTINCT driver_id
             // FROM wallet_ledger
             // WHERE is_settled = FALSE AND due_date < NOW()
         // )`
    // );
    // console.log(`Blocked ${rows.rowCount} overdue drivers.`);
  // } catch(e) {
    // console.error('Blocking job failed:', e);
  // }
// });



// In cron_jobs.js
const cron = require('node-cron');
const { findDriverForRide } = require('./utils/dispatcher');

// ✅ EXPORT a function that takes the dependencies it needs (pool, io)
function initializeCronJobs(pool, io) {
	  console.log('Initializing cron jobs...');
	 cron.schedule('*/5 * * * *', async () => {
    console.log(`[CRON-HEADSUP] Checking for rides needing an early warning...`);
    if (!pool || !io) {
      console.error('[CRON-HEADSUP] Cron job failed: Pool or IO not initialized.');
      return;
    }
    const client = await pool.connect();
    try {
      // Find rides that are between 60 and 70 minutes away AND have NOT been notified yet.
      const { rows: ridesForHeadsUp } = await client.query(
        `SELECT * FROM scheduled_rides
         WHERE status in('SCHEDULED')
           AND is_pre_notified = FALSE  -- The important new condition
           AND scheduled_pickup_time >= NOW() + INTERVAL '60 minutes'
           AND scheduled_pickup_time < NOW() + INTERVAL '70 minutes'`
      );

      if (ridesForHeadsUp.length > 0) {
        console.log(`[CRON-HEADSUP] Found ${ridesForHeadsUp.length} ride(s) to send early warnings for.`);
        for (const ride of ridesForHeadsUp) {
          // 1. Find a suitable nearby driver (you can reuse parts of findDriverForRide).
          //    For now, let's assume you have a function `findBestDriverForHeadsUp(ride)`.
          const driverId = await findBestDriverForHeadsUp(ride, pool); // Placeholder for driver finding logic

          if (driverId) {
            // 2. Send the notification to that specific driver.
            const driverSocketId = global.activeDrivers[driverId]?.socketId;
            if (driverSocketId) {
              const pickupTime = new Date(ride.scheduled_pickup_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute:'2-digit' });
              io.to(driverSocketId).emit('scheduledRideHeadsUp', {
                message: `You have an upcoming scheduled ride at ${pickupTime}. Please be online and ready.`
              });
              console.log(`[CRON-HEADSUP] Sent early warning to driver ${driverId} for ride ${ride.id}`);

              // 3. Mark the ride as notified to prevent re-sending.
              await client.query(
                'UPDATE scheduled_rides SET is_pre_notified = TRUE WHERE id = $1',
                [ride.id]
              );
            }
          }
        }
      }
    } catch (e) {
      console.error('[CRON-HEADSUP] Error during heads-up cycle:', e);
    } finally {
      client.release();
    }
  });
  // ✅ --- END: NEW "HEADS-UP" CRON JOB --- ✅


 cron.schedule('*/1 * * * *', async () => {
    console.log(`[CRON-DISPATCH] Checking for upcoming scheduled rides...`);
    if (!pool || !io) {
      console.error('[CRON-DISPATCH] Cron job failed: Pool or IO not initialized.');
      return;
    }
    const client = await pool.connect();
    try {
      // --- ✅ START OF THE FINAL, CORRECTED QUERY ✅ ---
      // This logic is simple, robust, and time zone aware.

      const queryText = `
       SELECT
  *,
  ST_Y(pickup_location::geometry) AS pickup_lat,
  ST_X(pickup_location::geometry) AS pickup_lng
FROM scheduled_rides
WHERE
  status = 'SCHEDULED'
  AND is_locked = FALSE
  AND scheduled_pickup_time <= (NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '15 minutes'
  AND scheduled_pickup_time > (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '5 minutes'
      `;
      // --- ✅ END OF THE FINAL, CORRECTED QUERY ✅ ---

      console.log(`[CRON-DISPATCH] Executing query: ${queryText.trim()}`);
      const { rows: upcomingRides } = await client.query(queryText);

      if (upcomingRides.length > 0) {
        console.log(`[CRON-DISPATCH] ✅ SUCCESS: Found ${upcomingRides.length} ride(s) to dispatch.`);
        for (const ride of upcomingRides) {
          // This will now correctly find your ride at the right time.
          await findDriverForRide(ride, pool, io);
        }
      } else {
        console.log(`[CRON-DISPATCH] No rides found in the current dispatch window.`);
      }
    } catch (e) {
      console.error('[CRON-DISPATCH] FATAL: Error during dispatch cycle:', e);
    } finally {
      client.release();
    }
});

  // This job runs every 3 hours
  cron.schedule('0 */3 * * *', async () => {
    console.log('Running job: Send settlement reminders...');
    if (!pool || !io) {
      console.error('Cron job failed: Pool or IO not initialized.');
      return;
    }

    try {
      const { rows } = await pool.query(
        `SELECT driver_id, SUM(amount_paise) as total_due, MIN(due_date) as first_due_date
         FROM wallet_ledger
         WHERE is_settled = FALSE AND type = 'CASH_RECEIVED'
         GROUP BY driver_id`
      );

      for (const driver of rows) {
        const remainingDays = Math.ceil((new Date(driver.first_due_date) - Date.now()) / (1000 * 60 * 60 * 24));
        if (remainingDays > 0) {
          const dSock = global.activeDrivers[driver.driver_id]?.socketId;
          if (dSock) {
            io.to(dSock).emit('settlementReminder', {
              message: `You have a pending due of ₹${driver.total_due}. Please settle within ${remainingDays} days.`,
            });
          }
        }
      }
    } catch (e) {
      console.error('Reminder job failed:', e);
    }
  });

  // This job runs once a day (e.g., at midnight) to block overdue drivers
  cron.schedule('0 0 * * *', async () => {
    console.log('Running job: Block overdue drivers...');
    if (!pool) {
      console.error('Cron job failed: Pool not initialized.');
      return;
    }

    try {
      const { rows } = await pool.query(
          `UPDATE drivers
           SET is_blocked = TRUE
           WHERE user_id IN (
               SELECT DISTINCT driver_id
               FROM wallet_ledger
               WHERE is_settled = FALSE AND due_date < NOW()
           )`
      );
      console.log(`Blocked ${rows.rowCount} overdue drivers.`);
    } catch(e) {
      console.error('Blocking job failed:', e);
    }
  });
}

// ✅ Export the setup function
module.exports = initializeCronJobs;

