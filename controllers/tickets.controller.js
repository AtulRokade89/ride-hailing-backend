// tickets.controller.js

// =====================================================
// 1️⃣ Get eligible rides for ticket creation
// Passenger → last 48h
// Driver → last 5 days
// =====================================================
exports.getEligibleRides = async (req, res) => {
  const { userId, role } = req.query;

  if (!userId || !role) {
    return res.status(400).json({ message: 'Missing params' });
  }

  const interval = role === 'PASSENGER' ? '48 hours' : '5 days';

const sql = `
SELECT
  r.external_id  AS ride_external_id,
  r.completed_at AS ride_completed_at,
  t.id           AS ticket_id,
  t.status       AS ticket_status
FROM rides r
LEFT JOIN tickets t
  ON t.ride_external_id = r.external_id
 AND t.user_id = $1
WHERE r.status = 'COMPLETED'
  AND r.completed_at >= NOW() - INTERVAL '${interval}'
ORDER BY r.completed_at DESC
`;

  const { rows } = await global.pool.query(sql, [userId]);
  res.json(rows);
};



// =====================================================
// 2️⃣ Create Ticket (SAFE + REOPEN LOGIC)
// =====================================================
exports.createTicket = async (req, res) => {
  const { rideExternalId, userId, userRole, subject, message } = req.body;

  // find latest ticket
  const existing = await global.pool.query(
    `
    SELECT id, status, attempt_count
    FROM tickets
    WHERE ride_external_id = $1
      AND user_id = $2
      AND user_role = $3
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [rideExternalId, userId, userRole]
  );

  // 🚫 MAX ATTEMPTS
  if (existing.rows.length > 0 && existing.rows[0].attempt_count >= 3) {
    return res.status(429).json({
      message:
        'Max attempts reached. Please mail documents to support@xyz.com',
      maxAttemptsReached: true,
      ticketId: existing.rows[0].id,
    });
  }

  // 🔁 Existing ticket
  if (existing.rows.length > 0) {
    const t = existing.rows[0];

    // Active → open chat only
// ✅ ONLY COMPLETED CAN BE REOPENED
if (t.status !== 'COMPLETED') {
  return res.status(409).json({
    message: 'Ticket already active or closed',
    ticketId: t.id,
    status: t.status,
    attemptCount: t.attempt_count,
  });
}

await global.pool.query(
  `
  UPDATE tickets
  SET status = 'RE_OPENED',
      attempt_count = attempt_count + 1,
      updated_at = NOW()
  WHERE id = $1
  `,
  [t.id]
);

    await global.pool.query(
      `
      INSERT INTO ticket_messages (ticket_id, sender_role, message)
      VALUES ($1,$2,$3)
      `,
      [t.id, userRole, message]
    );

    return res.json({
      ticketId: t.id,
      status: 'RE_OPENED',
      attemptCount: t.attempt_count + 1,
    });
  }

  // 🆕 FIRST TIME
  const { rows } = await global.pool.query(
    `
    INSERT INTO tickets
      (ride_external_id, user_id, user_role, subject, attempt_count)
    VALUES ($1,$2,$3,$4,1)
    RETURNING id
    `,
    [rideExternalId, userId, userRole, subject]
  );

  await global.pool.query(
    `
    INSERT INTO ticket_messages (ticket_id, sender_role, message)
    VALUES ($1,$2,$3)
    `,
    [rows[0].id, userRole, message]
  );

  res.json({
    ticketId: rows[0].id,
    status: 'SUBMITTED',
    attemptCount: 1,
  });
};



// =====================================================
// 3️⃣ Ticket Details + Messages
// =====================================================
exports.getTicketDetails = async (req, res) => {
  const { ticketId } = req.params;

  const ticket = await global.pool.query(
    `SELECT * FROM tickets WHERE id = $1`,
    [ticketId]
  );

  const messages = await global.pool.query(
    `
    SELECT sender_role, message, created_at
    FROM ticket_messages
    WHERE ticket_id = $1
    ORDER BY created_at ASC
    `,
    [ticketId]
  );

  res.json({
    ticket: ticket.rows[0],
    messages: messages.rows,
  });
};



// =====================================================
// 4️⃣ Add Message (Passenger / Support)
// =====================================================
exports.addMessage = async (req, res) => {
  const { ticketId } = req.params;
  const { senderRole, message } = req.body;

  const t = await global.pool.query(
    `SELECT status FROM tickets WHERE id = $1`,
    [ticketId]
  );

  if (t.rows[0].status === 'CLOSED') {
    return res.status(400).json({ message: 'Ticket is closed' });
  }

  await global.pool.query(
    `
    INSERT INTO ticket_messages
      (ticket_id, sender_role, message)
    VALUES ($1,$2,$3)
    `,
    [ticketId, senderRole, message]
  );

await global.pool.query(
  `
  UPDATE tickets
  SET
    status = CASE
      WHEN status = 'RE_OPENED' THEN 'IN_PROGRESS'
      ELSE status
    END,
    updated_at = NOW()
  WHERE id = $1
  `,
  [ticketId]
);

  res.json({ ok: true });
};


// 🔁 Reopen ticket
exports.reopenTicket = async (req, res) => {
  const { ticketId } = req.params;

  const { rows } = await global.pool.query(
    `SELECT status, attempt_count FROM tickets WHERE id = $1`,
    [ticketId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'Ticket not found' });
  }

  const ticket = rows[0];

  // 🚫 MAX ATTEMPTS
  if (ticket.attempt_count >= 3) {
    return res.status(429).json({
      message: 'Max attempts reached',
      maxAttemptsReached: true,
    });
  }

  // ✅ ONLY COMPLETED CAN BE REOPENED
  if (ticket.status !== 'COMPLETED') {
    return res.status(400).json({
      message: 'Only completed tickets can be reopened',
    });
  }

  await global.pool.query(
    `
    UPDATE tickets
    SET status = 'RE_OPENED',
        attempt_count = attempt_count + 1,
        updated_at = NOW()
    WHERE id = $1
    `,
    [ticketId]
  );

  res.json({ status: 'RE_OPENED' });
};

// =====================================================
// 5️⃣ Close Ticket (FINAL)
// =====================================================
exports.closeTicket = async (req, res) => {
  const { ticketId } = req.params;

  await global.pool.query(
    `
    UPDATE tickets
    SET status = 'CLOSED',
        closed_at = NOW()
    WHERE id = $1 and status in ('COMPLETED')
    `,
    [ticketId]
  );

  res.json({ status: 'CLOSED' });
};



// =====================================================
// 6️⃣ Get active ticket by ride (Flutter uses this)
// =====================================================
exports.getTicketByRide = async (req, res) => {
  const { rideExternalId, userId } = req.query;

  if (!rideExternalId || !userId) {
    return res.status(400).json({ message: 'Missing params' });
  }

  const { rows } = await global.pool.query(
    `
    SELECT *
    FROM tickets
    WHERE ride_external_id = $1
      AND user_id = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [rideExternalId, userId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ message: 'No ticket found' });
  }

  res.json({ ticket: rows[0] });
};