const express = require('express');
const planController = require('../controllers/planController');

const router = express.Router();

router.get('/hosting', planController.listHosting);
router.get('/vps', planController.listVps);
router.get('/hosting/:slug', planController.getHostingBySlug);
router.get('/vps/:slug', planController.getVpsBySlug);

module.exports = router;
