const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/admin.rides.controller');

// GET /admin/rides
router.get('/rides', ctrl.getAdminRides);

module.exports = router;