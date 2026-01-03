// In routes/driver.js
const express = require('express');
const router = express.Router();

// Import the controller function we just created
const driverController = require('../controllers/driverController');

// Define the route. When a PUT request comes to '/unblock-after-payment',
// it will call the 'unblockAfterPayment' function from our controller.
router.put('/unblock-after-payment', driverController.unblockAfterPayment);

// Export the router so server.js can use it
module.exports = router;
