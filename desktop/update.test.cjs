'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateService, textNotes } = require('./update-service.cjs');
const { validateMetadata, isInstalledNsis, readNsisInstallLocation } = require('./update-policy.cjs');
const { attachInstallerLaunchProof } = require('./update-launcher.cjs');
const { registerDesktopIpc } = require('./ipc.cjs');
const { createSessionPolicy } = require('./session-policy.cjs');
const { createUpdateGate } = require('../backend/storage/update-gate');
const { createUpdateQuitHandler } = require('./update-quit.cjs');
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function fixture(options = {}) {
  const updater = new EventEmitter(), events = [], calls = {check:0,download:0,install:0,prepare:0,release:0,close:0,failure:0};
  updater.checkForUpdates = async () => { calls.check++; const info = {version:'3.5.3',releaseNotes:'safe'}; updater.emit('update-available',info); return {updateInfo:info}; };
  updater.downloadUpdate = async () => { calls.download++; updater.emit('download-progress',{percent:150,total:200,transferred:100,bytesPerSecond:NaN,path:'private'}); updater.emit('update-downloaded',{version:'3.5.3',file:'C:/private'}); return ['C:/private']; };
  updater.quitAndInstall = () => {calls.install++;};
  let service;
  service = createUpdateService({ policy:{supported:true,installSupported:true},currentVersion:'3.5.2',createUpdater:()=>updater,
    send:(event,value)=>{events.push({event,value});if(event==='nova:update-flush' && options.autoFlush !== false) queueMicrotask(()=>service.acknowledgeFlush({id:value.id,ok:options.flushOk !== false}));},
    prepareBackend:()=>{calls.prepare++;return {remoteMayContinue:true};},releaseBackend:()=>{calls.release++;},closeBackend:async()=>{calls.close++;return {databaseClosed:true,checkpointComplete:true};},onClosedFailure:()=>calls.failure++,...options.service });
  return {service,updater,events,calls,async downloaded(){await service.check();await service.download();}};
}
test('once-per-process startup merges manual concurrency; no automatic download or quit installation',async()=>{
  const f=fixture(), pending=deferred(); f.updater.checkForUpdates=()=>{f.calls.check++;return pending.promise;};
  const a=f.service.startup(),b=f.service.startup(),c=f.service.check();assert.equal(a,b);assert.equal(a,c);await tick();assert.equal(f.calls.check,1);
  pending.resolve({updateInfo:{version:'3.5.2'}});await a;await f.service.startup();assert.equal(f.calls.check,1);
  assert.equal(f.updater.autoDownload,false);assert.equal(f.updater.autoInstallOnAppQuit,false);assert.equal(f.updater.disableWebInstaller,true);assert.equal(f.updater.disableDifferentialDownload,false);assert.equal(f.calls.install,0);assert.equal(f.calls.download,0);
  await f.service.check();assert.equal(f.calls.check,2);
});
test('availability survives late subscription through snapshot, dismisses and deduplicates same version',async()=>{
  const f=fixture();await f.service.startup();assert.equal(f.service.snapshot().notice,'3.5.3');f.service.dismiss();await f.service.check();assert.equal(f.service.snapshot().notice,null);assert.equal(f.calls.download,0);
  const notes=textNotes('<script>bad</script> https://signed.invalid/?token=secret C:\\Users\\Private token=secret');assert.ok(!notes.includes('signed.invalid'));assert.ok(!notes.includes('secret'));assert.ok(!notes.includes('Private'));assert.ok(!notes.includes('<'));
});
test('silent startup failures have no notice and fixed errors expose no source error text',async()=>{
  const f=fixture();f.updater.checkForUpdates=async()=>{throw Error('Bearer secret https://signed.invalid/?token=secret C:\\Users\\private');};
  await f.service.startup();assert.equal(f.service.snapshot().notice,null);assert.equal(f.service.snapshot().error.code,'UPDATE_CHECK_FAILED');assert.ok(!JSON.stringify(f.events).includes('secret'));
  assert.equal(f.events.filter(e=>e.event==='nova:update-state').length,2);await f.service.startup();assert.equal(f.events.length,2);
});
test('download deduplicates, sanitizes progress, and completion never triggers installation',async()=>{
  const f=fixture();await f.service.check();const a=f.service.download(),b=f.service.download();assert.equal(a,b);await a;assert.equal(f.calls.download,1);assert.equal(f.calls.install,0);assert.equal(f.service.snapshot().phase,'downloaded');
  const p=f.events.find(e=>e.value.progress)?.value.progress;assert.deepEqual(p,{percent:100,total:200,transferred:100});assert.ok(!JSON.stringify(f.events).includes('C:/private'));
});
test('safe install orders prepare, acknowledged save, strict close, then explicit install',async()=>{
  const f=fixture({autoFlush:false});await f.downloaded();const pending=f.service.install();await tick();assert.equal(f.calls.prepare,1);assert.equal(f.calls.close,0);assert.equal(f.calls.install,0);
  const request=f.events.find(e=>e.event==='nova:update-flush').value;
  assert.equal(f.service.acknowledgeFlush({id:'wrong',ok:true}).ok,false);assert.equal(f.service.acknowledgeFlush({...request,ok:true,path:'ignored'}).ok,false);
  assert.equal(f.service.acknowledgeFlush({...request,ok:true}).ok,true);assert.equal((await pending).ok,true);assert.equal(f.calls.close,1);assert.equal(f.calls.install,1);assert.equal(f.service.snapshot().phase,'installing');
});
for(const type of ['busy','save','timeout','close','unproven-close'])test('install refuses '+type+' and retains downloaded state',async()=>{
  const overrides=type==='busy'?{prepareBackend:()=>{throw {code:'UPDATE_BUSY'};}}:type==='close'?{closeBackend:()=>{throw Error('private');}}:type==='unproven-close'?{closeBackend:()=>({databaseClosed:true})}:{};
  const f=fixture({autoFlush:type!=='timeout',flushOk:type!=='save',service:{timeoutMs:10,...overrides}});await f.downloaded();const result=await f.service.install();assert.equal(result.ok,false);assert.equal(f.calls.install,0);assert.equal(f.service.snapshot().phase,'downloaded');assert.equal(f.calls.release,1);
});
test('partial close failure uses visible restart path and cannot claim normal usage resumed',async()=>{
  const f=fixture({service:{closeBackend:()=>{throw {closed:true};}}});await f.downloaded();await f.service.install();assert.equal(f.service.snapshot().phase,'closed-error');assert.equal(f.calls.release,0);assert.equal(f.calls.failure,1);assert.equal(f.calls.install,0);
});
test('async installer error keeps closed-error authoritative and forbids refresh/download from overwriting it',async()=>{
  const f=fixture();await f.downloaded();await f.service.install();f.updater.emit('error',Error('C:/private https://signed.invalid/?key=secret'));assert.equal(f.service.snapshot().phase,'closed-error');assert.equal(f.calls.failure,1);assert.equal((await f.service.check()).ok,false);assert.equal((await f.service.download()).ok,false);assert.equal(f.service.snapshot().phase,'closed-error');assert.ok(!JSON.stringify(f.service.snapshot()).includes('secret'));
});
test('override and portable/disabled policies never install/check unintentionally',async()=>{
  const f=fixture({service:{policy:{supported:true,installSupported:false,installReason:'DATA_DIRECTORY_RESTART_UNPROVEN'}}});await f.downloaded();assert.equal((await f.service.install()).code,'DATA_DIRECTORY_RESTART_UNPROVEN');assert.equal(f.calls.prepare,0);
  const off=fixture({service:{policy:{supported:false,reason:'UPDATE_NOT_ENABLED'}}});await off.service.startup();await off.service.check();assert.equal(off.calls.check,0);assert.equal(off.service.snapshot().phase,'unsupported');
});
function metadata() {const appId='com.novaimage.studio.offline-test.followup-20261024';return {schemaVersion:1,profile:'local-test',version:'3.5.2',windowsVersion:'3.5.2.0',minimumUpdatableVersion:'3.5.0',appId,productName:'Nova Studio T16 Followup',updaterCacheDirName:appId+'-updater',feed:{provider:'generic',url:'http://127.0.0.1:18888/',channel:'latest',useMultipleRangeRequest:false},signature:{mode:'unsigned-local-test',publisherNames:[]},runtimeReady:true};}
test('metadata validates full immutable identity/feed/signature/version and disables old/uninstalled/portable',()=>{
  const m=metadata(),base={metadata:m,config:{...m.feed,updaterCacheDirName:m.updaterCacheDirName},version:'3.5.2',platform:'win32',arch:'x64',packaged:true,installed:true,dataMode:'system'};
  assert.equal(validateMetadata(base).supported,true);
  for(const patch of [{runtimeReady:false},{schemaVersion:2},{appId:'other'},{version:'3.5.1'},{windowsVersion:'3.5.2.1'},{token:'secret'},{feed:{...m.feed,url:'https://other.invalid/'}},{signature:{mode:'authenticode',publisherNames:[]}}])assert.equal(validateMetadata({...base,metadata:{...m,...patch}}).supported,false);
  for(const patch of [{platform:'darwin'},{arch:'arm64'},{packaged:false},{installed:false},{dataMode:'portable'},{config:{...base.config,token:'secret'}},{config:{...base.config,updaterCacheDirName:'shared'}}])assert.equal(validateMetadata({...base,...patch}).supported,false);
  assert.equal(validateMetadata({...base,dataMode:'override'}).installSupported,false);
  const app={isPackaged:true,getAppPath:()=>String.raw`C:\app\resources\app.asar`,getPath:()=>String.raw`C:\app\Nova Studio T16 Followup.exe`};
  assert.equal(isInstalledNsis(app,m,{exists:()=>true,readRegistry:()=>{throw Error();}}),false);
});
test('release feed cannot select other github or turn off publisher verification',()=>{
  const m={...metadata(),profile:'release',appId:'com.novaimage.studio',productName:'Nova Image Studio',updaterCacheDirName:'com.novaimage.studio-updater',feed:{provider:'github',owner:'hanjiyou',repo:'nova-video-studio',private:false,channel:'latest',releaseType:'release'},signature:{mode:'authenticode',publisherNames:['CN=Synthetic Publisher']}};
  const base={metadata:m,config:{...m.feed,updaterCacheDirName:m.updaterCacheDirName,publisherName:m.signature.publisherNames},version:'3.5.2',platform:'win32',arch:'x64',packaged:true,installed:true,dataMode:'system'};
  assert.equal(validateMetadata(base).supported,true);assert.equal(validateMetadata({...base,metadata:{...m,feed:{...m.feed,repo:'other'}}}).supported,false);assert.equal(validateMetadata({...base,config:{...base.config,publisherName:[]}}).supported,false);
});
test('exact installed NSIS probe preserves Chinese paths/spaces and rejects other registry identities',()=>{
  const path=require('node:path'), m=metadata(), location=path.resolve('C:/隔离 用户/Nova Studio');
  const app={isPackaged:true,getAppPath:()=>path.join(location,'resources/app.asar'),getPath:()=>path.join(location,m.productName+'.exe')};
  let calls=0;
  const readRegistry=(exe,args)=>{calls++;assert.equal(exe,'powershell.exe');const script=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.ok(script.includes('Registry64'));assert.ok(script.includes("OpenSubKey('Software\\3e5d42e7-0190-508b-80e7-1e99104f9b23')"));assert.ok(script.includes('UTF8Encoding'));return JSON.stringify(location);};
  assert.equal(isInstalledNsis(app,m,{exists:()=>true,readRegistry}),true);assert.equal(calls,1);
  assert.equal(isInstalledNsis(app,m,{exists:()=>true,readRegistry:()=>JSON.stringify(location+' other')}),false);
  assert.equal(isInstalledNsis(app,m,{exists:()=>false,readRegistry:()=>assert.fail()}),false);
  assert.throws(()=>readNsisInstallLocation('HKCU','other-key',()=>assert.fail()),/exact NSIS/);
});
test('update IPC rejects foreign/main-frame lookalikes and arbitrary URL/path inputs; activity IPC cannot bypass gate',async()=>{
  const handlers=new Map(),contents={id:1,mainFrame:{url:'http://127.0.0.1:3000/'},isDestroyed:()=>false},policy=createSessionPolicy({origin:'http://127.0.0.1:3000',token:'synthetic',getWebContents:()=>contents}),gate=createUpdateGate();let calls=0;
  registerDesktopIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f),removeHandler(){}},policy,getWindow:()=>({}),runtimeInfo:()=>({}),getUpdateGate:()=>gate,getUpdateService:()=>({check:()=>{calls++;return {ok:true};}})});
  const event={sender:contents,senderFrame:contents.mainFrame};for(const bad of [{...event,sender:{}},{...event,senderFrame:{url:contents.mainFrame.url}}])assert.equal((await handlers.get('nova:update-check')(bad)).code,'IPC_FORBIDDEN');
  for(const argument of ['https://evil.invalid','C:\\installer.exe',{}])assert.equal((await handlers.get('nova:update-check')(event,argument)).code,'INVALID_ARGUMENT');
  assert.equal(calls,0);assert.equal((await handlers.get('nova:update-check')(event)).ok,true);gate.begin();assert.equal((await handlers.get('nova:choose-output-directory')(event)).code,'UPDATE_PREPARING');
});
for(const scenario of ['spawn','async-error','sync-throw'])test('installer launch proof '+scenario+' waits for actual process start',async()=>{
  const child=new EventEmitter();let unrefs=0;child.unref=()=>unrefs++;const updater={};const proof=attachInstallerLaunchProof(updater,()=>{if(scenario==='sync-throw')throw Error('private');return child;});
  const launch=updater.spawnLog('fixed-installer',['--updated'],undefined,'ignore');let settled=false;proof.confirm().then(()=>{settled=true;});await tick();if(scenario!=='sync-throw')assert.equal(settled,false);
  if(scenario==='spawn'){child.emit('spawn');assert.equal(await launch,true);assert.equal(await proof.confirm(),true);assert.equal(unrefs,1);}else{if(scenario==='async-error')child.emit('error',Error('private'));await assert.rejects(launch,{code:'NOVA_INSTALLER_START_FAILED'});assert.equal(await proof.confirm(),false);}
});
test('ordinary quit never takes update path; update quit waits for spawn proof and handles reentry exactly once',async()=>{
  const proof=deferred(),order=[];let updates={phase:'downloaded'};
  const handler=createUpdateQuitHandler({getUpdates:()=>updates,getLaunchProof:()=>({confirm:()=>proof.promise}),closeHost:()=>order.push('close-host'),quit:()=>order.push('quit'),onFailure:()=>order.push('failure')});
  const event={preventDefault:()=>order.push('prevent')};assert.equal(handler.handle(event),false);assert.deepEqual(order,[]);
  updates={installing:true};assert.equal(handler.handle(event),true);handler.handle(event);await tick();assert.deepEqual(order,['prevent','prevent']);proof.resolve(true);await tick();assert.deepEqual(order,['prevent','prevent','close-host','quit']);
});
test('failed launch never quits and uses visible recovery, while preparation blocks ordinary shutdown',async()=>{
  const order=[];let updates={preparing:true};const handler=createUpdateQuitHandler({getUpdates:()=>updates,getLaunchProof:()=>({confirm:async()=>false}),closeHost:()=>assert.fail(),quit:()=>assert.fail(),onFailure:()=>order.push('failure')});
  assert.equal(handler.handle({preventDefault:()=>order.push('prevent')}),true);updates={installing:true};handler.handle({preventDefault:()=>order.push('prevent')});await tick();assert.deepEqual(order,['prevent','prevent','failure']);
});
