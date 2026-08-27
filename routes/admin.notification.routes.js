const express = require('express');
const router = express.Router();
const controller = require('../controllers/admin.notification.controller');

// ❌ adminAuth hata dete hai abhi debug ke liye
// const adminAuth = require('../middlewares/adminAuth.middleware');

// CREATE
router.post('/notifications', controller.createNotification);

// LIST
router.get('/notifications', controller.listNotifications);

module.exports = router;