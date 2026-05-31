const express = require('express');
const router = express.Router();

const {
  getPayments,
  exportPaymentsCSV,
} = require('../controllers/admin.payments.controller');

//const adminAuth = require('../middlewares/adminAuth.middleware');

router.get('/payments', getPayments);
router.get('/payments/export', exportPaymentsCSV);

module.exports = router;