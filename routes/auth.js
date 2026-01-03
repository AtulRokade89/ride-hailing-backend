// ride-hailing-backend/routes/auth.js

// 1. CommonJS Imports
const express = require('express');
const { register, login,verifyEmail } = require('../controllers/authController.js');

const router = express.Router();

// Public route for user registration
router.post('/register', register);

// Public route for user login
router.post('/login', login);

router.get('/verify/:token', verifyEmail);

// 2. CommonJS Export
module.exports = router;