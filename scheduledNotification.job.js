const cron = require('node-cron');
const sendTopicNotification = require('./utils/sendTopicNotification');

module.exports = function startScheduledNotificationJob(pool) {
  cron.schedule('* * * * *', async () => {
    const { rows } = await pool.query(`
      SELECT * FROM admin_notifications
      WHERE send_type='SCHEDULED'
        AND status='PENDING'
        AND scheduled_at <= NOW()
    `);

    for (const n of rows) {
      await sendTopicNotification(n);

      await pool.query(
        `UPDATE admin_notifications
         SET status='SENT', sent_at=NOW()
         WHERE id=$1`,
        [n.id]
      );
    }
  });
};