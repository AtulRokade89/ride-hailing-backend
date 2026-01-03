// cron_jobs.js
const cron = require('node-cron');
const { findDriverForRide } = require('./utils/dispatcher');

function initializeCronJobs(pool, io) {
  console.log('Initializing cron jobs...');

  /**
   * ==========================================
   * 1️⃣ DISPATCH SCHEDULED RIDES (EVERY MINUTE)
   * ==========================================
   */
  cron.schedule('*/1 * * * *', async () => {
    console.log('[CRON-DISPATCH] Checking for upcoming scheduled rides...');

    if (!pool || !io) {
      console.error('[CRON-DISPATCH] Pool or IO not initialized.');
      return;
    }

    const client = await pool.connect();
    try {
      const query = `
        SELECT *
        FROM scheduled_rides
        WHERE status = 'SCHEDULED'
          AND scheduled_pickup_time <= NOW() + INTERVAL '15 minutes'
          AND scheduled_pickup_time > NOW() - INTERVAL '5 minutes'
      `;

      const { rows } = await client.query(query);

      if (rows.length === 0) {
        console.log('[CRON-DISPATCH] No rides to dispatch.');
        return;
      }

      console.log(`[CRON-DISPATCH] Found ${rows.length} ride(s).`);

      for (const ride of rows) {
        await findDriverForRide(ride, pool, io);
      }
    } catch (err) {
      console.error('[CRON-DISPATCH] Error:', err.message);
    } finally {
      client.release();
    }
  });

  /**
   * ==========================================
   * 2️⃣ SETTLEMENT REMINDERS (EVERY 3 HOURS)
   * ==========================================
   */
  cron.schedule('0 */3 * * *', async () => {
    console.log('[CRON-SETTLEMENT] Checking driver dues...');

    if (!pool || !io) return;

    try {
      const { rows } = await pool.query(`
        SELECT driver_id,
               SUM(amount_paise) AS total_due,
               MIN(due_date) AS first_due_date
        FROM wallet_ledger
        WHERE is_settled = FALSE
          AND type = 'CASH_RECEIVED'
        GROUP BY driver_id
      `);

      for (const row of rows) {
        const socketId = global.activeDrivers?.[row.driver_id]?.socketId;
        if (socketId) {
          io.to(socketId).emit('settlementReminder', {
            message: `You have pending dues of ₹${row.total_due}. Please settle soon.`,
          });
        }
      }
    } catch (err) {
      console.error('[CRON-SETTLEMENT] Error:', err.message);
    }
  });

  /**
   * ==========================================
   * 3️⃣ BLOCK OVERDUE DRIVERS (DAILY)
   * ==========================================
   */
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON-BLOCK] Blocking overdue drivers...');

    if (!pool) return;

    try {
      await pool.query(`
        UPDATE drivers
        SET is_blocked = TRUE
        WHERE user_id IN (
          SELECT DISTINCT driver_id
          FROM wallet_ledger
          WHERE is_settled = FALSE
            AND due_date < NOW()
        )
      `);
    } catch (err) {
      console.error('[CRON-BLOCK] Error:', err.message);
    }
  });
}

module.exports = initializeCronJobs;
