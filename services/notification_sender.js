// const admin = require('firebase-admin');

// function channelFor(type) {
  // if (type === 'NEW_RIDE') return 'ride_requests';
  // return 'ride_updates';
// }

// async function sendNotificationToUser(userId, title, body, data = {},options = { showNotification: true } ) {
  // let fcmToken;

  // try {
    // const tokenQuery = await pool.query(
      // 'SELECT fcm_token FROM fcm_tokens WHERE user_id = $1',
      // [userId]
    // );

    // fcmToken = tokenQuery.rows[0]?.fcm_token;
    // if (!fcmToken) {
      // console.log(`⚠️ No FCM token for user ${userId}`);
      // return;
    // }

    // // ✅ FORCE STRING VALUES
    // const safeData = {};
    // for (const [k, v] of Object.entries(data)) {
      // safeData[k] = v != null ? String(v) : '';
    // }

   // const message = {
  // token: fcmToken,

  // android: {
    // priority: 'high',
    // ttl: 30000,

    // ...(options.showNotification ? {
      // notification: {
        // channelId: channelFor(safeData.type),
        // title,
        // body,
        // sound: 'default',
      // }
    // } : {})
  // },

  // // 🟢 DATA ALWAYS SENT
  // data: safeData,
// };



    // const response = await admin.messaging().send(message);
    // console.log(`✅ FCM sent to user ${userId}: ${response}`);
    // return response;

  // } catch (error) {
  // console.error(🔥 FCM error for user ${userId}:, error.code, error.message);

  // const shouldDeleteToken =
    // error.code === 'messaging/registration-token-not-registered' ||
    // error.code === 'messaging/invalid-registration-token' ||
    // error.message?.includes('Requested entity was not found');

  // if (shouldDeleteToken && fcmToken) {
    // console.log(🧹 Deleting invalid FCM token for user ${userId});
    // await pool.query(
      // 'DELETE FROM fcm_tokens WHERE user_id = $1',
      // [userId]
    // );
  // }
// }
// }

// module.exports = { sendNotificationToUser };



// const admin = require('firebase-admin');

// function channelFor(type) {
  // if (type === 'NEW_RIDE') return 'ride_requests';
  // return 'ride_updates';
// }

// async function sendNotificationToUser(
  // userId,
  // title,
  // body,
  // data = {},
  // options = { showNotification: true }
// ) {
  // let fcmToken;

  // try {
    // const tokenQuery = await pool.query(
      // 'SELECT fcm_token FROM fcm_tokens WHERE user_id = $1',
      // [userId]
    // );

    // fcmToken = tokenQuery.rows[0]?.fcm_token;

    // if (!fcmToken) {
      // console.log(`⚠️ No FCM token for user ${userId}`);
      // return;
    // }

    // // ✅ FORCE STRING VALUES
    // const safeData = {};
    // for (const [k, v] of Object.entries(data)) {
      // safeData[k] = v != null ? String(v) : '';
    // }

    // const message = {
      // token: fcmToken,

      // android: {
        // priority: 'high',
        // ttl: 30000,

        // ...(options.showNotification
          // ? {
              // notification: {
                // channelId: channelFor(safeData.type),
                // title,
                // body,
                // sound: 'default',
              // },
            // }
          // : {}),
      // },

      // // 🟢 DATA ALWAYS SENT
      // data: safeData,
    // };

    // const response = await admin.messaging().send(message);
    // console.log(`✅ FCM sent to user ${userId}: ${response}`);
    // return response;

  // } catch (error) {
    // console.error(
      // `🔥 FCM error for user ${userId}:`,
      // error.code,
      // error.message
    // );

    // const shouldDeleteToken =
      // error.code === 'messaging/registration-token-not-registered' ||
      // error.code === 'messaging/invalid-registration-token' ||
      // error.message?.includes('Requested entity was not found');

    // if (shouldDeleteToken && fcmToken) {
      // console.log(`🧹 Deleting invalid FCM token for user ${userId}`);
      // await pool.query(
        // 'DELETE FROM fcm_tokens WHERE user_id = $1',
        // [userId]
      // );
    // }
  // }
// }

// module.exports = { sendNotificationToUser };

const admin = require('firebase-admin');
const { fcmLogger } = require('./logger');

function channelFor(type) {
  if (type === 'NEW_RIDE') return 'ride_requests';
  return 'ride_updates';
}

async function sendNotificationToUser(
  userId,
  title,
  body,
  data = {},
  options = { showNotification: true }
) {
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

    // ✅ Force string values (FCM requirement)
    const safeData = {};
    for (const [k, v] of Object.entries(data)) {
      safeData[k] = v != null ? String(v) : '';
    }

    const message = {
      token: fcmToken,

      // 🔥🔥🔥 THIS IS THE KEY FIX 🔥🔥🔥
      ...(options.showNotification
        ? {
            notification: {
              title,
              body,
            },
          }
        : {}),

      android: {
        priority: 'high',
        notification: {
          channelId: channelFor(safeData.type),
          sound: 'default',
        },
      },

      data: safeData,
    };

    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent to user ${userId}: ${response}`);
    return response;

  } catch (error) {
    console.error(
      `🔥 FCM error for user ${userId}:`,
      error.code,
      error.message
    );

    const shouldDeleteToken =
      error.code === 'messaging/registration-token-not-registered' ||
      error.code === 'messaging/invalid-registration-token' ||
      error.message?.includes('Requested entity was not found');

    if (shouldDeleteToken && fcmToken) {
      console.log(`🧹 Deleting invalid FCM token for user ${userId}`);
      await pool.query(
        'DELETE FROM fcm_tokens WHERE user_id = $1',
        [userId]
      );
    }
  }
}

module.exports = { sendNotificationToUser };