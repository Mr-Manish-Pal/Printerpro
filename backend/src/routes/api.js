const express = require('express');
const router = express.Router();

const { upload, verifyMagicBytes } = require('../middleware/uploadValidator');
const { verifyDeviceHmac } = require('../middleware/deviceAuth');

const uploadController = require('../controllers/uploadController');
const pricingController = require('../controllers/pricingController');
const orderController = require('../controllers/orderController');
const machineController = require('../controllers/machineController');

// Health Check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'auto-print-backend'
  });
});

// File Upload & Format Conversion
router.post('/upload', upload.array('files', 10), verifyMagicBytes, uploadController.handleUpload);

// Current Pricing Rates
router.get('/rates', pricingController.getRates);

// Live Authoritative Price Quote Calculation
router.post('/pricing/quote', pricingController.calculateQuote);

// Order Preparation & Status Tracking
router.post('/orders/prepare', orderController.prepareOrder);
router.get('/orders/:token/status', orderController.getOrderStatus);

// Machine Public Status & Pre-flight Gating
router.get('/machine/:machineId/status', machineController.getMachinePublicStatus);

// Machine Agent Outbound Heartbeat (Protected by HMAC-SHA256)
router.post('/agent/heartbeat', verifyDeviceHmac, machineController.recordHeartbeat);

// Admin Machine Operations
router.post('/admin/machines/:machineId/refill', machineController.refillPaper);

module.exports = router;
