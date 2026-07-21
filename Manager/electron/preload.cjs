const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('window:maximized', () => callback(true));
    ipcRenderer.on('window:unmaximized', () => callback(false));
  },
  rotmg: {
    /**
     * Read whatever credentials the official RotMG Exalt Launcher has persisted
     * in Unity PlayerPrefs (registry). Resolves to
     *   { guid, secret, token, tokenTimestamp, tokenExpiration, preferredServer }
     * or { error } if nothing is there.
     * Used by the dashboard "Import Launcher Credentials" flow to populate
     * headless account entries — not for launching the real Exalt client.
     */
    readLauncherCreds: () => ipcRenderer.invoke('rotmg:readLauncherCreds'),
  },
  updater: {
    /**
     * Subscribe to auto-updater lifecycle events. Callback receives
     *   { state, info? } where state is one of:
     *     'disabled'    - no update token found / dev build / not wired
     *     'checking'    - hitting luther-rotmg.com to check for a new version
     *     'idle'        - already on the latest release
     *     'available'   - update-available; info: { version, currentVersion }
     *     'downloading' - download-progress; info: { percent, transferred, total }
     *     'downloaded'  - downloaded and staged; info: { version } — restart to install
     *     'error'       - error occurred; info: { message }
     * Returns an unsubscribe function.
     */
    onStatusChange: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
    /** Query current status once — resolves to the same shape as the subscription payload. */
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    /** Force a check-for-updates now (bypass the 4h interval). Resolves when the check finishes. */
    checkNow: () => ipcRenderer.invoke('updater:checkNow'),
    /** Start downloading an already-detected available update. No-op if state !== 'available'. */
    downloadNow: () => ipcRenderer.invoke('updater:downloadNow'),
    /** Quit and install a downloaded update immediately. */
    installNow: () => ipcRenderer.send('updater:installNow'),
  },
});
