'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
const assetId = '10000000-0000-4000-8000-000000000001';
const taskId = '10000000-0000-4000-8000-000000000002';

test('named save IPC permits only an optional opaque task ID and preserves main-frame protection', async () => {
  const handlers = new Map();
  const ipc = registerDesktopIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    dialog: {}, getWindow: () => ({}), policy: { isTrustedSender: event => event.trusted === true }, runtimeInfo: () => ({})
  });
  const call = (channel, ...args) => handlers.get(channel)({trusted: true}, ...args);
  try {
    for (const value of ['../private', 'C:\\private.mp4', {workName:'标题'}, undefined, null, 1]) {
      assert.equal((await call('nova:save-asset-copy', assetId, value)).code, 'INVALID_TASK_ID');
    }
    assert.equal((await call('nova:save-asset-copy', assetId, taskId, 'arbitrary-name.mp4')).code, 'INVALID_ASSET_ID');
    assert.equal((await call('nova:reveal-asset', assetId, taskId)).code, 'INVALID_ASSET_ID');
    assert.equal((await call('nova:save-asset-copy', assetId)).code, 'ASSET_SERVICE_NOT_READY');
    assert.equal((await call('nova:save-asset-copy', assetId, taskId)).code, 'ASSET_SERVICE_NOT_READY');
    assert.equal((await handlers.get('nova:save-asset-copy')({trusted:false},assetId,taskId)).code,'IPC_FORBIDDEN');
  } finally { ipc.dispose(); }
  assert.equal(handlers.size, 0);
});

test('preload retains the original one-argument IPC for callers without task context', () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../desktop/preload.cjs'),'utf8'), {
    process: {versions: {}, argv: []},
    require(name) {
      assert.equal(name,'electron');
      return {
        contextBridge: {exposeInMainWorld: (name, value) => {assert.equal(name,'novaDesktop');api=value;}},
        ipcRenderer: {invoke: (...args) => {calls.push(args);return Promise.resolve({ok:true,cancelled:true});}}
      };
    }
  });
  api.saveAssetCopy(assetId);
  api.saveAssetCopy(assetId,taskId);
  api.revealAsset(assetId);
  assert.deepEqual(calls,[['nova:save-asset-copy',assetId],['nova:save-asset-copy',assetId,taskId],['nova:reveal-asset',assetId]]);
});

test('save dialog derives names only from a verified task-output relation', async () => {
  const handlers = new Map(), dialogs=[];
  const store = {
    readAsset: () => ({bytes:Buffer.from('synthetic'),asset:{kind:'video'}}),
    resolveAssetPath: () => path.resolve('synthetic-old.mp4'),
    getTask: id => id === taskId ? {localTaskId:taskId,createdAt:'2026-11-05T00:00:00Z',workName:'镜头 / 第一幕',prompt:'独立提示词',outputAssets:[{assetId}]} : null,
  };
  const ipc=registerDesktopIpc({ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler),removeHandler:channel=>handlers.delete(channel)},
    dialog:{showSaveDialog:async(_window,options)=>{dialogs.push(options);return{canceled:true};}},
    getWindow:()=>({}),getAssetService:()=>store,policy:{isTrustedSender:event=>event.trusted===true},runtimeInfo:()=>({})});
  try {
    const call=(...args)=>handlers.get('nova:save-asset-copy')({trusted:true},...args);
    assert.deepEqual(await call(assetId,taskId),{ok:true,cancelled:true});
    assert.match(dialogs[0].defaultPath,/^镜头 第一幕_\d{8}-\d{6}_[a-f0-9]{12}\.mp4$/u);
    assert.ok(dialogs[0].properties.includes('showOverwriteConfirmation'));
    assert.equal((await call(assetId,'10000000-0000-4000-8000-000000000099')).code,'ASSET_TASK_MISMATCH');
    assert.equal(dialogs.length,1);
    assert.equal((await call(assetId)).cancelled,true);
    assert.equal(dialogs.length,2);
  } finally {ipc.dispose();}
});

test('named legacy paths require explicit registration and reject redirected parent directories', t => {
  const {safeFile}=require('../storage/groups');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-name-path-review-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
  const root=path.join(directory,'assets');fs.mkdirSync(path.join(root,'aa'),{recursive:true});
  const canonicalRoot=fs.realpathSync.native(root),leaf='镜头03_20261105-080000_a1b2c3d4e5f6.png',file=path.join(root,'aa',leaf);
  fs.writeFileSync(file,'synthetic');
  assert.throws(()=>safeFile(canonicalRoot,'aa/'+leaf),{code:'ASSET_PATH_REJECTED'});
  assert.equal(safeFile(canonicalRoot,'aa/'+leaf,false,true),fs.realpathSync.native(file));
  for(const key of ['../'+leaf,'aa/../'+leaf,'aa/C:unsafe.png','other/'+leaf,'aa/a.png.']) assert.throws(()=>safeFile(canonicalRoot,key,false,true),{code:'ASSET_PATH_REJECTED'});
  fs.renameSync(path.join(root,'aa'),path.join(directory,'original-aa'));
  fs.symlinkSync(path.join(directory,'original-aa'),path.join(root,'aa'),'junction');
  assert.throws(()=>safeFile(canonicalRoot,'aa/'+leaf,false,true),{code:'ASSET_PATH_REJECTED'});
});
