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
  if (!isPackaged) {
    console.log('[updater] dev build: auto-updates disabled.');
    return null;
  }

  const cred = loadUpdateToken();
  if (!cred) {
    console.log('[updater] no update-token found; auto-updates disabled.');
    console.log('[updater] mint one at https://luther-rotmg.com/payment after checkout,');
    console.log('[updater] then save the token to %USERPROFILE%\\Documents\\LutherManager\\update-token');
    return null;
  }
  console.log('[updater] loaded update token from', cred.path);

  let NsisUpdater;
  try {
    ({ NsisUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('[updater] electron-updater not available:', err && (err.message || err));
    return null;
  }

  const updater = new NsisUpdater({
    requestHeaders: { 'User-Agent': 'LutherManager' },
  });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.addAuthHeader('Bearer ' + cred.token);

  updater.on('error', (err) => console.error('[updater] error:', err && (err.message || err)));
  updater.on('checking-for-update', () => console.log('[updater] checking...'));
  updater.on('update-not-available', () => console.log('[updater] already on latest.'));
  updater.on('download-progress', (p) => console.log('[updater] download', Math.round(p.percent) + '%'));
  updater.on('update-downloaded', (info) => console.log('[updater] downloaded ' + (info && info.version) + '; will install on quit.'));

  return {
    scheduleBackgroundUpdateChecks({ app: appInstance, dialog, getWindow }) {
      updater.on('update-available', (info) => {
        console.log('[updater] update available:', info && info.version);
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
  };
}

module.exports = { createUpdater };
