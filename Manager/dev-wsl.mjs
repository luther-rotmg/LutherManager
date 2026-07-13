/**
 * WSL dev script — runs the proxy + dashboard in WSL,
 * then auto-opens the dashboard in the Windows default browser.
 *
 * Usage:  node dev-wsl.mjs
 */
import { spawn, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_URL = 'http://localhost:4440';
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 15000;

// Start the proxy + dev server via tsx (no shell to avoid deprecation warning)
const proxy = spawn(
  process.execPath,
  [resolve(__dirname, 'node_modules', '.bin', 'tsx'), resolve(__dirname, 'src', 'index.ts'), '--dev'],
  { cwd: __dirname, stdio: 'inherit' },
);

// Poll until the dashboard is up, then open in Windows browser
let opened = false;
const start = Date.now();

const poll = setInterval(async () => {
  if (opened || Date.now() - start > TIMEOUT_MS) {
    clearInterval(poll);
    if (!opened) {
      console.log('[WSL Dev] Dashboard did not start within timeout — open manually: ' + DASHBOARD_URL);
    }
    return;
  }

  try {
    const res = await fetch(DASHBOARD_URL);
    if (res.ok) {
      opened = true;
      clearInterval(poll);

      // Open in Windows default browser via WSL interop
      exec('cmd.exe /c start ' + DASHBOARD_URL, (err) => {
        if (err) {
          // Fallback: try explorer.exe
          exec('explorer.exe ' + DASHBOARD_URL);
        }
      });
      console.log('[WSL Dev] Dashboard opened in Windows browser');
    }
  } catch {
    // Not ready yet
  }
}, POLL_INTERVAL_MS);

// Clean shutdown
const cleanup = () => {
  clearInterval(poll);
  proxy.kill();
  process.exit(0);
};

proxy.on('exit', (code) => {
  clearInterval(poll);
  process.exit(code ?? 0);
});

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
