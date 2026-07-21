// LutherManager auto-update wiring.
//
// Consumes electron-updater's NsisUpdater (Windows-only) and hits the release
// channel at luther-rotmg.com/api/releases/win/* with a per-install Bearer
// token stored in the user's Documents dir.
//
// Token file location (config-dir fallback pattern, pending P1 Phase 5 spec):
//   Prefer:   %USERPROFILE%\Documents\LutherManager\update-token
//   Fallback: %USERPROFILE%\Documents\Hive\update-token   (existing-install compat)
//
// Absent token => auto-updates disabled with an actionable log message.
// Dev (unpackaged) => module returns null; app-update.yml only exists in
// packaged builds so calling checkForUpdates in dev throws.

const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const TOKEN_FILENAME = 'update-token';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function loadUpdateToken() {
  const documents = join(process.env.USERPROFILE || homedir(), 'Documents');
  const candidates = [
    join(documents, 'LutherManager', TOKEN_FILENAME),
    join(documents, 'Hive', TOKEN_FILENAME),
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const value = readFileSync(path, 'utf8').trim();
        if (value) return { token: value, path };
      }
    } catch (err) {
      console.warn('[updater] could not read', path, err && (err.message || err));
    }
  }
  return null;
}

function createUpdater({ isPackaged }) {
  // The API is uniform whether or not the updater is actually wired: the returned object
  // always exposes {scheduleBackgroundUpdateChecks, getStatus, checkNow, downloadNow, installNow}.
  // Disabled paths short-circuit to a static status; renderer / IPC don't need to special-case.
  const disabled = (reason) => {
    console.log('[updater]', reason);
    const status = { state: 'disabled', info: { reason } };
    return {
      scheduleBackgroundUpdateChecks() {},
      getStatus() { return status; },
      checkNow() { return Promise.resolve(status); },
      downloadNow() { return Promise.resolve(status); },
      installNow() {},
      onStatusChange() { return () => {}; },
    };
  };

  if (!isPackaged) {
    return disabled('dev build: auto-updates disabled.');
  }

  const cred = loadUpdateToken();
  if (!cred) {
    console.log('[updater] no update-token found; auto-updates disabled.');
    console.log('[updater] mint one at https://luther-rotmg.com/payment after checkout,');
    console.log('[updater] then save the token to %USERPROFILE%\\Documents\\LutherManager\\update-token');
    return disabled('no update-token found.');
  }
  console.log('[updater] loaded update token from', cred.path);

  let NsisUpdater;
  try {
    ({ NsisUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater not available:', err && (err.message || err));
    return disabled('electron-updater dep missing.');
  }

  const updater = new NsisUpdater({
    requestHeaders: { 'User-Agent': 'LutherManager' },
  });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.addAuthHeader('Bearer ' + cred.token);

  // Latest status snapshot + subscriber list. Renderer subscribes via IPC (main.cjs wires
  // it up); other callers (e.g. system tray) can also subscribe directly if we add them.
  let status = { state: 'checking' };
  const subscribers = new Set();
  const setStatus = (next) => {
    status = next;
    for (const cb of subscribers) {
      try { cb(status); } catch (err) { console.error('[updater] subscriber failed:', err && (err.message || err)); }
    }
  };

  updater.on('error', (err) => {
    console.error('[updater] error:', err && (err.message || err));
    setStatus({ state: 'error', info: { message: err && (err.message || String(err)) } });
  });
  updater.on('checking-for-update', () => {
    console.log('[updater] checking...');
    setStatus({ state: 'checking' });
  });
  updater.on('update-not-available', () => {
    console.log('[updater] already on latest.');
    setStatus({ state: 'idle' });
  });
  updater.on('update-available', (info) => {
    console.log('[updater] update available:', info && info.version);
    setStatus({ state: 'available', info: { version: info && info.version } });
  });
  updater.on('download-progress', (p) => {
    console.log('[updater] download', Math.round(p.percent) + '%');
    setStatus({ state: 'downloading', info: { percent: p.percent, transferred: p.transferred, total: p.total } });
  });
  updater.on('update-downloaded', (info) => {
    console.log('[updater] downloaded ' + (info && info.version) + '; will install on quit.');
    setStatus({ state: 'downloaded', info: { version: info && info.version } });
  });

  return {
    scheduleBackgroundUpdateChecks({ app: appInstance, dialog, getWindow }) {
      updater.on('update-available', (info) => {
        const win = getWindow && getWindow();
        if (!win || !dialog || !appInstance) return;
        dialog.showMessageBox(win, {
          type: 'info',
          buttons: ['Download now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'LutherManager update available',
          message: 'Version ' + info.version + ' is available (you are on ' + appInstance.getVersion() + ').',
          detail: 'The update will install the next time you quit LutherManager.',
        }).then((result) => {
          if (result.response === 0) {
            updater.downloadUpdate().catch((err) => console.error('[updater] download failed:', err && (err.message || err)));
          }
        }).catch((err) => console.error('[updater] dialog failed:', err && (err.message || err)));
      });

      updater.checkForUpdates().catch((err) => console.error('[updater] initial check failed:', err && (err.message || err)));
      setInterval(() => {
        updater.checkForUpdates().catch((err) => console.error('[updater] scheduled check failed:', err && (err.message || err)));
      }, CHECK_INTERVAL_MS);
    },
    getStatus() { return status; },
    checkNow() {
      return updater.checkForUpdates()
        .then(() => status)
        .catch((err) => {
          const failure = { state: 'error', info: { message: err && (err.message || String(err)) } };
          setStatus(failure);
          return failure;
        });
    },
    downloadNow() {
      if (status.state !== 'available') return Promise.resolve(status);
      return updater.downloadUpdate()
        .then(() => status)
        .catch((err) => {
          const failure = { state: 'error', info: { message: err && (err.message || String(err)) } };
          setStatus(failure);
          return failure;
        });
    },
    installNow() { updater.quitAndInstall(false, true); },
    onStatusChange(cb) {
      subscribers.add(cb);
      // Fire once with the current snapshot so late subscribers see state without waiting.
      try { cb(status); } catch (err) { console.error('[updater] initial-fire failed:', err && (err.message || err)); }
      return () => subscribers.delete(cb);
    },
  };
}

module.exports = { createUpdater };
