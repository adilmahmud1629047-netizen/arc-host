const express = require('express');
const serviceController = require('../controllers/serviceController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Read-only service lifecycle listing for the signed-in customer.
// Deliberately GET-only: there is no HTTP trigger for provisioning,
// suspension, or termination.
router.get('/', requireAuth, serviceController.listServices);

module.exports = router;
