'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaDesktop', {
  versions: process.versions,
  features: Object.freeze({ agent: process.argv.includes('--nova-agent-enabled=true'), browserAutomation: process.argv.includes('--nova-cdp-enabled=true'), serviceWorker: false }),
  saveConnection: input => ipcRenderer.invoke('nova:save-connection', input),
  clearConnectionCredential: input => ipcRenderer.invoke('nova:clear-connection-credential', input),
  selectConnection: input => ipcRenderer.invoke('nova:select-connection', input),
  importReferenceAssets: () => ipcRenderer.invoke('nova:import-reference-assets'),
  getRuntimeInfo: () => ipcRenderer.invoke('nova:runtime-info'),
  chooseOutputDirectory: () => ipcRenderer.invoke('nova:choose-output-directory'),
  saveAssetCopy: assetId => ipcRenderer.invoke('nova:save-asset-copy', assetId),
  revealAsset: assetId => ipcRenderer.invoke('nova:reveal-asset', assetId),
});
