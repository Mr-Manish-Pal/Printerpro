const db = require('../config/db');

const HEARTBEAT_TIMEOUT_SECONDS = 90;
const MINIMUM_PAPER_THRESHOLD = 5;

/**
 * Validates whether a specific machine is ready to accept and print new orders.
 * Gating logic strictly enforces:
 * 1. Machine registration in database
 * 2. Fresh heartbeat within the last 90 seconds
 * 3. Closed cabinet door (no tamper alarm)
 * 4. Healthy operational status (not TAMPER_LOCK or MAINTENANCE)
 * 5. Sufficient paper remaining
 * 
 * @param {string} machineId
 * @returns {{ ok: boolean, reason?: string, message: string, machine?: object }}
 */
function validateMachineAvailability(machineId) {
  const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId);

  if (!machine) {
    return {
      ok: false,
      reason: 'MACHINE_NOT_FOUND',
      message: `Machine "${machineId}" is not registered in the system.`
    };
  }

  // Check 1: Heartbeat freshness
  if (!machine.last_heartbeat_at) {
    return {
      ok: false,
      reason: 'NEVER_CONNECTED',
      message: 'Machine has never established a connection with the server.'
    };
  }

  // Parse SQLite UTC timestamp format ("YYYY-MM-DD HH:MM:SS" or ISO)
  const lastHeartbeatTime = new Date(machine.last_heartbeat_at.replace(' ', 'T') + 'Z').getTime();
  const secondsSinceHeartbeat = Math.floor((Date.now() - lastHeartbeatTime) / 1000);

  if (secondsSinceHeartbeat > HEARTBEAT_TIMEOUT_SECONDS) {
    return {
      ok: false,
      reason: 'MACHINE_OFFLINE',
      message: `Machine is offline (No heartbeat for ${secondsSinceHeartbeat}s). You will not be charged.`,
      machine
    };
  }

  // Check 2: Physical Cabinet Tamper State
  if (machine.door_closed === 0 || machine.status === 'TAMPER_LOCK') {
    return {
      ok: false,
      reason: 'TAMPER_LOCK',
      message: 'Machine is locked for safety (Cabinet door opened). You will not be charged.',
      machine
    };
  }

  // Check 3: Routine Maintenance State
  if (machine.status === 'MAINTENANCE') {
    return {
      ok: false,
      reason: 'MAINTENANCE',
      message: 'Machine is temporarily paused for routine maintenance. You will not be charged.',
      machine
    };
  }

  // Check 4: Paper Level
  if (machine.paper_remaining < MINIMUM_PAPER_THRESHOLD) {
    return {
      ok: false,
      reason: 'OUT_OF_PAPER',
      message: `Machine is out of paper (${machine.paper_remaining} sheets remaining). You will not be charged.`,
      machine
    };
  }

  return {
    ok: true,
    message: 'Machine is online and ready.',
    machine
  };
}

/**
 * Public endpoint for Kiosk Mobile UI pre-flight check.
 * GET /api/machine/:machineId/status
 */
function getMachinePublicStatus(req, res, next) {
  try {
    const { machineId } = req.params;
    const validation = validateMachineAvailability(machineId);

    if (!validation.ok) {
      return res.status(200).json({
        success: true,
        available: false,
        machineId,
        reason: validation.reason,
        message: validation.message,
        name: validation.machine ? validation.machine.name : 'Unknown Kiosk',
        location: validation.machine ? validation.machine.location_description : ''
      });
    }

    const { machine } = validation;
    return res.status(200).json({
      success: true,
      available: true,
      machineId: machine.id,
      name: machine.name,
      location: machine.location_description,
      status: machine.status,
      paperRemaining: machine.paper_remaining,
      lowPaperWarning: machine.paper_remaining <= machine.low_paper_threshold,
      message: 'Kiosk is ready to print.'
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Protected Agent Heartbeat Endpoint.
 * POST /api/agent/heartbeat
 * Headers verified by verifyDeviceHmac.
 */
function recordHeartbeat(req, res, next) {
  try {
    const machine = req.machine; // Attached by verifyDeviceHmac
    const {
      printerState = 'idle',
      printerReasons = 'none',
      cpuTemp = null,
      throttlingFlags = null,
      wifiSignalDbm = null,
      diskFreeMb = null,
      doorClosed = 1,
      paperRemaining = null,
      agentVersion = '1.0.0'
    } = req.body || {};

    const effectiveDoorClosed = doorClosed === 0 ? 0 : 1;

    // Determine operational status
    let newStatus = 'ONLINE';
    if (effectiveDoorClosed === 0) {
      newStatus = 'TAMPER_LOCK';
    } else if (printerState === 'stopped') {
      newStatus = 'MAINTENANCE';
    } else if (printerState === 'printing') {
      newStatus = 'BUSY';
    }

    const effectivePaper = paperRemaining !== null ? parseInt(paperRemaining, 10) : machine.paper_remaining;

    // Update machine status in DB
    db.prepare(`
      UPDATE machines SET
        status = ?,
        door_closed = ?,
        paper_remaining = ?,
        last_heartbeat_at = datetime('now'),
        ip_address = ?,
        agent_version = ?
      WHERE id = ?
    `).run(
      newStatus,
      effectiveDoorClosed,
      effectivePaper,
      req.ip || '127.0.0.1',
      agentVersion,
      machine.id
    );

    // Record history telemetry
    db.prepare(`
      INSERT INTO machine_heartbeats (
        machine_id, printer_state, printer_reasons, cpu_temp,
        throttling_flags, wifi_signal_dbm, disk_free_mb, door_closed, paper_remaining
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      machine.id,
      printerState,
      printerReasons,
      cpuTemp,
      throttlingFlags,
      wifiSignalDbm,
      diskFreeMb,
      effectiveDoorClosed,
      effectivePaper
    );

    // Count pending queued jobs for this machine
    const pendingCount = db.prepare(`
      SELECT COUNT(*) as count FROM orders
      WHERE machine_id = ? AND status = 'QUEUED'
    `).get(machine.id).count;

    return res.status(200).json({
      success: true,
      acknowledged: true,
      serverTime: new Date().toISOString(),
      machineStatus: newStatus,
      pendingJobs: pendingCount
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin action to refill paper counter.
 * POST /api/admin/machines/:machineId/refill
 */
function refillPaper(req, res, next) {
  try {
    const { machineId } = req.params;
    const { sheets = 500 } = req.body || {};

    const machine = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId);
    if (!machine) {
      return res.status(404).json({ success: false, error: 'Machine not found.' });
    }

    db.prepare(`
      UPDATE machines SET
        paper_remaining = ?,
        status = CASE WHEN status = 'OUT_OF_SERVICE' THEN 'ONLINE' ELSE status END
      WHERE id = ?
    `).run(sheets, machineId);

    return res.status(200).json({
      success: true,
      message: `Machine "${machineId}" paper counter refilled to ${sheets} sheets.`
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  validateMachineAvailability,
  getMachinePublicStatus,
  recordHeartbeat,
  refillPaper
};

