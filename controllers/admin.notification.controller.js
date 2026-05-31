const sendTopicNotification = require('../utils/sendTopicNotification');

// CREATE
exports.createNotification = async (req, res) => {
  try {
    const { title, body, targetRole, sendType, scheduledAt } = req.body;

    if (!title || !body || !targetRole || !sendType) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const { rows } = await global.pool.query(
      `
      INSERT INTO admin_notifications
      (title, body, target_role, send_type, scheduled_at)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [title, body, targetRole, sendType, scheduledAt || null]
    );

    const notification = rows[0];

    // 🚀 Instant send
    if (sendType === 'INSTANT') {
      await sendTopicNotification(notification);

      await global.pool.query(
        `
        UPDATE admin_notifications
        SET status='SENT', sent_at=NOW()
        WHERE id=$1
        `,
        [notification.id]
      );
    }

    res.json({ success: true, notification });
  } catch (err) {
    console.error('Create notification error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// LIST
exports.listNotifications = async (req, res) => {
  try {
    const { rows } = await global.pool.query(
      `
      SELECT *
      FROM admin_notifications
      ORDER BY created_at DESC
      `
    );

    res.json(rows);
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};