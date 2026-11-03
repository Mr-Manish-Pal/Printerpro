const db = require('../config/db');
const config = require('../config/env');
const { calculateOrderPricing } = require('../services/pricingService');
const { parsePageRange } = require('../services/pdfService');
const { generateToken, transitionOrderStatus, getOrderByToken, isOrderExpired } = require('../services/orderService');
const { createRazorpayOrder, verifyPaymentSignature } = require('../services/razorpayService');
const { validateMachineAvailability } = require('./machineController');

/**
 * Prepares and creates an order.
 * Recomputes all page counts and rates authoritatively from the database.
 * NEVER accepts price or page counts from the client.
 * Enforces pre-payment machine gating (heartbeat, paper level, tamper state).
 */
async function prepareOrder(req, res, next) {
  try {
    const { items, customerPhone, machineId = 'kiosk-campus-01' } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or empty "items" array in request body.'
      });
    }

    // Step 0: CRITICAL PUBLIC MACHINE GATING CHECK
    // If the machine is offline, out of paper, or door is open, halt and do not charge user
    const gating = validateMachineAvailability(machineId);
    if (!gating.ok) {
      return res.status(403).json({
        success: false,
        machineAvailable: false,
        reason: gating.reason,
        error: gating.message
      });
    }

    const verifiedItems = [];

    // Step 1: Verify every file and option from SQLite
    for (const item of items) {
      if (!item.tempFileId) {
        return res.status(400).json({
          success: false,
          error: 'Each item must specify a "tempFileId".'
        });
      }

      const fileRecord = db.prepare('SELECT * FROM order_files WHERE temp_file_id = ?').get(item.tempFileId);
      if (!fileRecord) {
        return res.status(404).json({
          success: false,
          error: `File reference "${item.tempFileId}" not found or expired.`
        });
      }

      // Check if file is already linked to another active order
      if (fileRecord.order_id) {
        const existingOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(fileRecord.order_id);
        if (existingOrder && !['EXPIRED', 'PAYMENT_FAILED'].includes(existingOrder.status)) {
          return res.status(400).json({
            success: false,
            error: `File "${fileRecord.original_filename}" is already linked to active order #${fileRecord.order_id}.`
          });
        }
      }

      const rangeResult = parsePageRange(item.pageRange, fileRecord.raw_page_count);
      if (!rangeResult.isValid) {
        return res.status(400).json({
          success: false,
          error: `Error in file "${fileRecord.original_filename}": ${rangeResult.error}`
        });
      }

      const copies = Math.max(1, parseInt(item.copies, 10) || 1);
      const colorMode = item.colorMode === 'color' ? 'color' : 'mono';
      const sides = item.sides === 'two-sided-long-edge' ? 'two-sided-long-edge' : 'one-sided';
      const paperSize = ['Letter', 'Legal'].includes(item.paperSize) ? item.paperSize : 'A4';
      const orientation = item.orientation === 'landscape' ? 'landscape' : 'portrait';

      verifiedItems.push({
        fileRecordId: fileRecord.id,
        tempFileId: item.tempFileId,
        filename: fileRecord.original_filename,
        rawPageCount: fileRecord.raw_page_count,
        effectivePages: rangeResult.effectiveCount,
        normalizedRange: rangeResult.normalizedRange,
        copies,
        colorMode,
        sides,
        paperSize,
        orientation
      });
    }

    // Step 2: Authoritative price calculation
    const quote = calculateOrderPricing(verifiedItems);
    const totalAmountPaise = Math.round(quote.totalAmount * 100);

    // Step 3: Expiry calculation (default 15 minutes)
    const expiresAt = new Date(Date.now() + config.orderExpiryMinutes * 60 * 1000).toISOString();

    // Step 4: Atomic DB transaction to create order & bind files
    const createOrderTx = db.transaction(() => {
      // Find a unique token
      let token = generateToken();
      while (db.prepare('SELECT id FROM orders WHERE token = ?').get(token)) {
        token = generateToken();
      }

      const orderInsert = db.prepare(`
        INSERT INTO orders (token, machine_id, status, total_amount_paise, currency, customer_phone, expires_at)
        VALUES (?, ?, 'CREATED', ?, 'INR', ?, ?)
      `).run(token, machineId, totalAmountPaise, customerPhone || null, expiresAt);

      const orderId = orderInsert.lastInsertRowid;

      // Update order_files with selected options & bind order_id
      const updateFileStmt = db.prepare(`
        UPDATE order_files SET
          order_id = ?,
          page_range = ?,
          effective_pages = ?,
          copies = ?,
          color_mode = ?,
          sides = ?,
          paper_size = ?,
          orientation = ?,
          file_subtotal = ?
        WHERE id = ?
      `);

      for (let i = 0; i < verifiedItems.length; i++) {
        const item = verifiedItems[i];
        const quoteItem = quote.items[i];
        updateFileStmt.run(
          orderId,
          item.normalizedRange,
          item.effectivePages,
          item.copies,
          item.colorMode,
          item.sides,
          item.paperSize,
          item.orientation,
          quoteItem.fileTotal,
          item.fileRecordId
        );
      }

      // Initial audit log
      db.prepare(`
        INSERT INTO order_status_log (order_id, old_status, new_status, reason)
        VALUES (?, 'NONE', 'CREATED', 'Order prepared via /api/orders/prepare')
      `).run(orderId);

      return { orderId, token };
    });

    const { orderId, token } = createOrderTx();

    // Step 5: Create Razorpay Order via SDK
    let rzpOrder;
    try {
      rzpOrder = await createRazorpayOrder({
        amountPaise: totalAmountPaise,
        currency: 'INR',
        receipt: token,
        notes: { orderId: String(orderId), token, machineId }
      });
    } catch (rzpErr) {
      console.error('[Razorpay Order Creation Failed]', rzpErr);
      return res.status(502).json({
        success: false,
        error: `Payment gateway error: ${rzpErr.message}`
      });
    }

    // Step 6: Transition status from CREATED -> PAYMENT_PENDING and save razorpay_order_id
    transitionOrderStatus(orderId, 'PAYMENT_PENDING', 'Razorpay order created', {
      razorpay_order_id: rzpOrder.id
    });

    // Step 7: Return public-safe payload only
    return res.status(200).json({
      success: true,
      order: {
        token,
        machineId,
        amount: totalAmountPaise,
        currency: 'INR',
        razorpayOrderId: rzpOrder.id,
        keyId: config.paymentProvider === 'MOCK' ? 'rzp_test_mock_key' : config.razorpayKeyId,
        provider: config.paymentProvider,
        expiresAt
      }
    });

  } catch (error) {
    next(error);
  }
}

/**
 * Returns public-safe, minimal order status for tracking page.
 */
function getOrderStatus(req, res, next) {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required.' });
    }

    const order = getOrderByToken(token);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    const files = db.prepare(`
      SELECT original_filename, effective_pages, copies, color_mode, sides, file_subtotal
      FROM order_files WHERE order_id = ?
    `).all(order.id);

    return res.status(200).json({
      success: true,
      order: {
        token: order.token,
        machineId: order.machine_id,
        status: order.status,
        amountRupees: (order.total_amount_paise / 100).toFixed(2),
        currency: order.currency,
        createdAt: order.created_at,
        paidAt: order.paid_at,
        completedAt: order.completed_at,
        isExpired: isOrderExpired(order),
        filesCount: files.length,
        files
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  prepareOrder,
  getOrderStatus
};
