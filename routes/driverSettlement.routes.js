const router = require('express').Router();
const c = require('../controllers/driverSettlement.controller');

router.get('/pending', c.getPendingDriverSettlements);
router.post('/pay', c.payDriverSettlement);
router.get('/history', c.getSettlementHistory);
router.get('/weekly-summary', c.getWeeklySummary);
router.get('/export', c.exportSettlementHistoryCSV);


module.exports = router;