'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaDesktop', {
  versions: process.versions,
  features: Object.freeze({ agent: process.argv.includes('--nova-agent-enabled=true'), browserAutomation: process.argv.includes('--nova-cdp-enabled=true'), serviceWorker: false }),
  saveConnection: input => ipcRenderer.invoke('nova:save-connection', input),
  clearConnectionCredential: input => ipcRenderer.invoke('nova:clear-connection-credential', input),
  selectConnection: input => ipcRenderer.invoke('nova:select-connection', input),
  importReferenceAssets: () => ipcRenderer.invoke('nova:import-reference-assets'),
  validateAndSaveConnection: input => ipcRenderer.invoke('nova:validate-and-save-connection', input),
  cancelConnectionValidation: input => ipcRenderer.invoke('nova:cancel-connection-validation', input),
  completeWorkbenchSetup: input => ipcRenderer.invoke('nova:complete-workbench-setup', input),
  checkOutputDirectory: () => ipcRenderer.invoke('nova:check-output-directory'),
  exportDiagnostics: () => ipcRenderer.invoke('nova:export-diagnostics'),
  getRuntimeInfo: () => ipcRenderer.invoke('nova:runtime-info'),
  chooseOutputDirectory: () => ipcRenderer.invoke('nova:choose-output-directory'),
  getOutputDirectory: () => ipcRenderer.invoke('nova:output-directory'),
  saveAssetCopy: assetId => ipcRenderer.invoke('nova:save-asset-copy', assetId),
  revealAsset: assetId => ipcRenderer.invoke('nova:reveal-asset', assetId),
});
