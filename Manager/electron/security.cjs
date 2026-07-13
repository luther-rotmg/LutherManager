'use strict';

/**
 * Electron main-process security hardening.
 *
 * Checks:
 *   1. Anti-debugger  – detect --inspect* flags and active V8 inspector
 *   2. Window harden  – disable DevTools, context menu in production
 *   3. Bundle verify  – hash dist/app.cjs against integrity manifest
 *
 * All checks gate on isProd to avoid disrupting dev workflows.
 */

const { app } = require('electron');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// ─── 1. Anti-debugger ────────────────────────────────────────────────────────

const INSPECTOR_FLAGS = [
  '--inspect', '--inspect-brk', '--inspect-port',
  '--debug',   '--debug-brk',   '--debug-port',
];

/**
 * Detect debugger flags on the Electron process.
 * Only checks static flags and active inspector — no timing probes,
 * no process scanning, no false positives.
 */
function detectDebugger() {
  const reasons = [];

  // execArgv flags
  const badFlag = process.execArgv.find(a =>
    INSPECTOR_FLAGS.some(f => a.toLowerCase().startsWith(f))
  );
  if (badFlag) reasons.push(`inspector flag: ${badFlag}`);

  // NODE_OPTIONS injection
  const nodeOpts = process.env.NODE_OPTIONS || '';
  const badOpt = INSPECTOR_FLAGS.find(f => nodeOpts.toLowerCase().includes(f));
  if (badOpt) reasons.push(`NODE_OPTIONS contains: ${badOpt}`);

  // V8 inspector actively connected
  try {
    const inspector = require('inspector');
    const url = inspector.url();
    if (url) reasons.push(`V8 inspector active: ${url}`);
  } catch { /* not available */ }

  return reasons;
}

/** Block late debugger attachment via SIGUSR1. */
function blockInspectorSignal() {
  try {
    process.on('SIGUSR1', () => {});
  } catch { /* Windows — harmless */ }
}

// ─── 2. Window hardening ─────────────────────────────────────────────────────

function hardenWindow(win, isProd) {
  if (!isProd) return;

  const wc = win.webContents;

  wc.on('before-input-event', (event, input) => {
    const isDevToolsKey =
      input.key === 'F12' ||
      (input.control && input.shift && input.key === 'I') ||
      (input.meta    && input.alt   && input.key === 'i');
    if (isDevToolsKey) event.preventDefault();
  });

  wc.on('devtools-opened', () => wc.closeDevTools());
  wc.on('context-menu', (event) => event.preventDefault());
}

// ─── 3. Bundle integrity ─────────────────────────────────────────────────────

function loadManifest(root) {
  const manifestPath = path.join(root, 'dist', 'integrity.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Verify files against integrity manifest. Returns array of failure reasons.
 * Returns empty array if manifest doesn't exist (dev mode / ASAR).
 */
function verifyBundleIntegrity(root) {
  const manifest = loadManifest(root);
  if (!manifest || manifest.length === 0) return [];

  const failures = [];
  for (const entry of manifest) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') continue;

    const fullPath = path.resolve(root, entry.path.replace(/\//g, path.sep));
    if (!fs.existsSync(fullPath)) {
      failures.push(`missing: ${entry.path}`);
      continue;
    }

    try {
      const data = fs.readFileSync(fullPath);
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      if (actual.toLowerCase() !== entry.sha256.toLowerCase()) {
        failures.push(`tampered: ${entry.path}`);
      }
    } catch {
      failures.push(`unreadable: ${entry.path}`);
    }
  }
  return failures;
}

/**
 * Scan electron/ for unexpected files.
 * Returns array of unexpected filenames, or empty if dir doesn't exist.
 */
function scanElectronDir(root, allowedFiles) {
  const electronDir = path.join(root, 'electron');
  if (!fs.existsSync(electronDir)) return [];

  const allowed = new Set(allowedFiles);
  const unexpected = [];

  try {
    for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
      if (entry.isFile() && !allowed.has(entry.name)) {
        unexpected.push(entry.name);
      }
    }
  } catch { /* unreadable */ }

  return unexpected;
}

// ─── 4. Entry point ──────────────────────────────────────────────────────────

/**
 * Run main-process security checks. Called at top of main.cjs.
 *
 * Returns an object with check results instead of calling process.exit()
 * directly — lets the caller decide what to do (show error, quit, etc.)
 */
function runEarlyChecks(isProd, root) {
  blockInspectorSignal();

  const result = { ok: true, reasons: [] };

  if (!isProd) return result;

  // Debugger detection (static flags + active inspector only — no false positives)
  const debugReasons = detectDebugger();
  if (debugReasons.length > 0) {
    result.ok = false;
    result.reasons.push(...debugReasons.map(r => `[debugger] ${r}`));
  }

  // Bundle integrity (gracefully skips if manifest is inside ASAR)
  const integrityFailures = verifyBundleIntegrity(root);
  if (integrityFailures.length > 0) {
    result.ok = false;
    result.reasons.push(...integrityFailures.map(r => `[integrity] ${r}`));
  }

  // Electron dir scan (gracefully skips if dir is inside ASAR)
  const unexpected = scanElectronDir(root, ['main.cjs', 'preload.cjs', 'security.cjs', 'loading.html']);
  if (unexpected.length > 0) {
    result.ok = false;
    result.reasons.push(`[injected] unexpected files: ${unexpected.join(', ')}`);
  }

  return result;
}

module.exports = {
  runEarlyChecks,
  hardenWindow,
};
