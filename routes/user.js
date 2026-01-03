    // In file: D:/ride-hailing-project/ride-hailing-backend/routes/user.js

    const express = require('express');
    const router = express.Router();
	const { sendNotificationToUser } = require('../services/notification_sender');

   router.post('/update-fcm-token', async (req, res) => {
  const { userId, fcmToken } = req.body;

  if (!userId || !fcmToken) {
    return res.status(400).json({ message: 'userId and fcmToken are required.' });
  }

  try {
    // 🔥🔥🔥 THIS LINE IS THE MISSING PIECE 🔥🔥🔥
    // Remove this token from ANY previous user
    await global.pool.query(
      `DELETE FROM fcm_tokens WHERE fcm_token = $1`,
      [fcmToken]
    );

    // ✅ Now safely upsert for current user
    const query = `
      INSERT INTO fcm_tokens (user_id, fcm_token)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET
        fcm_token = EXCLUDED.fcm_token,
        updated_at = NOW();
    `;

    await global.pool.query(query, [userId, fcmToken]);

    console.log(`✅ FCM token reassigned to user ${userId}`);
    res.status(200).json({ message: 'FCM token updated successfully.' });

  } catch (error) {
    console.error('Error upserting FCM token:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

	

// ... (your existing /update-fcm-token endpoint is perfect) ...

// ✅✅✅ ADD THIS NEW LOGOUT ENDPOINT ✅✅✅
router.post('/logout', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'userId is required for logout.' });
  }

  try {
    // Delete the token from our glorious fcm_tokens table
    await global.pool.query(
      `DELETE FROM fcm_tokens WHERE user_id = $1`,
      [userId]
    );

    console.log(`✅ FCM Token deleted for user ${userId} upon logout.`);
    res.status(200).json({ message: 'Logout successful and token removed.' });

  } catch (error) {
    console.error('Error deleting FCM token during logout:', error);
    // We still return success because the user should be logged out on the frontend regardless
    res.status(500).json({ message: 'Server error during token cleanup.' });
  }
});

router.post('/test-notification', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required.' });
  }

  console.log(`[TEST] Received request to send test notification to user ${userId}`);

  try {
    // This is the magnificent command to send the notification!
    await sendNotificationToUser(
      userId,
      '🏆 VICTORY! 🏆', // This is the notification title
      'My friend, your notification system is working perfectly!' // This is the body
    );

    res.status(200).json({ message: `Test notification sent to user ${userId}. Check the device!` });

  } catch (error) {
    console.error(`[TEST] Failed to send notification:`, error);
    res.status(500).json({ message: 'Failed to send notification.', error: error.message });
  }
});

module.exports = router;
