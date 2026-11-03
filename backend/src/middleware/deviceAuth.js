const crypto = require('crypto');
const db = require('../config/db');

// In-memory nonce cache with TTL to prevent replay attacks
const seenNonces = new Map();
const NONCE_TTL_MS = 90 * 1000; // 90 seconds (longer than the 60s timestamp window)

// Periodic cleanup of expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of seenNonces.entries()) {
    if (expiresAt < now) {
      seenNonces.delete(nonce);
    }
  }
}, 30000);

/**
 * Verifies outbound HMAC-SHA256 authenticated requests from physical kiosk machine agents.
 * 
 * Required Headers:
 * - x-device-id
 * - x-timestamp (Unix epoch in milliseconds or seconds)
 * - x-nonce (Unique random string)
 * - x-signature (HMAC-SHA256 hex digest)
 */
function verifyDeviceHmac(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const timestampStr = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];
  const signature = req.headers['x-signature'];

  if (!deviceId || !timestampStr || !nonce || !signature) {
    return res.status(401).json({
      success: false,
      error: 'Missing device authentication headers (x-device-id, x-timestamp, x-nonce, x-signature).'
    });
  }

  // 1. Look up machine in SQLite
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(deviceId);
  if (!machine) {
    return res.status(401).json({
      success: false,
      error: `Device "${deviceId}" is not registered.`
    });
  }

  if (machine.status === 'TAMPER_LOCK') {
    return res.status(403).json({
      success: false,
      error: `Device "${deviceId}" is locked due to a physical tamper alarm.`
    });
  }

  // 2. Replay Window Verification (±60 seconds)
  let requestTime = parseInt(timestampStr, 10);
  if (requestTime < 10000000000) {
    requestTime *= 1000; // Convert seconds to ms if necessary
  }

  const now = Date.now();
  const timeDiff = Math.abs(now - requestTime);
  if (isNaN(requestTime) || timeDiff > 60000) {
    return res.status(401).json({
      success: false,
      error: `Request timestamp out of bounds (Clock skew: ${Math.round(timeDiff / 1000)}s). Must be within ±60s.`
    });
  }

  // 3. Nonce Replay Check
  if (seenNonces.has(nonce)) {
    return res.status(401).json({
      success: false,
      error: 'Replay attack detected: Nonce has already been used.'
    });
  }
  seenNonces.set(nonce, now + NONCE_TTL_MS);

  // 4. Compute Expected Signature
  // Canonical format: deviceId:METHOD:PATH:timestamp:nonce:body
  const bodyString = req.body && Object.keys(req.body).length > 0
    ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    : '';

  // Use the path only without query string inconsistencies
  const requestPath = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;

  const canonicalPayload = `${deviceId}:${req.method.toUpperCase()}:${requestPath}:${timestampStr}:${nonce}:${bodyString}`;

  const expectedSignature = crypto
    .createHmac('sha256', machine.api_secret)
    .update(canonicalPayload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return res.status(401).json({
      success: false,
      error: 'Invalid device signature. Authentication failed.'
    });
  }

  // Attach authenticated machine entity to request
  req.machine = machine;
  next();
}

module.exports = {
  verifyDeviceHmac
};

