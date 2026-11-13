// Preload script - puente seguro entre renderer y main process
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getDataPath: () => ipcRenderer.invoke('app:get-data-path'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  restartServer: () => ipcRenderer.invoke('app:restart-server'),
  saveFile: (payload) => ipcRenderer.invoke('file:save-binary', payload),
});