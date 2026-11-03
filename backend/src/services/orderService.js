const db = require('../config/db');

// Explicit state machine definition: allowed transitions from a given state
const ALLOWED_TRANSITIONS = {
  CREATED: ['PAYMENT_PENDING', 'EXPIRED'],
  PAYMENT_PENDING: ['PAID', 'PAYMENT_FAILED', 'EXPIRED', 'NEEDS_REVIEW'],
  PAID: ['QUEUED', 'NEEDS_REVIEW'],
  QUEUED: ['PRINTING'],
  PRINTING: ['DONE', 'PRINT_FAILED'],
  PRINT_FAILED: ['QUEUED', 'REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED'],
  NEEDS_REVIEW: ['PAID', 'REFUND_PENDING'],
  EXPIRED: ['NEEDS_REVIEW'], // In case late payment webhook arrives
  PAYMENT_FAILED: [],
  DONE: [],
  REFUNDED: []
};

/**
 * Generate a friendly human-readable kiosk pickup token.
 * Format: Letter + 4 digits (e.g. A-1042)
 */
function generateToken() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Avoid I/O to prevent confusion
  const char = letters[Math.floor(Math.random() * letters.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${char}-${num}`;
}

/**
 * Transition order status with strict state machine validation and DB audit logging.
 *
 * @param {number} orderId - Database primary key of the order
 * @param {string} newStatus - Target status
 * @param {string} reason - Description/audit reason
 * @param {object} [additionalUpdates] - Extra columns to update (e.g., { paid_at: ..., razorpay_order_id: ... })
 * @returns {object} Updated order object
 */
function transitionOrderStatus(orderId, newStatus, reason = '', additionalUpdates = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    throw new Error(`Order with ID ${orderId} not found.`);
  }

  const currentStatus = order.status;

  // Verify transition is valid
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Illegal state transition from ${currentStatus} to ${newStatus} for order #${orderId}.`);
  }

  // Execute transition inside atomic transaction
  const executeTransition = db.transaction(() => {
    let updateFields = ['status = ?'];
    let updateValues = [newStatus];

    for (const [key, val] of Object.entries(additionalUpdates)) {
      updateFields.push(`${key} = ?`);
      updateValues.push(val);
    }

    updateValues.push(orderId);

    const updateQuery = `UPDATE orders SET ${updateFields.join(', ')} WHERE id = ?`;
    db.prepare(updateQuery).run(...updateValues);

    // Write audit log
    db.prepare(`
      INSERT INTO order_status_log (order_id, old_status, new_status, reason)
      VALUES (?, ?, ?, ?)
    `).run(orderId, currentStatus, newStatus, reason);

    return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  });

  return executeTransition();
}

/**
 * Retrieves an order by its short token.
 */
function getOrderByToken(token) {
  return db.prepare('SELECT * FROM orders WHERE token = ?').get(token);
}

/**
 * Checks if an order is expired.
 */
function isOrderExpired(order) {
  if (!order.expires_at) return false;
  return new Date(order.expires_at).getTime() < Date.now();
}

module.exports = {
  generateToken,
  transitionOrderStatus,
  getOrderByToken,
  isOrderExpired,
  ALLOWED_TRANSITIONS
};

