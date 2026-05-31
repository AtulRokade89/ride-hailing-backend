// ride-hailing-backend/routes/auth.js

// 1. CommonJS Imports
const express = require('express');
const { 
  register, login, verifyEmail, 
  lockFirstRideFree, cancelAbuseFreeRide 
} = require('../controllers/authController');


const router = express.Router();

// Public route for user registration
router.post('/register', register);

// Public route for user login
router.post('/login', login);

router.get('/verify/:token', verifyEmail);

router.post('/referral/lock-free-ride', lockFirstRideFree);
router.post('/referral/cancel-abuse', cancelAbuseFreeRide);

// 2. CommonJS Export
module.exports = router;