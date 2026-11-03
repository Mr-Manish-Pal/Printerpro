const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { app } = require('./src/server');
const db = require('./src/config/db');

const TEST_DIR = path.join(__dirname, 'test_artifacts_machine_m1');
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

let activePort = 3000;
const DEVICE_ID = 'kiosk-campus-01';
const DEVICE_SECRET = 'kiosk_device_secret_2026';

function generateHmacHeaders(method, path, bodyObj) {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyString = bodyObj ? JSON.stringify(bodyObj) : '';
  
  // Format: deviceId:METHOD:PATH:timestamp:nonce:body
  const canonicalPayload = `${DEVICE_ID}:${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${bodyString}`;
  const signature = crypto
    .createHmac('sha256', DEVICE_SECRET)
    .update(canonicalPayload)
    .digest('hex');

  return {
    'x-device-id': DEVICE_ID,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    'Content-Type': 'application/json'
  };
}

function sendRequest(method, urlPath, headers = {}, payload = null) {
  return new Promise((resolve, reject) => {
    const dataStr = payload ? JSON.stringify(payload) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path: urlPath,
      method,
      headers: {
        ...headers,
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

async function createSamplePdf(filePath) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]);
  page.drawText('AutoPrint Kiosk M1 Test', { x: 50, y: 750, size: 20 });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);
}

function sendMultipartUpload(filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----Boundary' + Date.now();
    const CRLF = '\r\n';
    const filename = path.basename(filePath);
    const data = fs.readFileSync(filePath);
    
    const parts = [
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="files"; filename="${filename}"${CRLF}` +
        `Content-Type: application/pdf${CRLF}${CRLF}`
      ),
      data,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}--${CRLF}`)
    ];
    const payload = Buffer.concat(parts);

    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path: '/api/upload',
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

async function runTests() {
  console.log('=== STARTING MACHINE REGISTRY & GATING (M1) TEST SUITE ===\n');

  // Launch test server
  const testServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      activePort = s.address().port;
      console.log(`[Test Server] Running on ephemeral port ${activePort}`);
      resolve(s);
    });
  });

  try {
    // Test 1: Seed Machine Exists
    console.log('\n[1] Verifying Seed Machine in SQLite...');
    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(DEVICE_ID);
    if (!machine || machine.name !== 'ECE Dept Main Kiosk') {
      throw new Error('Seed machine kiosk-campus-01 not found or malformed in DB');
    }
    console.log(`    PASS: Found "${machine.name}" (Paper remaining: ${machine.paper_remaining}, Status: ${machine.status})`);

    // Test 2: Device HMAC Authentication & Security Checks
    console.log('\n[2] Testing Device HMAC Authentication (POST /api/agent/heartbeat)...');
    
    // 2a. Missing headers
    const noHeadersRes = await sendRequest('POST', '/api/agent/heartbeat', {}, { test: 1 });
    if (noHeadersRes.status !== 401) throw new Error(`Expected 401 for missing headers, got ${noHeadersRes.status}`);
    console.log('    PASS: Missing headers rejected with 401.');

    // 2b. Tampered signature
    const validHeaders = generateHmacHeaders('POST', '/api/agent/heartbeat', { printerState: 'idle' });
    const forgedHeaders = { ...validHeaders, 'x-signature': '0000000000000000000000000000000000000000000000000000000000000000' };
    const forgedRes = await sendRequest('POST', '/api/agent/heartbeat', forgedHeaders, { printerState: 'idle' });
    if (forgedRes.status !== 401) throw new Error(`Expected 401 for tampered signature, got ${forgedRes.status}`);
    console.log('    PASS: Forged signature rejected with 401.');

    // 2c. Clock skew (>60s)
    const oldTimestampHeaders = generateHmacHeaders('POST', '/api/agent/heartbeat', { printerState: 'idle' });
    oldTimestampHeaders['x-timestamp'] = (Date.now() - 120000).toString(); // 2 minutes ago
    const skewRes = await sendRequest('POST', '/api/agent/heartbeat', oldTimestampHeaders, { printerState: 'idle' });
    if (skewRes.status !== 401) throw new Error(`Expected 401 for clock skew, got ${skewRes.status}`);
    console.log('    PASS: Clock skew (>60s) rejected with 401.');

    // 2d. Valid authenticated heartbeat
    const heartbeatPayload = {
      printerState: 'idle',
      printerReasons: 'none',
      cpuTemp: 43.8,
      throttlingFlags: '0x0',
      wifiSignalDbm: -58,
      diskFreeMb: 14200,
      doorClosed: 1,
      paperRemaining: 490,
      agentVersion: '1.0.0'
    };
    const hbHeaders = generateHmacHeaders('POST', '/api/agent/heartbeat', heartbeatPayload);
    const hbRes = await sendRequest('POST', '/api/agent/heartbeat', hbHeaders, heartbeatPayload);
    if (hbRes.status !== 200 || !hbRes.data.acknowledged) {
      throw new Error(`Heartbeat failed: ${JSON.stringify(hbRes.data)}`);
    }
    console.log('    PASS: Legitimate signed heartbeat accepted with 200 OK.');

    // 2e. Replay attack with same nonce
    const replayRes = await sendRequest('POST', '/api/agent/heartbeat', hbHeaders, heartbeatPayload);
    if (replayRes.status !== 401 || !replayRes.data.error.includes('Replay attack detected')) {
      throw new Error(`Expected 401 for replayed nonce, got ${replayRes.status}`);
    }
    console.log('    PASS: Replay attack with identical nonce blocked successfully.');

    // Test 3: Public Machine Status Gating Check
    console.log('\n[3] Testing Public Machine Status (GET /api/machine/:machineId/status)...');
    const pubStatus = await sendRequest('GET', `/api/machine/${DEVICE_ID}/status`);
    if (pubStatus.status !== 200 || !pubStatus.data.available) {
      throw new Error(`Expected machine to be available, got ${JSON.stringify(pubStatus.data)}`);
    }
    console.log(`    PASS: Machine status reports available: true (Paper: ${pubStatus.data.paperRemaining})`);

    // Prepare a test uploaded document for order gating tests
    const pdfPath = path.join(TEST_DIR, 'test_sample.pdf');
    await createSamplePdf(pdfPath);
    const uploadRes = await sendMultipartUpload(pdfPath);
    const testFile = uploadRes.data.files[0];

    const prepareBody = {
      items: [
        {
          tempFileId: testFile.tempFileId,
          pageRange: '1',
          copies: 1,
          colorMode: 'mono',
          sides: 'one-sided'
        }
      ],
      machineId: DEVICE_ID
    };

    // Test 4: Order Creation Succeeds when Machine is Healthy
    console.log('\n[4] Testing Order Preparation on Healthy Machine...');
    const healthyOrderRes = await sendRequest('POST', '/api/orders/prepare', { 'Content-Type': 'application/json' }, prepareBody);
    if (healthyOrderRes.status !== 200 || !healthyOrderRes.data.success) {
      throw new Error(`Order preparation failed on healthy machine: ${JSON.stringify(healthyOrderRes.data)}`);
    }
    console.log(`    PASS: Order prepared successfully! Token: ${healthyOrderRes.data.order.token}`);

    // Test 5: FAULT INJECTION 1 — Stale Heartbeat (Machine Offline)
    console.log('\n[5] FAULT INJECTION 1: Machine Heartbeat Stale (>90s)...');
    db.prepare("UPDATE machines SET last_heartbeat_at = datetime('now', '-180 seconds') WHERE id = ?").run(DEVICE_ID);
    
    const offlineStatusRes = await sendRequest('GET', `/api/machine/${DEVICE_ID}/status`);
    console.log(`    Status Response: available=${offlineStatusRes.data.available}, reason=${offlineStatusRes.data.reason}`);
    if (offlineStatusRes.data.available !== false || offlineStatusRes.data.reason !== 'MACHINE_OFFLINE') {
      throw new Error('Offline status was not detected correctly');
    }

    const offlineOrderRes = await sendRequest('POST', '/api/orders/prepare', { 'Content-Type': 'application/json' }, prepareBody);
    if (offlineOrderRes.status !== 403 || !offlineOrderRes.data.error.includes('offline')) {
      throw new Error(`Expected 403 Forbidden for offline machine, got ${offlineOrderRes.status}`);
    }
    console.log(`    PASS: Pre-payment gating blocked order creation: "${offlineOrderRes.data.error}"`);

    // Test 6: FAULT INJECTION 2 — Physical Cabinet Door Open (Tamper Alarm)
    console.log('\n[6] FAULT INJECTION 2: Cabinet Door Tamper Opened...');
    db.prepare("UPDATE machines SET last_heartbeat_at = datetime('now'), door_closed = 0, status = 'TAMPER_LOCK' WHERE id = ?").run(DEVICE_ID);

    const tamperOrderRes = await sendRequest('POST', '/api/orders/prepare', { 'Content-Type': 'application/json' }, prepareBody);
    if (tamperOrderRes.status !== 403 || tamperOrderRes.data.reason !== 'TAMPER_LOCK') {
      throw new Error(`Expected 403 TAMPER_LOCK, got ${tamperOrderRes.status}`);
    }
    console.log(`    PASS: Tamper alarm blocked order creation: "${tamperOrderRes.data.error}"`);

    // Test 7: FAULT INJECTION 3 — Paper Out (<5 sheets)
    console.log('\n[7] FAULT INJECTION 3: Paper Depleted (3 sheets remaining)...');
    db.prepare("UPDATE machines SET door_closed = 1, status = 'ONLINE', paper_remaining = 3 WHERE id = ?").run(DEVICE_ID);

    const paperOutOrderRes = await sendRequest('POST', '/api/orders/prepare', { 'Content-Type': 'application/json' }, prepareBody);
    if (paperOutOrderRes.status !== 403 || paperOutOrderRes.data.reason !== 'OUT_OF_PAPER') {
      throw new Error(`Expected 403 OUT_OF_PAPER, got ${paperOutOrderRes.status}`);
    }
    console.log(`    PASS: Paper depletion blocked order creation: "${paperOutOrderRes.data.error}"`);

    // Test 8: Recovery — Paper Refill & Online Status
    console.log('\n[8] Testing Recovery: Admin Paper Refill & Heartbeat Recovery...');
    const refillRes = await sendRequest('POST', `/api/admin/machines/${DEVICE_ID}/refill`, { 'Content-Type': 'application/json' }, { sheets: 500 });
    if (refillRes.status !== 200) throw new Error('Refill failed');

    // Fresh heartbeat
    const recoveryPayload = { printerState: 'idle', doorClosed: 1, paperRemaining: 500 };
    const recHeaders = generateHmacHeaders('POST', '/api/agent/heartbeat', recoveryPayload);
    await sendRequest('POST', '/api/agent/heartbeat', recHeaders, recoveryPayload);

    // Upload a new document for the recovery order
    const pdfPath2 = path.join(TEST_DIR, 'test_sample_2.pdf');
    await createSamplePdf(pdfPath2);
    const uploadRes2 = await sendMultipartUpload(pdfPath2);
    const recoveryFile = uploadRes2.data.files[0];

    const recoveryPrepareBody = {
      items: [
        {
          tempFileId: recoveryFile.tempFileId,
          pageRange: '1',
          copies: 1,
          colorMode: 'mono',
          sides: 'one-sided'
        }
      ],
      machineId: DEVICE_ID
    };

    const recoveryOrderRes = await sendRequest('POST', '/api/orders/prepare', { 'Content-Type': 'application/json' }, recoveryPrepareBody);
    if (recoveryOrderRes.status !== 200 || !recoveryOrderRes.data.success) {
      throw new Error(`Order creation failed after recovery: ${JSON.stringify(recoveryOrderRes.data)}`);
    }
    console.log(`    PASS: Kiosk fully recovered! Order created with token: ${recoveryOrderRes.data.order.token}`);

    console.log('\n======================================================');
    console.log('  ALL MILESTONE 1 MACHINE GATING TESTS PASSED (8/8)!');
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
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
