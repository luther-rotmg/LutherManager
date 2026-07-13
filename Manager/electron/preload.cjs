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
     */
    readLauncherCreds: () => ipcRenderer.invoke('rotmg:readLauncherCreds'),
  },
  instanceHost: {
    isSupported: () => ipcRenderer.invoke('instanceHost:isSupported'),
    listInstances: () => ipcRenderer.invoke('instanceHost:listInstances'),
    listWindows: () => ipcRenderer.invoke('instanceHost:listWindows'),
    listAttachments: () => ipcRenderer.invoke('instanceHost:listAttachments'),
    launch: (payload) => ipcRenderer.invoke('instanceHost:launch', payload),
    trackByPid: (payload) => ipcRenderer.invoke('instanceHost:trackByPid', payload),
    stop: (payload) => ipcRenderer.invoke('instanceHost:stop', payload),
    discoverWindow: (payload) => ipcRenderer.invoke('instanceHost:discoverWindow', payload),
    focus: (payload) => ipcRenderer.invoke('instanceHost:focus', payload),
    attach: (payload) => ipcRenderer.invoke('instanceHost:attach', payload),
    detach: (payload) => ipcRenderer.invoke('instanceHost:detach', payload),
    resizeSlot: (payload) => ipcRenderer.invoke('instanceHost:resizeSlot', payload),
    onUpdate: (callback) => {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on('instanceHost:update', handler);
      return () => ipcRenderer.removeListener('instanceHost:update', handler);
    },
  },
});
