const path = require('path');
const dotenv = require('dotenv');

// Check both local backend folder and project root for .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  agentApiKey: process.env.AGENT_API_KEY || 'kiosk_secret_agent_key_2026',
  jwtSecret: process.env.JWT_SECRET || 'super_secret_jwt_kiosk_key_default',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'adminpassword',
  uploadDir: path.resolve(__dirname, '../../', process.env.UPLOAD_DIR || 'storage/uploads'),
  convertedDir: path.resolve(__dirname, '../../', process.env.CONVERTED_DIR || 'storage/converted'),
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 25,
  orderExpiryMinutes: parseInt(process.env.ORDER_EXPIRY_MINUTES, 10) || 15,
  paymentProvider: process.env.PAYMENT_PROVIDER || 'MOCK',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  printerName: process.env.PRINTER_NAME || 'default'
};

// Validate critical secrets in non-test mode when RAZORPAY is active
if (config.paymentProvider === 'RAZORPAY') {
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    console.warn('[WARN] PAYMENT_PROVIDER is set to RAZORPAY but RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing!');
  }
}

module.exports = config;
