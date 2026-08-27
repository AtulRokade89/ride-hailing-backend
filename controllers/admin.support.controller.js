// //admin.support.controllers.js
// const { sendNotificationToUser } = require('../utils/notification_sender');

// exports.getSupportTickets = async (req, res) => {
  // const { status, role, from, to } = req.query;

  // let conditions = [];
  // let values = [];
  // let i = 1;

  // if (status && status !== 'ALL') {
    // conditions.push(`status = $${i++}`);
    // values.push(status);
  // }

  // if (role && role!=='ALL') {
    // conditions.push(`user_role = $${i++}`);
    // values.push(role);
  // }

  // if (from) {
    // conditions.push(`created_at >= $${i++}`);
    // values.push(`${from} 00:00:00`);
  // }

  // if (to) {
    // conditions.push(`created_at <= $${i++}`);
    // values.push(`${to} 23:59:59`);
  // }

  // const whereClause =
    // conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // const sql = `
    // SELECT id, user_role, subject, status, created_at
    // FROM tickets
    // ${whereClause}
    // ORDER BY created_at DESC
  // `;

  // const { rows } = await global.pool.query(sql, values);
  // res.json(rows);
// };

// exports.supportReply = async (req, res) => {
  // const { ticketId } = req.params;
  // const { message } = req.body;

  // if (!message || message.trim().length < 2) {
    // return res.status(400).json({ error: 'Reply is mandatory' });
  // }

  // const { rows } = await global.pool.query(
    // `SELECT status FROM tickets WHERE id=$1`,
    // [ticketId]
  // );

  // if (!rows.length) {
    // return res.status(404).json({ error: 'Ticket not found' });
  // }

  // if (rows[0].status === 'CLOSED') {
    // return res.status(400).json({ error: 'Ticket already closed' });
  // }

  // await global.pool.query(
    // `
    // INSERT INTO ticket_messages (ticket_id, sender_role, message)
    // VALUES ($1, 'SUPPORT', $2)
    // `,
    // [ticketId, message]
  // );

  // await global.pool.query(
    // `
    // UPDATE tickets
    // SET status = 'COMPLETED',
        // updated_at = NOW()
    // WHERE id = $1
    // `,
    // [ticketId]
  // );

// // 🔔 Fetch ticket owner
// const ticketRes = await global.pool.query(
  // `
  // SELECT user_id, user_role
  // FROM tickets
  // WHERE id = $1
  // `,
  // [ticketId]
// );

// const ticket = ticketRes.rows[0];

// // 🔔 Send FCM to Passenger / Driver
// await sendNotificationToUser(
  // ticket.user_id,
  // 'Support replied to your ticket',
  // message.length > 60 ? message.substring(0, 60) + '...' : message,
  // {
    // type: 'TICKET_REPLY',
    // ticketId: ticketId,
    // role: ticket.user_role,
  // }
// );

  // res.json({ status: 'COMPLETED' });
// };

// exports.closeTicket = async (req, res) => {
  // const { ticketId } = req.params;

  // const { rowCount } = await global.pool.query(
    // `
    // UPDATE tickets
    // SET status='CLOSED', closed_at=NOW()
    // WHERE id=$1 AND status != 'CLOSED'
    // `,
    // [ticketId]
  // );

  // if (rowCount === 0) {
    // return res.status(400).json({ error: 'Ticket already closed' });
  // }
  // // 🔔 Fetch ticket owner
// const ticketRes = await global.pool.query(
  // `SELECT user_id, user_role FROM tickets WHERE id = $1`,
  // [ticketId]
// );

// const ticket = ticketRes.rows[0];

// // 🔔 Notify user
// await sendNotificationToUser(
  // ticket.user_id,
  // 'Ticket closed',
  // 'Your support ticket has been closed.',
  // {
    // type: 'TICKET_CLOSED',
    // ticketId: ticketId,
    // role: ticket.user_role,
  // }
// );

  // res.json({ status: 'CLOSED' });
// };

// const { Parser } = require('json2csv');

// exports.exportTickets = async (req, res) => {
  // const { rows } = await global.pool.query(`SELECT * FROM tickets`);

  // const parser = new Parser();
  // const csv = parser.parse(rows);

  // res.header('Content-Type', 'text/csv');
  // res.attachment('support_tickets.csv');
  // return res.send(csv);
// };


// exports.getTicketDetails = async (req, res) => {
  // const { ticketId } = req.params;

  // const ticket = await global.pool.query(
    // `SELECT * FROM tickets WHERE id = $1`,
    // [ticketId]
  // );

  // const messages = await global.pool.query(
    // `
    // SELECT sender_role, message, created_at
    // FROM ticket_messages
    // WHERE ticket_id = $1
    // ORDER BY created_at ASC
    // `,
    // [ticketId]
  // );
  
  // if (
  // ticket.rows[0]?.status === 'SUBMITTED' ||
  // ticket.rows[0]?.status === 'RE_OPENED'
// ) {
  // await global.pool.query(
    // `
    // UPDATE tickets
    // SET status = 'IN_PROGRESS', updated_at = NOW()
    // WHERE id = $1
    // `,
    // [ticketId]
  // );
// }

  // res.json({
    // ticket: ticket.rows[0],
    // messages: messages.rows,
  // });
// };

// exports.passengerReply = async (req, res) => {
  // const { ticketId } = req.params;
  // const { message } = req.body;

  // const { rows } = await global.pool.query(
    // `SELECT attempt_count, max_attempts, status FROM tickets WHERE id=$1`,
    // [ticketId]
  // );

  // const ticket = rows[0];

  // if (ticket.status !== 'COMPLETED') {
    // return res.status(400).json({ error: 'Ticket not open for reply' });
  // }

  // if (ticket.attempt_count >= ticket.max_attempts) {
    // return res.status(400).json({ error: 'No attempts left' });
  // }

  // await global.pool.query(
    // `
    // INSERT INTO ticket_messages (ticket_id, sender_role, message)
    // VALUES ($1, 'PASSENGER', $2)
    // `,
    // [ticketId, message]
  // );

  // await global.pool.query(
    // `
    // UPDATE tickets
    // SET status = 'RE_OPENED',
        // attempt_count = attempt_count + 1,
        // updated_at = NOW()
    // WHERE id = $1
    // `,
    // [ticketId]
  // );
  // // 🔔 Notify support team (admin)
// // You can hardcode support user OR broadcast later
// await sendNotificationToUser(
  // 0, // 👈 special SUPPORT user id OR admin user id
  // 'New reply on support ticket',
  // message.length > 60 ? message.substring(0, 60) + '...' : message,
  // {
    // type: 'TICKET_REPLY_ADMIN',
    // ticketId: ticketId,
  // }
// );

  // res.json({ status: 'RE_OPENED' });
// };


// admin.support.controllers.js
const { sendNotificationToUser } = require('../services/notification_sender');
const { Parser } = require('json2csv');

/* =====================================================
   GET SUPPORT TICKETS (LIST + FILTERS)
===================================================== */
exports.getSupportTickets = async (req, res) => {
  const { status, role, from, to } = req.query;

  let conditions = [];
  let values = [];
  let i = 1;

  if (status && status !== 'ALL') {
    conditions.push(`status = $${i++}`);
    values.push(status);
  }

  if (role && role !== 'ALL') {
    conditions.push(`user_role = $${i++}`);
    values.push(role);
  }

  if (from) {
    conditions.push(`created_at >= $${i++}`);
    values.push(`${from} 00:00:00`);
  }

  if (to) {
    conditions.push(`created_at <= $${i++}`);
    values.push(`${to} 23:59:59`);
  }

  const whereClause =
    conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT id, user_role, subject, status, created_at
    FROM tickets
    ${whereClause}
    ORDER BY created_at DESC
  `;

  const { rows } = await global.pool.query(sql, values);
  res.json(rows);
};

/* =====================================================
   SUPPORT REPLY → COMPLETE TICKET + FCM
===================================================== */
exports.supportReply = async (req, res) => {
  const { ticketId } = req.params;
  const { message } = req.body;

  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Reply is mandatory' });
  }

  // 🔔 Fetch ticket once (status + owner)
  const { rows } = await global.pool.query(
    `SELECT status, user_id, user_role FROM tickets WHERE id = $1`,
    [ticketId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const ticket = rows[0];

  if (ticket.status === 'CLOSED') {
    return res.status(400).json({ error: 'Ticket already closed' });
  }

  // 💬 Insert support message
  await global.pool.query(
    `
    INSERT INTO ticket_messages (ticket_id, sender_role, message)
    VALUES ($1, 'SUPPORT', $2)
    `,
    [ticketId, message]
  );

  // ✅ Mark completed
  await global.pool.query(
    `
    UPDATE tickets
    SET status = 'COMPLETED',
        updated_at = NOW()
    WHERE id = $1
    `,
    [ticketId]
  );

  // 🔔 FCM (safe – never break API)
  try {
    await sendNotificationToUser(
      ticket.user_id,
      'Support replied to your ticket',
      message.length > 60 ? message.substring(0, 60) + '...' : message,
      {
        type: 'TICKET_REPLY',
        ticketId,
        role: ticket.user_role,
      }
    );
  } catch (e) {
    console.error('FCM failed (supportReply):', e.message);
  }

  res.json({ status: 'COMPLETED' });
};

/* =====================================================
   CLOSE TICKET (FINAL) + FCM
===================================================== */
exports.closeTicket = async (req, res) => {
  const { ticketId } = req.params;

  // 🔔 Fetch ticket owner FIRST
  const ticketRes = await global.pool.query(
    `SELECT user_id, user_role FROM tickets WHERE id = $1`,
    [ticketId]
  );

  if (!ticketRes.rows.length) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const ticket = ticketRes.rows[0];

  // 🔒 Close ticket
  const { rowCount } = await global.pool.query(
    `
    UPDATE tickets
    SET status='CLOSED', closed_at=NOW()
    WHERE id=$1 AND status != 'CLOSED'
    `,
    [ticketId]
  );

  if (rowCount === 0) {
    return res.status(400).json({ error: 'Ticket already closed' });
  }

  // 🔔 Notify user safely
  try {
    await sendNotificationToUser(
      ticket.user_id,
      'Ticket closed',
      'Your support ticket has been closed.',
      {
        type: 'TICKET_CLOSED',
        ticketId,
        role: ticket.user_role,
      }
    );
  } catch (e) {
    console.error('FCM failed (closeTicket):', e.message);
  }

  res.json({ status: 'CLOSED' });
};

/* =====================================================
   EXPORT CSV
===================================================== */
exports.exportTickets = async (_req, res) => {
  const { rows } = await global.pool.query(`SELECT * FROM tickets`);

  const parser = new Parser();
  const csv = parser.parse(rows);

  res.header('Content-Type', 'text/csv');
  res.attachment('support_tickets.csv');
  return res.send(csv);
};

/* =====================================================
   GET TICKET DETAILS + AUTO IN_PROGRESS
===================================================== */
exports.getTicketDetails = async (req, res) => {
  const { ticketId } = req.params;

  const ticketRes = await global.pool.query(
    `SELECT * FROM tickets WHERE id = $1`,
    [ticketId]
  );

  if (!ticketRes.rows.length) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const ticket = ticketRes.rows[0];

  const messagesRes = await global.pool.query(
    `
    SELECT sender_role, message, created_at
    FROM ticket_messages
    WHERE ticket_id = $1
    ORDER BY created_at ASC
    `,
    [ticketId]
  );

  // 🔄 Auto move to IN_PROGRESS
  if (ticket.status === 'SUBMITTED' || ticket.status === 'RE_OPENED') {
    await global.pool.query(
      `
      UPDATE tickets
      SET status = 'IN_PROGRESS', updated_at = NOW()
      WHERE id = $1
      `,
      [ticketId]
    );
    ticket.status = 'IN_PROGRESS';
  }

  res.json({
    ticket,
    messages: messagesRes.rows,
  });
};

/* =====================================================
   PASSENGER / DRIVER REPLY → REOPEN + FCM TO ADMIN
===================================================== */
exports.passengerReply = async (req, res) => {
  const { ticketId } = req.params;
  const { message } = req.body;

  if (!message || message.trim().length < 2) {
    return res.status(400).json({ error: 'Reply is mandatory' });
  }

  const { rows } = await global.pool.query(
    `SELECT attempt_count, max_attempts, status FROM tickets WHERE id=$1`,
    [ticketId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Ticket not found' });
  }

  const ticket = rows[0];

  if (ticket.status !== 'COMPLETED') {
    return res.status(400).json({ error: 'Ticket not open for reply' });
  }

  if (ticket.attempt_count >= ticket.max_attempts) {
    return res.status(400).json({ error: 'No attempts left' });
  }

  // 💬 Insert passenger message
  await global.pool.query(
    `
    INSERT INTO ticket_messages (ticket_id, sender_role, message)
    VALUES ($1, 'PASSENGER', $2)
    `,
    [ticketId, message]
  );

  // 🔁 Reopen ticket
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

  // 🔔 Notify support (safe)
  try {
    await sendNotificationToUser(
      9999, // 👈 RECOMMENDED: dedicated SUPPORT/ADMIN user id
      'New reply on support ticket',
      message.length > 60 ? message.substring(0, 60) + '...' : message,
      {
        type: 'TICKET_REPLY_ADMIN',
        ticketId,
      }
    );
  } catch (e) {
    console.error('FCM failed (passengerReply):', e.message);
  }

  res.json({ status: 'RE_OPENED' });
};