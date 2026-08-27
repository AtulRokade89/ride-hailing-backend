//tickets.routes.js
const express = require('express');
const router = express.Router();
const ticketCtrl = require('../controllers/tickets.controller');

// ✅ SPECIFIC ROUTES FIRST
router.get('/eligible-rides', ticketCtrl.getEligibleRides);
router.get('/by-ride', ticketCtrl.getTicketByRide);
router.post('/create', ticketCtrl.createTicket);

// ✅ GENERIC ROUTES LAST
router.get('/:ticketId', ticketCtrl.getTicketDetails);
router.post('/:ticketId/message', ticketCtrl.addMessage);
router.post('/:ticketId/reopen', ticketCtrl.reopenTicket);
router.post('/:ticketId/close', ticketCtrl.closeTicket);

module.exports = router;