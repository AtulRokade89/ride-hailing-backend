const admin = require('firebase-admin');

function channelFor(type) {
  if (type === 'NEW_RIDE') return 'ride_requests';
  return 'ride_updates';
}

async function sendNotificationToUser(userId, title, body, data = {}) {
  let fcmToken;

  try {
    const tokenQuery = await pool.query(
      'SELECT fcm_token FROM fcm_tokens WHERE user_id = $1',
      [userId]
    );

    fcmToken = tokenQuery.rows[0]?.fcm_token;
    if (!fcmToken) {
      console.log(`⚠️ No FCM token for user ${userId}`);
      return;
    }

    // ✅ FORCE STRING VALUES
    const safeData = {};
    for (const [k, v] of Object.entries(data)) {
      safeData[k] = v != null ? String(v) : '';
    }

   const message = {
  token: fcmToken,

  android: {
    priority: 'high',
    ttl: 0,
    notification: {
      channelId: channelFor(safeData.type), // ride_requests
      title: title,
      body: body,
      sound: 'default',
      clickAction: 'FLUTTER_NOTIFICATION_CLICK',
    },
  },

  // 🔥 DATA IS STILL REQUIRED FOR NAVIGATION
  data: safeData,

  // iOS stays as-is
  apns: {
    headers: { 'apns-priority': '10' },
    payload: {
      aps: {
        alert: { title, body },
        sound: 'default',
        badge: 1,
        'content-available': 1,
      },
    },
  },
};


    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent to user ${userId}: ${response}`);
    return response;

  } catch (error) {
    console.error(`🔥 FCM error for user ${userId}:`, error.message);

    if (error.code === 'messaging/registration-token-not-registered') {
      await pool.query(
        'DELETE FROM fcm_tokens WHERE fcm_token = $1',
        [fcmToken]
      );
    }
  }
}

module.exports = { sendNotificationToUser };
