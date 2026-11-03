/**
 * AutoPrint Kiosk - Client-side Controller
 * Mobile-first, zero-framework, reactive UX.
 */

// Global State
let kioskRates = {
  bwPerPage: 2.0,
  colorPerPage: 10.0,
  duplexDiscountPerSheet: 0.5,
  minOrderAmount: 5.0,
  serviceCharge: 0.0
};

// Current target machine from QR code parameter (?machine=kiosk-campus-01)
const urlParams = new URLSearchParams(window.location.search);
const currentMachineId = urlParams.get('machine') || 'kiosk-campus-01';
let isMachineReady = false;
let machineStatusData = null;

let uploadedFiles = [];
let quoteDebounceTimer = null;

// DOM Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const uploadProgressContainer = document.getElementById('uploadProgressContainer');
const uploadProgressBar = document.getElementById('uploadProgressBar');
const uploadProgressPercent = document.getElementById('uploadProgressPercent');
const uploadProgressText = document.getElementById('uploadProgressText');

const filesSection = document.getElementById('filesSection');
const fileCardsList = document.getElementById('fileCardsList');
const fileCountBadge = document.getElementById('fileCountBadge');
const addMoreBtn = document.getElementById('addMoreBtn');

const summarySection = document.getElementById('summarySection');
const summarySubtotal = document.getElementById('summarySubtotal');
const serviceChargeRow = document.getElementById('serviceChargeRow');
const summaryServiceCharge = document.getElementById('summaryServiceCharge');
const minAdjustmentRow = document.getElementById('minAdjustmentRow');
const summaryMinAdjustment = document.getElementById('summaryMinAdjustment');
const summaryTotal = document.getElementById('summaryTotal');

const checkoutBar = document.getElementById('checkoutBar');
const barTotal = document.getElementById('barTotal');
const proceedPayBtn = document.getElementById('proceedPayBtn');
const toastEl = document.getElementById('toast');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  fetchRates();
  checkMachineStatus();
  setupEventListeners();
  // Poll machine status every 30 seconds
  setInterval(checkMachineStatus, 30000);
});

// Check physical kiosk readiness before allowing user interactions
async function checkMachineStatus() {
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');

  try {
    const res = await fetch(`/api/machine/${encodeURIComponent(currentMachineId)}/status`);
    const data = await res.json();
    machineStatusData = data;

    if (data.success && data.available) {
      isMachineReady = true;
      if (statusIndicator) statusIndicator.className = 'status-indicator online';
      if (statusText) statusText.textContent = `${data.name || 'Kiosk'} (Ready)`;
      proceedPayBtn.removeAttribute('disabled');
      proceedPayBtn.style.opacity = '1';
    } else {
      isMachineReady = false;
      if (statusIndicator) statusIndicator.className = 'status-indicator error';
      const msg = data.reason === 'OUT_OF_PAPER' ? 'Out of Paper' : (data.reason === 'TAMPER_LOCK' ? 'Maintenance Lock' : 'Offline');
      if (statusText) statusText.textContent = `Unavailable: ${msg}`;
      proceedPayBtn.setAttribute('disabled', 'true');
      proceedPayBtn.style.opacity = '0.6';
    }
  } catch (err) {
    console.error('Failed to query machine status:', err);
    isMachineReady = false;
    if (statusIndicator) statusIndicator.className = 'status-indicator error';
    if (statusText) statusText.textContent = 'Server Unreachable';
  }
}

// Fetch current pricing card from server
async function fetchRates() {
  try {
    const res = await fetch('/api/rates');
    const data = await res.json();
    if (data.success && data.rates) {
      kioskRates = data.rates;
      document.getElementById('rateBw').textContent = `₹${kioskRates.bwPerPage.toFixed(2)}`;
      document.getElementById('rateColor').textContent = `₹${kioskRates.colorPerPage.toFixed(2)}`;
      document.getElementById('rateDuplex').textContent = `₹${kioskRates.duplexDiscountPerSheet.toFixed(2)}`;
    }
  } catch (err) {
    console.warn('Could not fetch latest rates, using defaults.', err);
  }
}

// Setup Event Listeners
function setupEventListeners() {
  browseBtn.addEventListener('click', () => fileInput.click());
  addMoreBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesUpload(Array.from(e.target.files));
      fileInput.value = ''; // Reset input for re-selection
    }
  });

  // Drag and drop events
  ['dragenter', 'dragover'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropzone.addEventListener(name, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesUpload(Array.from(e.dataTransfer.files));
    }
  });

  proceedPayBtn.addEventListener('click', onProceedToPay);
}

// --- Upload Handling with Progress ---
function handleFilesUpload(files) {
  if (files.length === 0) return;

  const formData = new FormData();
  files.forEach(f => formData.append('files', f));

  // Show progress bar
  uploadProgressContainer.classList.remove('hidden');
  uploadProgressBar.style.width = '0%';
  uploadProgressPercent.textContent = '0%';
  uploadProgressText.textContent = `Uploading ${files.length} document(s)...`;

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 90); // 90% is network upload, 10% is conversion
      uploadProgressBar.style.width = `${percent}%`;
      uploadProgressPercent.textContent = `${percent}%`;
      if (percent >= 90) {
        uploadProgressText.textContent = 'Converting documents & counting pages...';
      }
    }
  };

  xhr.onload = () => {
    uploadProgressContainer.classList.add('hidden');
    if (xhr.status === 200) {
      try {
        const response = JSON.parse(xhr.responseText);
        if (response.success && response.files) {
          response.files.forEach(f => {
            uploadedFiles.push({
              tempFileId: f.tempFileId,
              originalFilename: f.originalFilename,
              rawPageCount: f.rawPageCount,
              effectivePages: f.effectivePages,
              copies: f.copies || 1,
              colorMode: f.colorMode || 'mono',
              sides: f.sides || 'one-sided',
              paperSize: f.paperSize || 'A4',
              orientation: f.orientation || 'portrait',
              pageRange: f.pageRange || 'all',
              fileTotal: 0
            });
          });

          renderFileCards();
          fetchLiveQuote();
          showToast(`Uploaded & processed ${response.files.length} file(s)!`, 'success');
        } else {
          showToast(response.error || 'Upload failed', 'error');
        }
      } catch (err) {
        showToast('Invalid response from server.', 'error');
      }
    } else {
      let errMessage = 'Upload failed. Please check file format and size.';
      try {
        const errObj = JSON.parse(xhr.responseText);
        if (errObj.error) errMessage = errObj.error;
      } catch (e) {}
      showToast(errMessage, 'error');
    }
  };

  xhr.onerror = () => {
    uploadProgressContainer.classList.add('hidden');
    showToast('Network error during upload.', 'error');
  };

  xhr.send(formData);
}

// --- Render File Cards ---
function renderFileCards() {
  if (uploadedFiles.length === 0) {
    filesSection.classList.add('hidden');
    summarySection.classList.add('hidden');
    checkoutBar.classList.add('hidden');
    return;
  }

  filesSection.classList.remove('hidden');
  summarySection.classList.remove('hidden');
  checkoutBar.classList.remove('hidden');
  fileCountBadge.textContent = `${uploadedFiles.length} File${uploadedFiles.length > 1 ? 's' : ''}`;

  fileCardsList.innerHTML = '';

  uploadedFiles.forEach((file, index) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.index = index;

    const fileIcon = getFileIcon(file.originalFilename);

    card.innerHTML = `
      <div class="file-card-top">
        <div class="file-info">
          <div class="file-doc-icon">${fileIcon}</div>
          <div class="file-name-meta">
            <h4 class="file-name" title="${escapeHtml(file.originalFilename)}">${escapeHtml(file.originalFilename)}</h4>
            <div class="file-meta-badges">
              <span class="meta-pill pages">${file.rawPageCount} Total Pages</span>
              <span class="meta-pill">${escapeHtml(file.paperSize)}</span>
            </div>
          </div>
        </div>
        <button type="button" class="btn-remove-file" onclick="removeFile(${index})" title="Remove file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="options-grid">
        <!-- Color Mode -->
        <div class="option-group">
          <label class="option-label">Color Mode</label>
          <div class="pill-group">
            <button type="button" class="pill-btn ${file.colorMode === 'mono' ? 'active' : ''}" onclick="updateOption(${index}, 'colorMode', 'mono')">
              B/W (₹${kioskRates.bwPerPage})
            </button>
            <button type="button" class="pill-btn ${file.colorMode === 'color' ? 'active' : ''}" onclick="updateOption(${index}, 'colorMode', 'color')">
              Color (₹${kioskRates.colorPerPage})
            </button>
          </div>
        </div>

        <!-- Sides / Duplex -->
        <div class="option-group">
          <label class="option-label">Sides</label>
          <div class="pill-group">
            <button type="button" class="pill-btn ${file.sides === 'one-sided' ? 'active' : ''}" onclick="updateOption(${index}, 'sides', 'one-sided')">
              Single-Sided
            </button>
            <button type="button" class="pill-btn ${file.sides === 'two-sided-long-edge' ? 'active' : ''}" onclick="updateOption(${index}, 'sides', 'two-sided-long-edge')">
              Double-Sided
            </button>
          </div>
        </div>

        <!-- Copies Stepper -->
        <div class="option-group">
          <label class="option-label">Copies</label>
          <div class="stepper">
            <button type="button" class="stepper-btn" onclick="stepCopies(${index}, -1)">−</button>
            <input type="number" class="stepper-input" value="${file.copies}" min="1" max="99" onchange="onCopiesChange(${index}, this.value)" readonly>
            <button type="button" class="stepper-btn" onclick="stepCopies(${index}, 1)">+</button>
          </div>
        </div>

        <!-- Page Range -->
        <div class="option-group">
          <label class="option-label">Page Range</label>
          <input type="text" class="input-text" value="${escapeHtml(file.pageRange)}" placeholder="e.g. all or 1-3,5" oninput="onPageRangeChange(${index}, this.value)">
        </div>

        <!-- Paper Size -->
        <div class="option-group">
          <label class="option-label">Paper Size</label>
          <select class="select-input" onchange="updateOption(${index}, 'paperSize', this.value)">
            <option value="A4" ${file.paperSize === 'A4' ? 'selected' : ''}>A4 (Standard)</option>
            <option value="Letter" ${file.paperSize === 'Letter' ? 'selected' : ''}>Letter</option>
            <option value="Legal" ${file.paperSize === 'Legal' ? 'selected' : ''}>Legal</option>
          </select>
        </div>

        <!-- Orientation -->
        <div class="option-group">
          <label class="option-label">Orientation</label>
          <select class="select-input" onchange="updateOption(${index}, 'orientation', this.value)">
            <option value="portrait" ${file.orientation === 'portrait' ? 'selected' : ''}>Portrait</option>
            <option value="landscape" ${file.orientation === 'landscape' ? 'selected' : ''}>Landscape</option>
          </select>
        </div>
      </div>

      <div class="file-card-bottom">
        <span class="file-effective-pages" id="effPages_${index}">
          Printing: <strong>${file.effectivePages} page${file.effectivePages > 1 ? 's' : ''}</strong> × ${file.copies} cop${file.copies > 1 ? 'ies' : 'y'}
        </span>
        <span class="file-price" id="filePrice_${index}">₹${file.fileTotal.toFixed(2)}</span>
      </div>
    `;

    fileCardsList.appendChild(card);
  });
}

// Option Update Handlers
window.updateOption = function(index, key, value) {
  if (!uploadedFiles[index]) return;
  uploadedFiles[index][key] = value;
  renderFileCards();
  fetchLiveQuote();
};

window.stepCopies = function(index, delta) {
  if (!uploadedFiles[index]) return;
  const current = uploadedFiles[index].copies || 1;
  const next = Math.max(1, Math.min(99, current + delta));
  uploadedFiles[index].copies = next;
  renderFileCards();
  fetchLiveQuote();
};

window.onCopiesChange = function(index, val) {
  if (!uploadedFiles[index]) return;
  const num = parseInt(val, 10);
  uploadedFiles[index].copies = isNaN(num) || num < 1 ? 1 : Math.min(99, num);
  renderFileCards();
  fetchLiveQuote();
};

window.onPageRangeChange = function(index, val) {
  if (!uploadedFiles[index]) return;
  uploadedFiles[index].pageRange = val || 'all';
  // Debounce server quote request
  clearTimeout(quoteDebounceTimer);
  quoteDebounceTimer = setTimeout(fetchLiveQuote, 350);
};

window.removeFile = function(index) {
  uploadedFiles.splice(index, 1);
  renderFileCards();
  fetchLiveQuote();
};

// --- Server-Side Quote Request ---
async function fetchLiveQuote() {
  if (uploadedFiles.length === 0) {
    updateSummaryDisplay({ subtotal: 0, serviceCharge: 0, minOrderAdjustment: 0, totalAmount: 0, items: [] });
    return;
  }

  const items = uploadedFiles.map(f => ({
    tempFileId: f.tempFileId,
    colorMode: f.colorMode,
    sides: f.sides,
    copies: f.copies,
    pageRange: f.pageRange || 'all',
    paperSize: f.paperSize,
    orientation: f.orientation
  }));

  try {
    const res = await fetch('/api/pricing/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });

    const data = await res.json();
    if (data.success && data.quote) {
      updateSummaryDisplay(data.quote);
    } else {
      showToast(data.error || 'Failed to update price quote', 'error');
    }
  } catch (err) {
    console.error('Error fetching quote:', err);
  }
}

// Update UI with calculated breakdown
function updateSummaryDisplay(quote) {
  // Update per-file price labels
  if (quote.items) {
    quote.items.forEach((item, idx) => {
      if (uploadedFiles[idx]) {
        uploadedFiles[idx].effectivePages = item.effectivePages;
        uploadedFiles[idx].fileTotal = item.fileTotal;

        const priceEl = document.getElementById(`filePrice_${idx}`);
        const effPagesEl = document.getElementById(`effPages_${idx}`);
        if (priceEl) priceEl.textContent = `₹${item.fileTotal.toFixed(2)}`;
        if (effPagesEl) {
          effPagesEl.innerHTML = `Printing: <strong>${item.effectivePages} page${item.effectivePages > 1 ? 's' : ''}</strong> × ${item.copies} cop${item.copies > 1 ? 'ies' : 'y'}`;
        }
      }
    });
  }

  summarySubtotal.textContent = `₹${quote.subtotal.toFixed(2)}`;

  if (quote.serviceCharge > 0) {
    serviceChargeRow.classList.remove('hidden');
    summaryServiceCharge.textContent = `₹${quote.serviceCharge.toFixed(2)}`;
  } else {
    serviceChargeRow.classList.add('hidden');
  }

  if (quote.minOrderAdjustment > 0) {
    minAdjustmentRow.classList.remove('hidden');
    summaryMinAdjustment.textContent = `+ ₹${quote.minOrderAdjustment.toFixed(2)}`;
  } else {
    minAdjustmentRow.classList.add('hidden');
  }

  const totalFormatted = `₹${quote.totalAmount.toFixed(2)}`;
  summaryTotal.textContent = totalFormatted;
  barTotal.textContent = totalFormatted;
}

// Proceed to payment (Enforces machine gating)
function onProceedToPay() {
  if (!isMachineReady) {
    const errorMsg = machineStatusData?.message || 'This kiosk is currently unavailable. You will not be charged.';
    showToast(errorMsg, 'error');
    return;
  }

  if (uploadedFiles.length === 0) {
    showToast('Please upload at least one document.', 'error');
    return;
  }
  showToast('Machine verified! Connecting to payment...', 'success');
}

// Helper: Show toast notification
function showToast(msg, type = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${type}`;
  toastEl.classList.remove('hidden');

  setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 3500);
}

// Helper: Document Icon by extension
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'pdf': return '📄';
    case 'doc':
    case 'docx': return '📝';
    case 'ppt':
    case 'pptx': return '📊';
    case 'xls':
    case 'xlsx': return '📈';
    case 'jpg':
    case 'jpeg':
    case 'png': return '🖼️';
    default: return '📃';
  }
}

// Helper: XSS-safe escape
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

