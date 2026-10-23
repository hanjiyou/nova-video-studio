'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function registerDesktopIpc({ ipcMain, dialog, getWindow, policy, runtimeInfo, getAssetService = () => null }) {
  const selections = new Map();
  const channels = [];
  function register(channel, handler) {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!policy.isTrustedSender(event)) return { ok: false, code: 'IPC_FORBIDDEN' };
      try { return await handler(...args); } catch { return { ok: false, code: 'DESKTOP_OPERATION_FAILED' }; }
    });
  }
  register('nova:runtime-info', (...args) => args.length ? { ok: false, code: 'INVALID_ARGUMENT' } : { ok: true, ...runtimeInfo() });
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
    return { ok: true, cancelled: false, selectionId, displayName: path.basename(directory) };
  });
  register('nova:import-reference-assets', async (...args)=>{
    if(args.length)return {ok:false,code:'INVALID_ARGUMENT'};
    const service=getAssetService();if(!service)return {ok:false,code:'ASSET_SERVICE_NOT_READY'};
    const result=await dialog.showOpenDialog(getWindow(),{properties:['openFile','multiSelections'],filters:[{name:'参考图片',extensions:['png','jpg','jpeg']}]});
    if(result.canceled)return {ok:true,cancelled:true,assets:[]};
    if(result.filePaths.length>32)return {ok:false,code:'TOO_MANY_ASSETS'};
    const assets=service.importFiles(result.filePaths);
    return {ok:true,cancelled:false,assets};
  });
  for (const channel of ['nova:save-asset-copy', 'nova:reveal-asset']) register(channel, (...args) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID.test(args[0])) return { ok: false, code: 'INVALID_ASSET_ID' };
    // T03/T08 provide asset resolution; never interpret a renderer string as a path.
    return { ok: false, code: 'ASSET_SERVICE_NOT_READY' };
  });
  return {
    resolveDirectorySelection: id => selections.get(id) || null, // Host-only T03 integration point.
    dispose() { for (const channel of channels) ipcMain.removeHandler(channel); selections.clear(); },
  };
}
module.exports = { registerDesktopIpc };
