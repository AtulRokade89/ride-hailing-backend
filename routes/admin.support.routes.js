//admin.support.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/admin.support.controller');

// Ticket list + filters
router.get('/support-tickets', ctrl.getSupportTickets);

// CSV export
router.get('/support-tickets/export', ctrl.exportTickets);

// ❗ ADD THIS (missing earlier)
router.get('/support-tickets/:ticketId', ctrl.getTicketDetails);

// Reply from support
router.post('/support-tickets/:ticketId/message', ctrl.supportReply);

router.post('/support-tickets/:ticketId/passenger-reply', ctrl.passengerReply);

router.post('/support-tickets/:ticketId/close', ctrl.closeTicket);

module.exports = router;