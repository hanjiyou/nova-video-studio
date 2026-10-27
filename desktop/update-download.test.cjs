'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createUpdateService, classifyDifferentialFallback } = require('./update-service.cjs');
const { createUpdateDiagnostics, project } = require('./update-diagnostics.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const startLog = 'Download block maps (old: "https://synthetic.invalid/old.blockmap?token=PRIVATE", new: https://synthetic.invalid/new.blockmap)';
const planLog = 'Full: 100 KB, To download: 10 KB (10%)';
const fallback = message => 'Cannot download differentially, fallback to full download: ' + message;
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-update-mode-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnostics = createUpdateDiagnostics({ directory, currentVersion:'3.6.8' }), updater = new EventEmitter(), sent = [];
  let pending = deferred();
  updater.checkForUpdates = async () => ({updateInfo:{version:'3.6.9'}});
  updater.downloadUpdate = () => pending.promise;
  const service = createUpdateService({policy:{supported:true,installSupported:true},currentVersion:'3.6.8',createUpdater:()=>updater,diagnostics,send:(event,state)=>sent.push({event,state}),...options});
  t.after(() => service.dispose());
  await service.check();
  const download = service.download(); await tick();
  return {service,updater,diagnostics,directory,sent,download,pending,retry(){pending=deferred();this.pending=pending;this.download=service.download();return this.download;},async complete(){updater.emit('update-downloaded',{version:'3.6.9'});pending.resolve([]);return this.download;}};
}
test('attempt and plan do not prove differential transfer; fallback resets progress without summing copy bytes', async t => {
  const f = await fixture(t);
  assert.equal(f.service.snapshot().downloadMode,'preparing');
  f.updater.logger.info(startLog); f.updater.logger.info(startLog); f.updater.logger.info(planLog);
  assert.equal(f.service.snapshot().downloadMode,'differential-attempt'); assert.equal(f.service.snapshot().progress,undefined);
  f.updater.emit('download-progress',{transferred:0,total:1000,percent:0});
  assert.equal(f.service.snapshot().downloadMode,'differential-attempt');
  const delta={transferred:12.25,total:99.5,percent:12.31,bytesPerSecond:4.5};
  f.updater.emit('download-progress',delta); f.updater.emit('download-progress',delta);
  assert.equal(f.service.snapshot().downloadMode,'differential'); assert.deepEqual(f.service.snapshot().progress,delta);
  f.updater.logger.error(fallback('Error: Request timed out'));
  assert.equal(f.service.snapshot().downloadMode,'full-fallback'); assert.equal(f.service.snapshot().fallbackReason,'transfer_failed'); assert.equal(f.service.snapshot().progress,undefined);
  f.updater.logger.error(fallback('Error: PRIVATE')); f.updater.logger.info(startLog);
  assert.equal(f.service.snapshot().fallbackReason,'transfer_failed');
  const full={transferred:200,total:10000,percent:2,bytesPerSecond:100};
  f.updater.emit('download-progress',full); assert.deepEqual(f.service.snapshot().progress,full);
  assert.equal(f.service.snapshot().downloadMode,'full-fallback'); assert.equal((await f.complete()).ok,true);
  f.updater.emit('download-progress',delta); f.updater.emit('update-downloaded',{version:'3.6.9'}); f.updater.logger.error(fallback('Error: PRIVATE'));
  assert.equal(f.service.snapshot().phase,'downloaded'); assert.equal(f.service.snapshot().progress,undefined);
  const events=f.diagnostics.snapshot().events;
  for (const event of ['differential_started','differential_downloading','differential_fallback','downloaded']) assert.equal(events.filter(x=>x.event===event).length,1,event);
  assert.equal(events.filter(x=>x.event==='download_progress'&&x.downloadMode==='full-fallback').length,1);
  assert.ok(!JSON.stringify({events,sent:f.sent}).includes('PRIVATE'));
});
test('failed attempt ignores late callbacks and retry clears all mode, reason, checksum and progress evidence', async t => {
  const f=await fixture(t);
  f.updater.logger.info(startLog); f.updater.logger.warn('sha512 checksum mismatch after differential download (old blockmap was read from the local cache): PRIVATE');
  f.updater.logger.error(fallback('Error: PRIVATE')); assert.equal(f.service.snapshot().fallbackReason,'checksum_failed');
  f.updater.emit('error',Error('PRIVATE https://private.invalid/?token=PRIVATE C:\\private'));
  f.updater.logger.info(startLog); f.updater.emit('download-progress',{percent:99,transferred:99,total:100}); f.updater.emit('update-downloaded',{version:'3.6.9'});
  f.pending.reject(Error('PRIVATE')); assert.equal((await f.download).ok,false); assert.equal(f.service.snapshot().phase,'error');
  f.retry(); assert.equal(f.service.snapshot().downloadMode,'preparing'); assert.equal(f.service.snapshot().fallbackReason,undefined); assert.equal(f.service.snapshot().baselineReason,undefined); assert.equal(f.service.snapshot().progress,undefined); await tick();
  f.updater.logger.info(startLog); f.updater.logger.error(fallback('Error: PRIVATE'));
  assert.equal(f.service.snapshot().fallbackReason,'unknown'); assert.equal((await f.complete()).ok,true);
  const persisted=fs.readFileSync(path.join(f.directory,'update-diagnostics.json'),'utf8');
  assert.ok(!persisted.includes('PRIVATE')); assert.ok(!persisted.includes('private.invalid'));
});
test('cache reuse needs the verified-cache log and matching completion, never a completed download or plan alone', async t => {
  const f=await fixture(t);
  f.updater.logger.info('Update has already been downloaded to C:\\PRIVATE\\update.exe).');
  assert.equal(f.service.snapshot().downloadMode,'preparing');
  f.updater.emit('update-downloaded',{version:'3.6.7'}); assert.equal(f.service.snapshot().phase,'downloading');
  assert.equal((await f.complete()).ok,true); assert.equal(f.service.snapshot().downloadMode,'cached');
  assert.equal(f.diagnostics.snapshot().events.filter(x=>x.event==='download_cache_reused').length,1);
  assert.ok(!fs.readFileSync(path.join(f.directory,'update-diagnostics.json'),'utf8').includes('PRIVATE'));
  const unknown=await fixture(t); assert.equal((await unknown.complete()).ok,true); assert.notEqual(unknown.service.snapshot().downloadMode,'cached');
  const interrupted=await fixture(t); interrupted.updater.logger.info('Update has already been downloaded to PRIVATE).'); interrupted.updater.emit('download-progress',{transferred:1,total:5,percent:20});
  await interrupted.complete(); assert.notEqual(interrupted.service.snapshot().downloadMode,'cached');
});
test('each download gates differential on its own baseline and full cache reuse still works without baseline', async t => {
  let checks=0;
  const f=await fixture(t,{prepareDownload:async()=>{checks++;return checks===1?{trusted:false,reason:'version_mismatch'}:{trusted:true};}});
  assert.equal(f.updater.disableDifferentialDownload,true); assert.equal(f.service.snapshot().downloadMode,'full'); assert.equal(f.service.snapshot().baselineReason,'version_mismatch');
  f.updater.logger.info(startLog); assert.equal(f.service.snapshot().downloadMode,'full');
  f.pending.reject(Error()); await f.download; f.retry(); await tick();
  assert.equal(f.updater.disableDifferentialDownload,false); assert.equal(f.service.snapshot().baselineReason,undefined);
  f.updater.logger.info(startLog); f.updater.emit('download-progress',{transferred:1,total:10,percent:10}); await f.complete(); assert.equal(f.service.snapshot().downloadMode,'differential'); assert.equal(checks,2);
  const cached=await fixture(t,{prepareDownload:async()=>({trusted:false,reason:'baseline_missing'})});
  cached.updater.logger.info('Update has already been downloaded to PRIVATE).'); await cached.complete(); assert.equal(cached.service.snapshot().downloadMode,'cached');
});
test('baseline exceptions and unknown reasons degrade to a safe full download instead of failing or leaking text', async t => {
  for(const prepareDownload of [async()=>{throw Error('PRIVATE');},async()=>({trusted:false,reason:'PRIVATE'})]) {
    const f=await fixture(t,{prepareDownload}); assert.equal(f.service.snapshot().downloadMode,'full'); assert.equal(f.service.snapshot().baselineReason,'unknown'); assert.equal((await f.complete()).ok,true);
    assert.ok(!JSON.stringify(f.diagnostics.snapshot()).includes('PRIVATE'));
  }
});
test('fallback classifier accepts only pinned error shapes and first-line filesystem context', () => {
  const cases=[
    ["Error: ENOENT: no such file or directory, open 'C:\\Synthetic\\installer.exe'",{},'old_installer_missing'],
    ["Error: EACCES: permission denied, open 'C:/Synthetic/installer.exe'",{},'old_installer_unreadable'],
    ["Error: ENOENT: no such file or directory, open 'C:/Synthetic/temp-target.exe'",{},'unknown'],
    ['Error: Cannot parse blockmap "https://synthetic.invalid?token=PRIVATE", error: PRIVATE',{},'blockmap_failed'],
    ['Error: Blockmap "https://synthetic.invalid" is empty',{},'blockmap_failed'],
    ['Error: version is different (1 - 2), full download is required',{},'blockmap_failed'],
    ['HttpError: 404 Not Found',{},'blockmap_failed'],
    ['HttpError: 503 Unavailable',{planReady:true},'transfer_failed'],
    ['Error: Request timed out',{planReady:true},'transfer_failed'],
    ["Error: Server doesn't support Accept-Ranges (response code 200)",{planReady:true},'transfer_failed'],
    ['Error: sha512 checksum mismatch, expected PRIVATE, got PRIVATE',{},'checksum_failed'],
    ['Error: PRIVATE',{checksumMismatch:true},'checksum_failed'],
    ["Error: PRIVATE\n    Error: ENOENT: no such file or directory, open 'C:/Synthetic/installer.exe'",{},'unknown'],
    ['Error: https://synthetic.invalid/ENOENT/installer.exe?token=PRIVATE',{},'unknown'],
    ['Error: token=PRIVATE ERR_CHECKSUM_MISMATCH',{},'unknown'],
  ];
  for(const [value,context,reason] of cases) assert.equal(classifyDifferentialFallback(value,context),reason);
  assert.equal(classifyDifferentialFallback({stack:'PRIVATE'}),'unknown');
});
test('diagnostic projection preserves only mode/reason enums through persistence and reload', async t => {
  const f=await fixture(t);
  for(const reason of ['old_installer_missing','old_installer_unreadable','blockmap_failed','transfer_failed','checksum_failed','unknown']) f.diagnostics.record('differential_fallback',{fallbackReason:reason,raw:'PRIVATE',downloadMode:'full-fallback'});
  f.diagnostics.record('differential_unavailable',{baselineReason:'installer_corrupt',raw:'PRIVATE'});
  assert.deepEqual(project({event:'differential_fallback',fallbackReason:'PRIVATE',downloadMode:'PRIVATE',baselineReason:'PRIVATE',stack:'PRIVATE'}),{event:'differential_fallback'});
  const reloaded=createUpdateDiagnostics({directory:f.directory,currentVersion:'3.6.8'}).snapshot();
  assert.equal(reloaded.events.filter(x=>x.event==='differential_fallback').length,6); assert.ok(!JSON.stringify(reloaded).includes('PRIVATE')); await f.complete();
});
test('pinned dependency has the observed literals and differential progress excludes local COPY operations', () => {
  const root=path.resolve(__dirname,'..'), read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.equal(require('../package.json').dependencies['electron-updater'],'6.8.11');
  assert.equal(require('electron-updater/package.json').version,'6.8.11');
  const updater=read('node_modules/electron-updater/out/AppUpdater.js'), diff=read('node_modules/electron-updater/out/differentialDownloader/DifferentialDownloader.js'), cached=read('node_modules/electron-updater/out/DownloadedUpdateHelper.js');
  for(const literal of ['Download block maps (old: "','Cannot download differentially, fallback to full download: ','sha512 checksum mismatch after differential download (']) assert.ok(updater.includes(literal));
  assert.ok(diff.indexOf('logger.info(`Full:')<diff.indexOf('const oldFileFd = await'));
  assert.ok(diff.indexOf('const oldFileFd = await')<diff.indexOf('this.logger.info(`Differential download:'));
  assert.ok(cached.indexOf('const cachedUpdateFile = await this.getValidCachedUpdateFile')<cached.indexOf('logger.info(`Update has already been downloaded to'));
  assert.match(read('node_modules/electron-updater/out/differentialDownloader/ProgressDifferentialDownloadCallbackTransform.js'),/operationType == OperationKind.COPY[\s\S]*?callback\(null, chunk\);[\s\S]*?return;/);
  assert.equal(require('builder-util-runtime').CURRENT_APP_INSTALLER_FILE_NAME,'installer.exe');
});


test('zero-change differential callback keeps finite original bytes and cannot prove a transfer or complete early',async t=>{
 const f=await fixture(t);f.updater.logger.info(startLog);f.updater.logger.info('Full: 100 KB, To download: 0 KB (0%)');
 f.updater.emit('download-progress',{transferred:0,total:0,percent:100,bytesPerSecond:NaN});
 assert.equal(f.service.snapshot().phase,'downloading');assert.equal(f.service.snapshot().downloadMode,'differential-attempt');assert.deepEqual(f.service.snapshot().progress,{transferred:0,total:0,percent:100});
 assert.equal((await f.complete()).ok,true);assert.equal(f.service.snapshot().phase,'downloaded');assert.equal(f.diagnostics.snapshot().events.filter(x=>x.event==='differential_downloading').length,0);
});


test('trusted update-state IPC forwards additive safe evidence and rejects arbitrary caller arguments',async t=>{
 const f=await fixture(t),handlers=new Map(),contents={id:1,mainFrame:{url:'http://127.0.0.1:3000/'},isDestroyed:()=>false};
 const {createSessionPolicy}=require('./session-policy.cjs'),{registerDesktopIpc}=require('./ipc.cjs');
 const policy=createSessionPolicy({origin:'http://127.0.0.1:3000',token:'synthetic',getWebContents:()=>contents});
 registerDesktopIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler(){}},policy,getWindow:()=>({}),runtimeInfo:()=>({}),getUpdateService:()=>f.service});
 f.updater.logger.info(startLog);f.updater.logger.error(fallback("Error: ENOENT: no such file or directory, open 'C:/Synthetic/installer.exe'"));
 const event={sender:contents,senderFrame:contents.mainFrame},state=await handlers.get('nova:update-state')(event);
 assert.equal(state.downloadMode,'full-fallback');assert.equal(state.fallbackReason,'old_installer_missing');assert.ok(!JSON.stringify(state).includes('Synthetic'));
 assert.equal((await handlers.get('nova:update-state')(event,{url:'https://synthetic.invalid'})).code,'INVALID_ARGUMENT');
 assert.equal((await handlers.get('nova:update-state')({...event,sender:{}})).code,'IPC_FORBIDDEN');await f.complete();
});
