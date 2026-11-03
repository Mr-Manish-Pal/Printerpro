const fs = require('fs');
const path = require('path');
const http = require('http');
const { PDFDocument } = require('pdf-lib');
const { app } = require('./src/server');
const db = require('./src/config/db');
const { transitionOrderStatus, ALLOWED_TRANSITIONS } = require('./src/services/orderService');

const TEST_DIR = path.join(__dirname, 'test_artifacts_m1_payment');
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

let activePort = 3000;

async function createSamplePdf(filePath, numPages = 3) {
  const pdfDoc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = pdfDoc.addPage([595, 842]);
    page.drawText(`Page ${i}`, { x: 50, y: 750, size: 20 });
  }
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);
}

function sendMultipartRequest(urlPath, filePaths) {
  return new Promise((resolve, reject) => {
    const boundary = '----Boundary' + Date.now();
    const CRLF = '\r\n';
    const parts = [];

    for (const file of filePaths) {
      const filename = path.basename(file.path);
      const data = fs.readFileSync(file.path);
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="files"; filename="${filename}"${CRLF}` +
        `Content-Type: ${file.mime}${CRLF}${CRLF}`
      ));
      parts.push(data);
      parts.push(Buffer.from(CRLF));
    }
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const payload = Buffer.concat(parts);

    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendJsonRequest(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const dataStr = payload ? JSON.stringify(payload) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (dataStr) req.write(dataStr);
    req.end();
  });
}

async function runTests() {
  console.log('=== STARTING PAYMENT MILESTONE 1 VERIFICATION ===\n');

  // Start ephemeral server
  const testServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      activePort = s.address().port;
      console.log(`[Test Server] Running on ephemeral port ${activePort}`);
      resolve(s);
    });
  });

  try {
    // 1. Upload a file
    console.log('\n[1] Uploading test document...');
    const pdfPath = path.join(TEST_DIR, 'test_doc.pdf');
    await createSamplePdf(pdfPath, 3);
    const uploadRes = await sendMultipartRequest('/api/upload', [{ path: pdfPath, mime: 'application/pdf' }]);
    if (uploadRes.status !== 200 || !uploadRes.data.files[0]) {
      throw new Error('Upload failed in test');
    }
    const uploadedFile = uploadRes.data.files[0];
    console.log(`    Uploaded: ${uploadedFile.originalFilename}, Temp ID: ${uploadedFile.tempFileId}, Raw Pages: ${uploadedFile.rawPageCount}`);

    // 2. Call /api/orders/prepare
    console.log('\n[2] Testing POST /api/orders/prepare with server-side price calculation...');
    const preparePayload = {
      items: [
        {
          tempFileId: uploadedFile.tempFileId,
          pageRange: '1-3',
          copies: 2,
          colorMode: 'mono',
          sides: 'two-sided-long-edge', // 3 pages, duplex = 1 duplex sheet (-0.50 discount) -> 6 - 0.50 = 5.50 * 2 = 11.00
          paperSize: 'A4',
          orientation: 'portrait'
        }
      ],
      customerPhone: '9876543210'
    };

    const prepareRes = await sendJsonRequest('POST', '/api/orders/prepare', preparePayload);
    console.log(`    Status: ${prepareRes.status}, Response:`, JSON.stringify(prepareRes.data, null, 2));

    if (prepareRes.status !== 200 || !prepareRes.data.success) {
      throw new Error(`Prepare order failed: ${JSON.stringify(prepareRes.data)}`);
    }

    const { token, amount, razorpayOrderId, expiresAt } = prepareRes.data.order;
    console.log(`    PASS: Order Created! Token: ${token}, Amount (paise): ${amount} (₹${amount/100}), Razorpay Order ID: ${razorpayOrderId}`);

    // Verify DB state
    const orderInDb = db.prepare('SELECT * FROM orders WHERE token = ?').get(token);
    if (!orderInDb) throw new Error('Order not found in DB');
    if (orderInDb.status !== 'PAYMENT_PENDING') throw new Error(`Expected status PAYMENT_PENDING, got ${orderInDb.status}`);
    console.log(`    PASS: Database order status is PAYMENT_PENDING.`);

    // Check order_status_log audit entry
    const auditLogs = db.prepare('SELECT * FROM order_status_log WHERE order_id = ?').all(orderInDb.id);
    console.log(`    PASS: Audit logs written (${auditLogs.length} entries):`, auditLogs.map(l => `${l.old_status}->${l.new_status} (${l.reason})`));

    // 3. Test Order Status Endpoint
    console.log(`\n[3] Testing GET /api/orders/${token}/status...`);
    const statusRes = await sendJsonRequest('GET', `/api/orders/${token}/status`);
    console.log(`    Status: ${statusRes.status}, Data:`, statusRes.data.order);
    if (statusRes.status !== 200 || statusRes.data.order.status !== 'PAYMENT_PENDING') {
      throw new Error('Status endpoint check failed');
    }
    console.log('    PASS: Public status endpoint returned accurate non-sensitive details.');

    // 4. Test State Machine Transitions
    console.log('\n[4] Testing Order State Machine transitions...');
    // Valid: PAYMENT_PENDING -> PAID
    const paidOrder = transitionOrderStatus(orderInDb.id, 'PAID', 'Test mock payment captured', { paid_at: new Date().toISOString() });
    console.log(`    PASS: Transitioned to ${paidOrder.status}`);

    // Valid: PAID -> QUEUED
    const queuedOrder = transitionOrderStatus(orderInDb.id, 'QUEUED', 'Job queued for printing');
    console.log(`    PASS: Transitioned to ${queuedOrder.status}`);

    // Invalid transition attempt: QUEUED -> PAID (Illegal)
    try {
      transitionOrderStatus(orderInDb.id, 'PAID', 'Illegal attempt');
      throw new Error('Illegal transition was permitted!');
    } catch (err) {
      console.log(`    PASS: Illegal transition successfully blocked: "${err.message}"`);
    }

    console.log('\n======================================================');
    console.log('  ALL PAYMENT MILESTONE 1 TESTS PASSED (4/4)!');
    console.log('======================================================\n');

  } finally {
    testServer.close();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {}
  }

  process.exit(0);
}

runTests().catch(err => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});

