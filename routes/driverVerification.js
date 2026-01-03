// routes/driverVerification.js
const express = require('express');
const router = express.Router();
const {
  upload,
  submitVerification,
  getStatus,
  activateDriver, 
} = require('../controllers/driverVerificationController');

// POST → submit driver verification
router.post('/verify', upload.fields([
  { name: 'pan_image', maxCount: 1 },
  { name: 'aadhar_image', maxCount: 1 },
  { name: 'rc_image', maxCount: 1 },
  { name: 'passbook_image', maxCount: 1 },
  { name: 'driver_photo', maxCount: 1 },   
  { name: 'vehicle_photo', maxCount: 1 }, 
]), submitVerification);

// GET → check verification status
router.get('/status/:userId', getStatus);
router.put('/activate/:userId', activateDriver);
module.exports = router;
