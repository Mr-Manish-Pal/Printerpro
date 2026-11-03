const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data folder exists
const dbDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'kiosk.db');
const db = new Database(dbPath);

// Enable WAL mode for high performance & concurrency; enable foreign key constraints
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
function initSchema() {
  const schema = `
    -- Global Rate Configuration (Singleton id=1)
    CREATE TABLE IF NOT EXISTS rates (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bw_per_page REAL NOT NULL DEFAULT 2.00,
      color_per_page REAL NOT NULL DEFAULT 10.00,
      duplex_discount_per_sheet REAL NOT NULL DEFAULT 0.50,
      min_order_amount REAL NOT NULL DEFAULT 5.00,
      service_charge REAL NOT NULL DEFAULT 0.00,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Physical Kiosk Vending Machines
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location_description TEXT,
      api_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OFFLINE'
        CHECK(status IN ('ONLINE', 'BUSY', 'OFFLINE', 'MAINTENANCE', 'TAMPER_LOCK')),
      paper_capacity INTEGER NOT NULL DEFAULT 500,
      paper_remaining INTEGER NOT NULL DEFAULT 500,
      low_paper_threshold INTEGER NOT NULL DEFAULT 25,
      door_closed INTEGER NOT NULL DEFAULT 1,
      last_heartbeat_at TEXT,
      ip_address TEXT,
      agent_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Machine Telemetry & Health History
    CREATE TABLE IF NOT EXISTS machine_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      printer_state TEXT NOT NULL,
      printer_reasons TEXT,
      cpu_temp REAL,
      throttling_flags TEXT,
      wifi_signal_dbm INTEGER,
      disk_free_mb INTEGER,
      door_closed INTEGER NOT NULL DEFAULT 1,
      paper_remaining INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Customer Orders with Unified State Machine & Machine Assignment
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      machine_id TEXT NOT NULL DEFAULT 'kiosk-campus-01' REFERENCES machines(id),
      status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK(status IN (
          'CREATED','PAYMENT_PENDING','PAID','QUEUED','PRINTING','DONE',
          'PAYMENT_FAILED','EXPIRED','PRINT_FAILED',
          'NEEDS_REVIEW','REFUND_PENDING','REFUNDED'
        )),
      total_amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      razorpay_order_id TEXT UNIQUE,
      razorpay_payment_id TEXT UNIQUE,
      refund_id TEXT,
      customer_phone TEXT,
      failure_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      completed_at TEXT
    );

    -- Active Job Leases (Guaranteeing At-Most-Once Execution)
    CREATE TABLE IF NOT EXISTS job_leases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      machine_id TEXT NOT NULL REFERENCES machines(id),
      lease_token TEXT NOT NULL UNIQUE,
      leased_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK(status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'FAILED'))
    );

    -- Files within an Order
    CREATE TABLE IF NOT EXISTS order_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      temp_file_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_pdf_filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      raw_page_count INTEGER NOT NULL DEFAULT 1,
      page_range TEXT DEFAULT 'all',
      effective_pages INTEGER NOT NULL DEFAULT 1,
      copies INTEGER NOT NULL DEFAULT 1,
      color_mode TEXT NOT NULL DEFAULT 'mono' CHECK(color_mode IN ('mono', 'color')),
      sides TEXT NOT NULL DEFAULT 'one-sided' CHECK(sides IN ('one-sided', 'two-sided-long-edge')),
      paper_size TEXT NOT NULL DEFAULT 'A4' CHECK(paper_size IN ('A4', 'Letter', 'Legal')),
      orientation TEXT NOT NULL DEFAULT 'portrait' CHECK(orientation IN ('portrait', 'landscape')),
      file_subtotal REAL NOT NULL DEFAULT 0.00,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Payment Records
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT UNIQUE,
      razorpay_signature TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      method TEXT,
      status TEXT NOT NULL DEFAULT 'CREATED'
        CHECK(status IN ('CREATED','AUTHORIZED','CAPTURED','FAILED','REFUNDED')),
      raw_payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Webhook Events (for Idempotent processing)
    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      razorpay_payment_id TEXT,
      processed INTEGER NOT NULL DEFAULT 0,
      raw_payload TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Order Status Audit Log
    CREATE TABLE IF NOT EXISTS order_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      old_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      reason TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Print Logs for Agent Auditing
    CREATE TABLE IF NOT EXISTS print_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id),
      file_id INTEGER REFERENCES order_files(id),
      printer_name TEXT NOT NULL,
      cups_job_id INTEGER,
      status TEXT NOT NULL CHECK(status IN ('STARTED', 'SUCCESS', 'CUPS_ERROR', 'PRINTER_OFFLINE', 'JAM')),
      details TEXT,
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Admin Users
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token);
    CREATE INDEX IF NOT EXISTS idx_orders_machine ON orders(machine_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_rzp_order ON orders(razorpay_order_id);
    CREATE INDEX IF NOT EXISTS idx_order_files_temp_id ON order_files(temp_file_id);
    CREATE INDEX IF NOT EXISTS idx_order_files_order_id ON order_files(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_rzp_payment_id ON payments(razorpay_payment_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_id ON webhook_events(event_id);
    CREATE INDEX IF NOT EXISTS idx_machine_heartbeats_time ON machine_heartbeats(recorded_at);
  `;

  db.exec(schema);

  // Seed default rate card if empty
  const rateRow = db.prepare('SELECT id FROM rates WHERE id = 1').get();
  if (!rateRow) {
    db.prepare(`
      INSERT INTO rates (id, bw_per_page, color_per_page, duplex_discount_per_sheet, min_order_amount, service_charge)
      VALUES (1, 2.00, 10.00, 0.50, 5.00, 0.00)
    `).run();
    console.log('[DB] Seeded default rate card (B/W: ₹2.00, Color: ₹10.00, Duplex discount: ₹0.50, Min order: ₹5.00)');
  }

  // Seed default Machine 1 ('kiosk-campus-01') if empty
  const defaultMachine = db.prepare('SELECT id FROM machines WHERE id = ?').get('kiosk-campus-01');
  if (!defaultMachine) {
    db.prepare(`
      INSERT INTO machines (
        id, name, location_description, api_secret, status,
        paper_capacity, paper_remaining, low_paper_threshold, door_closed, last_heartbeat_at
      ) VALUES (
        'kiosk-campus-01',
        'ECE Dept Main Kiosk',
        'Ground Floor Lab Corridor, ECE Block',
        'kiosk_device_secret_2026',
        'ONLINE',
        500,
        500,
        25,
        1,
        datetime('now')
      )
    `).run();
    console.log('[DB] Seeded initial Machine #1 ("kiosk-campus-01")');
  }
}

initSchema();

module.exports = db;
