const Razorpay = require('razorpay');
const crypto = require('crypto');
const config = require('../config/env');

let razorpayInstance = null;

function getRazorpayClient() {
  if (!razorpayInstance) {
    if (!config.razorpayKeyId || !config.razorpayKeySecret) {
      throw new Error('Razorpay credentials missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.');
    }
    razorpayInstance = new Razorpay({
      key_id: config.razorpayKeyId,
      key_secret: config.razorpayKeySecret
    });
  }
  return razorpayInstance;
}

/**
 * Creates a Razorpay Order via the official Orders API.
 * 
 * @param {object} params
 * @param {number} params.amountPaise - Amount in integer paise (₹10 = 1000)
 * @param {string} params.currency - Currency, e.g. 'INR'
 * @param {string} params.receipt - Internal receipt/order reference (e.g. order token)
 * @param {object} [params.notes] - Key-value metadata
 */
async function createRazorpayOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
  // If in MOCK mode, generate mock order ID without hitting external network
  if (config.paymentProvider === 'MOCK') {
    return {
      id: `order_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      amount: amountPaise,
      currency,
      receipt,
      status: 'created'
    };
  }

  const client = getRazorpayClient();
  const order = await client.orders.create({
    amount: amountPaise,
    currency,
    receipt: receipt.substring(0, 40), // Razorpay receipt max 40 chars
    notes
  });

  return order;
}

/**
 * Verifies standard checkout payment signature using HMAC-SHA256 with timingSafeEqual.
 * Signature payload: razorpay_order_id + "|" + razorpay_payment_id
 */
function verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (config.paymentProvider === 'MOCK') {
    // In mock mode, allow mock signatures
    return razorpaySignature === 'mock_signature_valid' || razorpaySignature.startsWith('mock_');
  }

  const expectedSignature = crypto
    .createHmac('sha256', config.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(razorpaySignature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

/**
 * Verifies Razorpay Webhook signature using HMAC-SHA256 with timingSafeEqual.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.razorpayWebhookSecret) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured.');
  }

  if (!signatureHeader) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', config.razorpayWebhookSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

module.exports = {
  createRazorpayOrder,
  verifyPaymentSignature,
  verifyWebhookSignature
};

