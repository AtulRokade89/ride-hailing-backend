// // In cron_jobs.js
// const cron = require('node-cron');
// const { findDriverForRide } = require('./utils/dispatcher');
// const startScheduledNotificationJob=require('./scheduledNotification.job');

// // ✅ EXPORT a function that takes the dependencies it needs (pool, io)
// function initializeCronJobs(pool, io) {
	  // console.log('Initializing cron jobs...');
	  // startScheduledNotificationJob(pool);
	 // cron.schedule('*/5 * * * *', async () => {
    // console.log(`[CRON-HEADSUP] Checking for rides needing an early warning...`);
    // if (!pool || !io) {
      // console.error('[CRON-HEADSUP] Cron job failed: Pool or IO not initialized.');
      // return;
    // }
    // const client = await pool.connect();
    // try {
      // // Find rides that are between 60 and 70 minutes away AND have NOT been notified yet.
      // const { rows: ridesForHeadsUp } = await client.query(
        // `SELECT * FROM scheduled_rides
         // WHERE status in('SCHEDULED')
           // AND is_pre_notified = FALSE  -- The important new condition
           // AND scheduled_pickup_time >= NOW() + INTERVAL '60 minutes'
           // AND scheduled_pickup_time < NOW() + INTERVAL '70 minutes'`
      // );

      // if (ridesForHeadsUp.length > 0) {
        // console.log(`[CRON-HEADSUP] Found ${ridesForHeadsUp.length} ride(s) to send early warnings for.`);
        // for (const ride of ridesForHeadsUp) {
          // // 1. Find a suitable nearby driver (you can reuse parts of findDriverForRide).
          // //    For now, let's assume you have a function `findBestDriverForHeadsUp(ride)`.
          // const driverId = await findBestDriverForHeadsUp(ride, pool); // Placeholder for driver finding logic

          // if (driverId) {
            // // 2. Send the notification to that specific driver.
            // const driverSocketId = global.activeDrivers[driverId]?.socketId;
            // if (driverSocketId) {
              // const pickupTime = new Date(ride.scheduled_pickup_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute:'2-digit' });
              // io.to(driverSocketId).emit('scheduledRideHeadsUp', {
                // message: `You have an upcoming scheduled ride at ${pickupTime}. Please be online and ready.`
              // });
              // console.log(`[CRON-HEADSUP] Sent early warning to driver ${driverId} for ride ${ride.id}`);

              // // 3. Mark the ride as notified to prevent re-sending.
              // await client.query(
                // 'UPDATE scheduled_rides SET is_pre_notified = TRUE WHERE id = $1',
                // [ride.id]
              // );
            // }
          // }
        // }
      // }
    // } catch (e) {
      // console.error('[CRON-HEADSUP] Error during heads-up cycle:', e);
    // } finally {
      // client.release();
    // }
  // });
  // // ✅ --- END: NEW "HEADS-UP" CRON JOB --- ✅


 // cron.schedule('*/1 * * * *', async () => {
    // console.log(`[CRON-DISPATCH] Checking for upcoming scheduled rides...`);
    // if (!pool || !io) {
      // console.error('[CRON-DISPATCH] Cron job failed: Pool or IO not initialized.');
      // return;
    // }
    // const client = await pool.connect();
    // try {
      // // --- ✅ START OF THE FINAL, CORRECTED QUERY ✅ ---
      // // This logic is simple, robust, and time zone aware.

      // const queryText = `
       // SELECT
  // *,
  // ST_Y(pickup_location::geometry) AS pickup_lat,
  // ST_X(pickup_location::geometry) AS pickup_lng
// FROM scheduled_rides
// WHERE
  // status = 'SCHEDULED'
  // AND is_locked = FALSE
  // AND scheduled_pickup_time <= (NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '15 minutes'
  // AND scheduled_pickup_time > (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '5 minutes'
      // `;
      // // --- ✅ END OF THE FINAL, CORRECTED QUERY ✅ ---

      // console.log(`[CRON-DISPATCH] Executing query: ${queryText.trim()}`);
      // const { rows: upcomingRides } = await client.query(queryText);

      // if (upcomingRides.length > 0) {
        // console.log(`[CRON-DISPATCH] ✅ SUCCESS: Found ${upcomingRides.length} ride(s) to dispatch.`);
        // for (const ride of upcomingRides) {
          // // This will now correctly find your ride at the right time.
          // await findDriverForRide(ride, pool, io);
        // }
      // } else {
        // console.log(`[CRON-DISPATCH] No rides found in the current dispatch window.`);
      // }
    // } catch (e) {
      // console.error('[CRON-DISPATCH] FATAL: Error during dispatch cycle:', e);
    // } finally {
      // client.release();
    // }
// });

  // // This job runs every 3 hours
  // cron.schedule('0 */3 * * *', async () => {
    // console.log('Running job: Send settlement reminders...');
    // if (!pool || !io) {
      // console.error('Cron job failed: Pool or IO not initialized.');
      // return;
    // }

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
    // if (!pool) {
      // console.error('Cron job failed: Pool not initialized.');
      // return;
    // }

    // try {
      // const { rows } = await pool.query(
          // `UPDATE drivers
           // SET is_blocked = TRUE
           // WHERE user_id IN (
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
// }

// // ✅ Export the setup function
// module.exports = initializeCronJobs;


// cron_jobs.js
const cron = require('node-cron');
const { findDriverForRide } = require('./utils/dispatcher');
const startScheduledNotificationJob = require('./scheduledNotification.job');
const initSocketServer = require('./socket');
const { sendNotificationToUser } = require('./services/notification_sender');

function initializeCronJobs(pool, io) {
  console.log('Initializing cron jobs...');
  startScheduledNotificationJob(pool);


  // ─────────────────────────────────────────────────────────────────────────
  // EXISTING: Scheduled ride heads-up (every 5 min)
  // ─────────────────────────────────────────────────────────────────────────
  cron.schedule('*/5 * * * *', async () => {
    console.log(`[CRON-HEADSUP] Checking for rides needing an early warning...`);
    if (!pool || !io) {
      console.error('[CRON-HEADSUP] Cron job failed: Pool or IO not initialized.');
      return;
    }
    const client = await pool.connect();
    try {
      const { rows: ridesForHeadsUp } = await client.query(
        `SELECT * FROM scheduled_rides
         WHERE status in('SCHEDULED')
           AND is_pre_notified = FALSE
           AND scheduled_pickup_time >= NOW() + INTERVAL '60 minutes'
           AND scheduled_pickup_time < NOW() + INTERVAL '70 minutes'`
      );

      if (ridesForHeadsUp.length > 0) {
        console.log(`[CRON-HEADSUP] Found ${ridesForHeadsUp.length} ride(s) to send early warnings for.`);
        for (const ride of ridesForHeadsUp) {
          const driverId = await findBestDriverForHeadsUp(ride, pool);

          if (driverId) {
            const driverSocketId = global.activeDrivers[driverId]?.socketId;
            if (driverSocketId) {
              const pickupTime = new Date(ride.scheduled_pickup_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
              io.to(driverSocketId).emit('scheduledRideHeadsUp', {
                message: `You have an upcoming scheduled ride at ${pickupTime}. Please be online and ready.`
              });
              console.log(`[CRON-HEADSUP] Sent early warning to driver ${driverId} for ride ${ride.id}`);

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


  // ─────────────────────────────────────────────────────────────────────────
  // EXISTING: Scheduled ride dispatch (every 1 min)
  // ─────────────────────────────────────────────────────────────────────────
  cron.schedule('*/1 * * * *', async () => {
    console.log(`[CRON-DISPATCH] Checking for upcoming scheduled rides...`);
    if (!pool || !io) {
      console.error('[CRON-DISPATCH] Cron job failed: Pool or IO not initialized.');
      return;
    }
    const client = await pool.connect();
    try {
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

      console.log(`[CRON-DISPATCH] Executing query: ${queryText.trim()}`);
      const { rows: upcomingRides } = await client.query(queryText);

      if (upcomingRides.length > 0) {
        console.log(`[CRON-DISPATCH] ✅ SUCCESS: Found ${upcomingRides.length} ride(s) to dispatch.`);
        for (const ride of upcomingRides) {
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


  // ─────────────────────────────────────────────────────────────────────────
  // EXISTING: Settlement reminders (every 3 hours)
  // ─────────────────────────────────────────────────────────────────────────
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


  // ─────────────────────────────────────────────────────────────────────────
  // EXISTING: Block overdue drivers (daily midnight)
  // ─────────────────────────────────────────────────────────────────────────
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
    } catch (e) {
      console.error('Blocking job failed:', e);
    }
  });


  // ─────────────────────────────────────────────────────────────────────────
  // NEW: Dispute 15-min auto-escalate (every 1 min)
  //
  // Agar dono parties ne 15 min mein respond nahi kiya →
  // OPEN → PENDING_ADMIN_REVIEW
  // ─────────────────────────────────────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      // Fetch all OPEN disputes jinka auto_resolve_at time nikal gaya
      const { rows: expiredDisputes } = await client.query(
        `SELECT id, ride_external_id, ride_type,
                partial_fare, driver_accepted, passenger_accepted
         FROM ride_disputes
         WHERE status = 'OPEN'
           AND auto_resolve_at <= NOW()`
      );

      if (expiredDisputes.length === 0) return;

      console.log(`[CRON-DISPUTE-15MIN] Found ${expiredDisputes.length} dispute(s) to auto-escalate.`);

      for (const dispute of expiredDisputes) {

        // Dono ne accept kiya tha? (edge case — respond endpoint se miss hua)
        const bothAccepted =
          dispute.driver_accepted === true && dispute.passenger_accepted === true;

        if (bothAccepted) {
          // Auto resolve — partial fare final
          await client.query(
            `UPDATE ride_disputes
             SET status     = 'AUTO_RESOLVED',
                 final_fare = partial_fare,
                 resolved_at= NOW(),
                 resolved_by= 'system'
             WHERE id = $1`,
            [dispute.id]
          );

          const rideTable = dispute.ride_type === 'SCHEDULED'
            ? 'scheduled_rides' : 'rides';

          await client.query(
            `UPDATE ${rideTable}
             SET status     = 'PARTIAL_COMPLETE',
                 final_fare = $1
             WHERE external_id = $2`,
            [dispute.partial_fare, dispute.ride_external_id]
          );

          console.log(`[CRON-DISPUTE-15MIN] Dispute #${dispute.id} AUTO_RESOLVED (both accepted).`);

        } else {
          // Koi bhi fully agree nahi kiya → admin queue
          await client.query(
            `UPDATE ride_disputes
             SET status = 'PENDING_ADMIN_REVIEW'
             WHERE id = $1`,
            [dispute.id]
          );

          console.log(`[CRON-DISPUTE-15MIN] Dispute #${dispute.id} escalated → PENDING_ADMIN_REVIEW.`);

          // Dono ko notify karo
          await _disputeNotifyBothFromRide(
            pool,
            dispute.ride_external_id,
            dispute.ride_type,
            dispute.id,
            {
              title  : 'Dispute Escalated to Admin',
              body   : 'Time window expired. Your dispute has been sent to admin for review. Decision within 48 hours.',
              type   : 'DISPUTE_ESCALATED',
            }
          );
        }
      }
    } catch (e) {
      console.error('[CRON-DISPUTE-15MIN] Error:', e);
    } finally {
      client.release();
    }
  });


  // ─────────────────────────────────────────────────────────────────────────
  // NEW: Dispute 48-hr admin timeout (every 1 hour)
  //
  // Agar admin ne 48 hr mein resolve nahi kiya →
  // System auto-close karta hai:
  //   → Driver ko partial_fare credit (ADJUSTMENT)
  //   → Passenger ko pending_payment entry
  //   → TIMEOUT_RESOLVED
  // ─────────────────────────────────────────────────────────────────────────
  cron.schedule('0 * * * *', async () => {
    if (!pool) return;
    const client = await pool.connect();
    try {
      const { rows: timedOutDisputes } = await client.query(
        `SELECT id, ride_external_id, ride_type, partial_fare
         FROM ride_disputes
         WHERE status = 'PENDING_ADMIN_REVIEW'
           AND admin_deadline_at <= NOW()`
      );

      if (timedOutDisputes.length === 0) return;

      console.log(`[CRON-DISPUTE-48HR] Found ${timedOutDisputes.length} dispute(s) timed out.`);

      for (const dispute of timedOutDisputes) {
        // Fetch ride for driver_id + passenger_id
        let ride = null;
        if (dispute.ride_type === 'SCHEDULED') {
          const { rows } = await client.query(
            `SELECT passenger_id, driver_id FROM scheduled_rides WHERE external_id = $1`,
            [dispute.ride_external_id]
          );
          ride = rows[0];
        } else {
          const { rows } = await client.query(
            `SELECT passenger_id, driver_id, payment_mode FROM rides WHERE external_id = $1`,
            [dispute.ride_external_id]
          );
          ride = rows[0];
        }

        if (!ride || !ride.driver_id) {
          console.error(`[CRON-DISPUTE-48HR] Ride not found for dispute #${dispute.id}`);
          continue;
        }

        const partialFare = Number(dispute.partial_fare) || 0;

// Ledger columns are bigint but your app stores rupees there,
// so keep rupees, just make them whole integers.
const ledgerFare = Math.round(partialFare);
const driverShare = Math.round(ledgerFare * 0.97);
const platformShare = ledgerFare - driverShare;
console.log(`[CRON-DISPUTE-48HR] Dispute #${dispute.id} → TIMEOUT_RESOLVED. Driver ₹${driverShare} credited.`);

        try {
          // ── A. Driver wallet credit ──────────────────────────────────────
          await client.query(
            `INSERT INTO wallet_ledger
               (driver_id, ride_external_id, type, direction, amount_paise, note)
             VALUES ($1, $2, 'ADJUSTMENT', 'CR', $3, $4)
             ON CONFLICT (driver_id, ride_external_id, type) DO NOTHING`,
            [
              ride.driver_id,
              dispute.ride_external_id,
              driverShare,
              `Dispute timeout auto-credit (dispute #${dispute.id})`,
            ]
          );

          // ── B. Driver wallet balance ─────────────────────────────────────
          await client.query(
            `INSERT INTO driver_wallets (driver_id, balance_paise)
             VALUES ($1, $2)
             ON CONFLICT (driver_id)
             DO UPDATE SET
               balance_paise = driver_wallets.balance_paise + EXCLUDED.balance_paise,
               updated_at    = NOW()`,
            [ride.driver_id, driverShare]
          );

          // ── C. Platform ledger ───────────────────────────────────────────
          await client.query(
            `INSERT INTO platform_ledger
               (ride_external_id, type, direction, amount_paise, note)
             VALUES ($1, 'ONLINE_COMMISSION', 'CR', $2, $3)
             ON CONFLICT (ride_external_id, type) DO NOTHING`,
            [
              dispute.ride_external_id,
              platformShare,
              `Dispute timeout commission (dispute #${dispute.id})`,
            ]
          );

          // ── D. Passenger pending payment ─────────────────────────────────
          await client.query(
            `INSERT INTO pending_payments
               (user_id, ride_id, driver_id, amount, status, source_type)
             VALUES (
               $1,
               (SELECT id FROM rides WHERE external_id = $2 LIMIT 1),
               $3,
               $4,
               'PENDING',
               'DISPUTE_RECOVERY'
             )
             ON CONFLICT DO NOTHING`,
            [
              ride.passenger_id,
              dispute.ride_external_id,
              ride.driver_id,
              partialFare,
            ]
          );

          // ── E. Mark dispute TIMEOUT_RESOLVED ────────────────────────────
          await client.query(
            `UPDATE ride_disputes
             SET status      = 'TIMEOUT_RESOLVED',
                 final_fare  = $1,
                 resolved_at = NOW(),
                 resolved_by = 'timeout',
                 admin_notes = 'Auto-resolved after 48hr admin timeout. Partial fare credited to driver.'
             WHERE id = $2`,
            [partialFare, dispute.id]
          );

          // ── F. Ride → PARTIAL_COMPLETE ───────────────────────────────────
          const rideTable = dispute.ride_type === 'SCHEDULED'
            ? 'scheduled_rides' : 'rides';

          await client.query(
            `UPDATE ${rideTable}
             SET status     = 'PARTIAL_COMPLETE',
                 final_fare = $1
             WHERE external_id = $2`,
            [partialFare, dispute.ride_external_id]
          );

          console.log(`[CRON-DISPUTE-48HR] Dispute #${dispute.id} → TIMEOUT_RESOLVED. Driver ₹${driverShare} credited.`);

          // ── G. Notify both parties ───────────────────────────────────────
          await _disputeNotifyBothFromRide(
            pool,
            dispute.ride_external_id,
            dispute.ride_type,
            dispute.id,
            {
              title: 'Dispute Auto-Resolved',
              body : `Your dispute was auto-resolved after 48 hours. Final fare ₹${partialFare} has been settled.`,
              type : 'DISPUTE_TIMEOUT_RESOLVED',
            }
          );

        } catch (innerErr) {
          // One dispute fail hone se baaki dispute process nahi rukne chahiye
          console.error(`[CRON-DISPUTE-48HR] Failed for dispute #${dispute.id}:`, innerErr.message);
        }
      }
    } catch (e) {
      console.error('[CRON-DISPUTE-48HR] Error:', e);
    } finally {
      client.release();
    }
  });

}


// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Fetch ride parties and notify via socket + push
// Used by both dispute cron jobs above
// ─────────────────────────────────────────────────────────────────────────────
async function _disputeNotifyBothFromRide(pool, rideExternalId, rideType, disputeId, { title, body, type }) {
  try {
    let ride = null;
    if (rideType === 'SCHEDULED') {
      const { rows } = await pool.query(
        `SELECT passenger_id, driver_id FROM scheduled_rides WHERE external_id = $1`,
        [rideExternalId]
      );
      ride = rows[0];
    } else {
      const { rows } = await pool.query(
        `SELECT passenger_id, driver_id FROM rides WHERE external_id = $1`,
        [rideExternalId]
      );
      ride = rows[0];
    }

    if (!ride) return;

    // Socket
    try {
      const io            = initSocketServer.getIo();
      const activeDrivers = initSocketServer.getActiveDrivers();
      const dSock         = activeDrivers[String(ride.driver_id)]?.socketId;

      const socketPayload = {
  disputeId,
  rideExternalId,
  type,
  resolution:
    type === 'DISPUTE_TIMEOUT_RESOLVED'
      ? 'TIMEOUT_RESOLVED'
      : 'PENDING_ADMIN_REVIEW',
};
      if (dSock) io.to(dSock).emit('disputeResolved', socketPayload);
      io.to(`passenger:${ride.passenger_id}`).emit('disputeResolved', socketPayload);
    } catch (se) {
      console.error(`[DISPUTE-NOTIFY] Socket failed for dispute #${disputeId}:`, se.message);
    }

    // Push notifications
    const meta = { type, rideId: rideExternalId, disputeId: String(disputeId) };
    await sendNotificationToUser(ride.driver_id,    title, body, meta).catch(() => {});
    await sendNotificationToUser(ride.passenger_id, title, body, meta).catch(() => {});

  } catch (e) {
    console.error(`[DISPUTE-NOTIFY] Failed for dispute #${disputeId}:`, e.message);
  }
}


module.exports = initializeCronJobs;