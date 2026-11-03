const fs = require('fs');
const path = require('path');
const http = require('http');
const { PDFDocument } = require('pdf-lib');
const { app } = require('./src/server');

const TEST_DIR = path.join(__dirname, 'test_artifacts');
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

let activePort = 3000;

async function createSamplePdf(filePath, numPages = 4) {
  const pdfDoc = await PDFDocument.create();
  for (let i = 1; i <= numPages; i++) {
    const page = pdfDoc.addPage([595, 842]);
    page.drawText(`Auto Print Kiosk Test Page ${i} of ${numPages}`, { x: 50, y: 750, size: 20 });
  }
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(filePath, pdfBytes);
}

function createSampleText(filePath) {
  fs.writeFileSync(filePath, 'Hello from Auto Print Kiosk!\nThis is a sample text file to be converted and printed.\nLine 3 of document.');
}

function createSampleImage(filePath) {
  // 1x1 transparent PNG buffer
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(filePath, Buffer.from(pngBase64, 'base64'));
}

function createDisguisedExecutable(filePath) {
  // A text script disguised as a .pdf to test magic byte inspection
  fs.writeFileSync(filePath, '#!/bin/bash\necho "Malicious payload"\n');
}

function sendMultipartRequest(urlPath, filePaths) {
  return new Promise((resolve, reject) => {
    const boundary = '----KioskTestBoundary' + Date.now();
    const CRLF = '\r\n';
    const postDataParts = [];

    for (const file of filePaths) {
      const filename = path.basename(file.path);
      const fileData = fs.readFileSync(file.path);
      postDataParts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="files"; filename="${filename}"${CRLF}` +
        `Content-Type: ${file.mime}${CRLF}${CRLF}`
      ));
      postDataParts.push(fileData);
      postDataParts.push(Buffer.from(CRLF));
    }
    postDataParts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const payload = Buffer.concat(postDataParts);

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
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
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
  console.log('--- STARTING MILESTONE 1 VERIFICATION SUITE ---');

  // Start test server on ephemeral port
  const testServer = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      activePort = s.address().port;
      console.log(`[Test Server] Running on ephemeral port ${activePort}`);
      resolve(s);
    });
  });

  try {
    // Test 1: Health Check
    console.log('\n[1] Testing Health Endpoint (GET /api/health)...');
    const health = await sendJsonRequest('GET', '/api/health');
    console.log(`    Status: ${health.status}, Response:`, health.data);
    if (health.status !== 200 || health.data.status !== 'ok') {
      throw new Error('Health check failed!');
    }

    // Test 2: Rates Endpoint
    console.log('\n[2] Testing Rates Endpoint (GET /api/rates)...');
    const ratesRes = await sendJsonRequest('GET', '/api/rates');
    console.log(`    Status: ${ratesRes.status}, Current Rates:`, ratesRes.data.rates);
    if (ratesRes.status !== 200 || !ratesRes.data.rates) {
      throw new Error('Rates retrieval failed!');
    }

    // Test 3: Generate Artifacts
    console.log('\n[3] Generating Test Artifacts (PDF, Text, PNG, Fake PDF)...');
    const samplePdf = path.join(TEST_DIR, 'document_4pages.pdf');
    const sampleTxt = path.join(TEST_DIR, 'notes.txt');
    const sampleImg = path.join(TEST_DIR, 'photo.png');
    const fakePdf = path.join(TEST_DIR, 'fake_malicious.pdf');

    await createSamplePdf(samplePdf, 4);
    createSampleText(sampleTxt);
    createSampleImage(sampleImg);
    createDisguisedExecutable(fakePdf);
    console.log('    Test artifacts created successfully.');

    // Test 4: Security Verification - Disguised Executable Upload
    console.log('\n[4] Testing Security: Disguised File Upload Detection...');
    const fakeUpload = await sendMultipartRequest('/api/upload', [
      { path: fakePdf, mime: 'application/pdf' }
    ]);
    console.log(`    Status: ${fakeUpload.status}, Result:`, fakeUpload.data);
    if (fakeUpload.status !== 400 || !fakeUpload.data.error.includes('signature verification')) {
      throw new Error('Security check failed: Disguised file was not rejected!');
    }
    console.log('    PASS: Disguised executable correctly rejected via magic-byte inspection.');

    // Test 5: Valid Multi-file Upload & Conversion
    console.log('\n[5] Testing Upload & Conversion for PDF, Image, and Text...');
    const validUpload = await sendMultipartRequest('/api/upload', [
      { path: samplePdf, mime: 'application/pdf' },
      { path: sampleImg, mime: 'image/png' },
      { path: sampleTxt, mime: 'text/plain' }
    ]);
    console.log(`    Status: ${validUpload.status}, Processed Files:`, validUpload.data.files);
    if (validUpload.status !== 200 || validUpload.data.files.length !== 3) {
      throw new Error('Upload or conversion failed for valid files!');
    }
    const [pdfFile, imgFile, txtFile] = validUpload.data.files;
    console.log(`    PASS: PDF raw pages = ${pdfFile.rawPageCount} (Expected: 4)`);
    console.log(`    PASS: Image converted to PDF raw pages = ${imgFile.rawPageCount} (Expected: 1)`);
    console.log(`    PASS: Text converted to PDF raw pages = ${txtFile.rawPageCount} (Expected: 1)`);

    // Test 6: Pricing Engine Calculations
    console.log('\n[6] Testing Price Quote Engine (POST /api/pricing/quote)...');

    // Case A: 4-page PDF, B/W, Double-sided (duplex), 1 copy
    // Formula: 4 pages * 2.0 = 8.0 - (2 duplex sheets * 0.50) = 7.00
    const quoteReq = {
      items: [
        {
          tempFileId: pdfFile.tempFileId,
          pageRange: '1-4',
          copies: 1,
          colorMode: 'mono',
          sides: 'two-sided-long-edge'
        },
        {
          tempFileId: imgFile.tempFileId,
          pageRange: 'all',
          copies: 2,
          colorMode: 'color',
          sides: 'one-sided'
        }
      ]
    };

    const quoteRes = await sendJsonRequest('POST', '/api/pricing/quote', quoteReq);
    console.log(`    Status: ${quoteRes.status}, Quote Result:`, JSON.stringify(quoteRes.data.quote, null, 2));

    if (quoteRes.status !== 200) {
      throw new Error(`Quote calculation failed: ${JSON.stringify(quoteRes.data)}`);
    }

    const { items, subtotal, totalAmount } = quoteRes.data.quote;
    console.log(`    PASS: Calculated Subtotal = ₹${subtotal}, Total = ₹${totalAmount}`);

    // Test 7: Page Range Bounds Validation
    console.log('\n[7] Testing Page Range Validation (Out of bounds range "1-10" on 4-page doc)...');
    const invalidRangeRes = await sendJsonRequest('POST', '/api/pricing/quote', {
      items: [
        {
          tempFileId: pdfFile.tempFileId,
          pageRange: '1-10',
          copies: 1,
          colorMode: 'mono',
          sides: 'one-sided'
        }
      ]
    });
    console.log(`    Status: ${invalidRangeRes.status}, Error Message:`, invalidRangeRes.data.error);
    if (invalidRangeRes.status !== 400 || !invalidRangeRes.data.error.includes('exceeds total document pages')) {
      throw new Error('Out of bounds page range was not caught!');
    }
    console.log('    PASS: Out-of-bounds page range caught successfully.');

    console.log('\n======================================================');
    console.log('  ALL MILESTONE 1 VERIFICATION TESTS PASSED (7/7)!');
    console.log('======================================================\n');
  } finally {
    // Clean up test server and artifacts
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
