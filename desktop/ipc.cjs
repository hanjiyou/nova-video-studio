'use strict';
const { MAX_REFERENCE_ASSETS } = require('../backend/storage/application-limits');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAssetActions } = require('./asset-actions.cjs');
const { DETAILS } = require('../backend/storage/download-errors');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function registerDesktopIpc({ ipcMain, dialog, shell, getWindow, policy, runtimeInfo, getAssetService = () => null, getConnectionService = () => null }) {
  const selections = new Map();
  const channels = [];
  function register(channel, handler) {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!policy.isTrustedSender(event)) return { ok: false, code: 'IPC_FORBIDDEN' };
      try { return await handler(...args); } catch (error) { return { ok: false, code: error.connectionError || error.statusCode || DETAILS[error.code] ? error.code : 'DESKTOP_OPERATION_FAILED' }; }
    });
  }
  register('nova:runtime-info', (...args) => args.length ? { ok: false, code: 'INVALID_ARGUMENT' } : { ok: true, ...runtimeInfo() });
  for (const [channel, method] of [['nova:save-connection','save'],['nova:clear-connection-credential','clear'],['nova:select-connection','select']]) {
    register(channel, (...args) => {
      if (args.length !== 1) return {ok:false,code:'INVALID_ARGUMENT'};
      const service=getConnectionService();
      if (!service) return {ok:false,code:'CONNECTION_SERVICE_NOT_READY'};
      return {ok:true,connection:service[method](args[0])};
    });
  }
  register('nova:validate-and-save-connection', async (...args) => {
    if(args.length!==1)return {ok:false,code:'INVALID_ARGUMENT'};
    const service=getConnectionService();if(!service)return {ok:false,code:'CONNECTION_SERVICE_NOT_READY'};
    return {ok:true,...await service.validateAndSave(args[0],getAssetService())};
  });
  register('nova:cancel-connection-validation', (...args) => {
    if(args.length!==1)return {ok:false,code:'INVALID_ARGUMENT'};
    const service=getConnectionService();if(!service)return {ok:false,code:'CONNECTION_SERVICE_NOT_READY'};
    return {ok:true,...service.cancelCandidate(args[0])};
  });
  register('nova:complete-workbench-setup', (...args) => {
    if(args.length!==1)return {ok:false,code:'INVALID_ARGUMENT'};
    const service=getConnectionService();if(!service)return {ok:false,code:'CONNECTION_SERVICE_NOT_READY'};
    return {ok:true,...service.completeSetup(args[0],getAssetService())};
  });
  register('nova:check-output-directory', (...args) => args.length ? {ok:false,code:'INVALID_ARGUMENT'} : {ok:true,...getAssetService()?.checkOutputDirectory()});
  register('nova:choose-output-directory', async (...args) => {
    if (args.length) return { ok: false, code: 'INVALID_ARGUMENT' };
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { ok: true, cancelled: true };
    const directory = await fs.realpath(result.filePaths[0]);
    const probe = path.join(directory, '.nova-write-probe-' + randomUUID());
    let handle;
    try { handle = await fs.open(probe, 'wx'); await handle.writeFile('probe'); }
    finally { await handle?.close(); await fs.unlink(probe).catch(() => {}); }
    const selectionId = randomUUID();
    if (selections.size >= 16) selections.delete(selections.keys().next().value);
    selections.set(selectionId, directory);
    const service=getAssetService();
    return { ok: true, cancelled: false, selectionId, displayName: path.basename(directory), ...(service?service.selectOutputDirectory(directory):{}) };
  });
  register('nova:output-directory',(...args)=>args.length?{ok:false,code:'INVALID_ARGUMENT'}:{ok:true,...getAssetService()?.outputDirectory()});
  register('nova:import-reference-assets', async (...args)=>{
    if(args.length)return {ok:false,code:'INVALID_ARGUMENT'};
    const service=getAssetService();if(!service)return {ok:false,code:'ASSET_SERVICE_NOT_READY'};
    const result=await dialog.showOpenDialog(getWindow(),{properties:['openFile','multiSelections'],filters:[{name:'参考图片',extensions:['png','jpg','jpeg']}]});
    if(result.canceled)return {ok:true,cancelled:true,assets:[]};
    if(result.filePaths.length>MAX_REFERENCE_ASSETS)return {ok:false,code:'TOO_MANY_ASSETS'};
    const assets=service.importFiles(result.filePaths);
    return {ok:true,cancelled:false,assets};
  });
  const diagnosticActions=require('./diagnostic-actions.cjs').createDiagnosticActions({getStore:getAssetService,dialog,getWindow,runtimeInfo});
  register('nova:export-diagnostics', (...args) => args.length ? {ok:false,code:'INVALID_ARGUMENT'} : diagnosticActions.export());
  const assetActions=createAssetActions({getStore:getAssetService,dialog,shell,getWindow});
  for (const channel of ['nova:save-asset-copy', 'nova:reveal-asset']) register(channel, (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID.test(args[0])) return { ok: false, code: 'INVALID_ASSET_ID' };
    if(!getAssetService())return {ok:false,code:'ASSET_SERVICE_NOT_READY'};
    return channel==='nova:save-asset-copy'?assetActions.save(args[0]):assetActions.reveal(args[0]);
  });
  return {
    resolveDirectorySelection: id => selections.get(id) || null, // Host-only T03 integration point.
    dispose() { for (const channel of channels) ipcMain.removeHandler(channel); selections.clear(); },
  };
}
module.exports = { registerDesktopIpc };
