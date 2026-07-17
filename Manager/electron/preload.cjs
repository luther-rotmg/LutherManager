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
});
