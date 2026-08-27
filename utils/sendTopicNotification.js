const admin = require('firebase-admin');

module.exports = async function sendTopicNotification(n) {
  const topics = [];

  if (n.target_role === 'PASSENGER') topics.push('PASSENGER');
  if (n.target_role === 'DRIVER') topics.push('DRIVER');
  if (n.target_role === 'ALL') topics.push('PASSENGER', 'DRIVER');

  for (const topic of topics) {
    console.log('📤 Sending ADMIN notification to topic:', topic);

    await admin.messaging().send({
      topic,

      // ✅ THIS IS CRITICAL (system tray)
      notification: {
        title: n.title,
        body: n.body,
      },

      android: {
        priority: 'high',
        notification: {
          channelId: 'ride_updates', // 🔥 MUST MATCH FLUTTER
        },
      },

      data: {
        type: 'ADMIN_BROADCAST',
        notificationId: n.id,
        sentAt: Date.now().toString(),
      },
    });
  }

  await global.pool.query(
    `UPDATE admin_notifications SET status='SENT' WHERE id=$1`,
    [n.id]
  );
};