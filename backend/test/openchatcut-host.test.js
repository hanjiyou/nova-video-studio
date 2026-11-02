'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loopbackOrigin, editorPath, validateViewport, viewportBounds, createEditorSessionPolicy } = require('../../desktop/openchatcut/policy.cjs');
const { createEditorView } = require('../../desktop/openchatcut/view.cjs');
const { createEditorHost, ENGINE_COMMIT } = require('../../desktop/openchatcut/host.cjs');
const { createEditorCloseGuard } = require('../../desktop/openchatcut/lifecycle.cjs');
const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
const origin = 'http://127.0.0.1:5199';
const route = '/#/editor/00000000-0000-4000-8000-000000000001';
const rectangle = { visible: true, x: 220, y: 40, width: 800, height: 500 };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('runner origin and editor entry are exact loopback capabilities, not arbitrary URLs', () => {
  assert.equal(loopbackOrigin(origin), origin);
  for (const value of ['http://localhost:5199', origin + '/', origin + '/?token=x', 'https://127.0.0.1:5199', 'http://user@127.0.0.1:5199', 'http://127.0.0.2:5199', 'file:///tmp/x']) assert.equal(loopbackOrigin(value), null, value);
  assert.equal(editorPath(route), route);
  for (const value of ['//evil.invalid', '/#/editor/../x', '/#/editor/x?secret=x', 'https://evil.invalid']) assert.equal(editorPath(value), null);
});

test('editor session preserves native workers and sandbox resources while denying privileged local sources', () => {
  const policy = createEditorSessionPolicy(origin);
  for (const [url, resourceType] of [[origin + '/app.js','script'], [origin + '/sandbox.html','subFrame'], ['about:srcdoc','subFrame'], ['blob:' + origin + '/abc','script'], ['https://cdn.example.org/model.onnx','xhr']]) assert.equal(policy.beforeRequest({ url, resourceType }).cancel, false, url);
  for (const url of ['https://evil.invalid/', 'http://127.0.0.1:31207/', 'file:///secret']) assert.equal(policy.beforeRequest({ url, resourceType: 'mainFrame' }).cancel, true);
  for (const host of ['127.0.0.2', '127.1', '0.0.0.0', '10.1.2.3', '100.64.0.1', '169.254.1.2', '172.16.0.1', '172.31.255.1', '192.168.1.2', '192.0.0.1', '198.18.0.1', '[::]', '[::1]', '[::ffff:127.0.0.2]', '[::ffff:c0a8:1]', '[fe80::1]', '[fc00::1]', '[ff02::1]', 'localhost.', 'asset.local', 'service.internal']) assert.equal(policy.beforeRequest({ url: 'https://' + host + '/x', resourceType: 'xhr' }).cancel, true, host);
  assert.equal(policy.beforeRequest({ url: 'https://example.org/frame', resourceType: 'subFrame' }).cancel, true);
  assert.deepEqual(policy.beforeSendHeaders({ requestHeaders: { 'X-NoVa-SeSsIoN':'fake-nova-secret', Accept:'text/html' } }).requestHeaders, { Accept:'text/html' });
});

test('viewport rejects unknown fields and nonfinite values and converts CSS to DIP without covering navigation', () => {
  assert.deepEqual(validateViewport(rectangle), rectangle);
  for (const value of [{ ...rectangle, path:'C:/secret' }, { ...rectangle, x:-1 }, { ...rectangle, x:NaN }, { ...rectangle, x:1.2 }, { ...rectangle, width:Infinity }, { ...rectangle, height:0 }, null]) assert.equal(validateViewport(value), null);
  assert.deepEqual(viewportBounds(rectangle, { width:1440,height:900 },1.25), { x:275,y:50,width:1000,height:625 });
  assert.deepEqual(viewportBounds({ ...rectangle,x:0,y:0,width:2000,height:2000 }, { width:1440,height:900 }), { x:202,y:0,width:1238,height:900 });
  assert.deepEqual(viewportBounds(rectangle,{width:100,height:20}),{x:100,y:20,width:0,height:0});
});

function viewFixture({ ready = true, readinessTimeoutMs = 10000, clearContentsOnClose = false } = {}) {
  const callbacks = {};
  const session = { webRequest: {
    onBeforeRequest(_filter,callback){ callbacks.beforeRequest = callback; },
    onBeforeSendHeaders(_filter,callback){ callbacks.beforeSendHeaders = callback; },
  }, setPermissionRequestHandler(callback){ callbacks.permission = callback; }, setPermissionCheckHandler(callback){ callbacks.checkPermission = callback; } };
  class Contents extends EventEmitter {
    destroyed=false; veto=false; closeOptions=[];
    setWindowOpenHandler(handler){ this.openHandler=handler; }
    async loadURL(url){ this.url=url; }
    async executeJavaScript(script){ this.readyScript=script;return ready; }
    isDestroyed(){ return this.destroyed; }
    close(options){ this.closeOptions.push(options); if(options?.waitForBeforeUnload && this.veto) { const event={ preventDefault(){ throw new Error('must not override save veto'); } }; this.emit('will-prevent-unload',event); return; } this.destroyed=true; if(clearContentsOnClose)this.ownerView.webContents=undefined;this.emit('destroyed'); }
  }
  const views=[];
  class View {
    constructor(options){ this.options=options;this.webContents=new Contents();this.webContents.ownerView=this;views.push(this); }
    setVisible(value){ this.visible=value; }
    setBounds(value){ this.bounds=value; }
  }
  const window=new EventEmitter();
  window.webContents=new EventEmitter();window.webContents.getZoomFactor=()=>1.25;
  window.getContentBounds=()=>({width:1440,height:900});window.isDestroyed=()=>false;
  window.contentView={addChildView(view){window.attached=view;},removeChildView(){window.attached=null;}};
  let partition;
  const electron={WebContentsView:View,session:{fromPartition(value){partition=value;return session;}}};
  const manager=createEditorView({electron,getWindow:()=>window,dataDirectory:'synthetic-profile',readinessTimeoutMs,readinessPollMs:1});
  return {manager,window,views,callbacks,partition:()=>partition};
}

test('native view uses dedicated session, no preload and no Nova authority; hide cannot be undone by stale resize',async()=>{
  const f=viewFixture();
  f.manager.activate();f.manager.setViewport(rectangle);await f.manager.load(origin,route);
  const view=f.views[0];
  assert.match(f.partition(),/^persist:nova-openchatcut-/);
  assert.equal(view.options.webPreferences.nodeIntegration,false);assert.equal(view.options.webPreferences.contextIsolation,true);assert.equal(view.options.webPreferences.sandbox,true);
  assert.equal(view.options.webPreferences.preload,undefined);
  assert.equal(view.visible,true);assert.equal(view.webContents.url,origin+route);
  assert.deepEqual(view.bounds,{x:275,y:50,width:1000,height:625});
  assert.deepEqual(view.webContents.openHandler(),{action:'deny'});
  let denied;f.callbacks.permission(null,'camera',value=>{denied=!value;});assert.equal(denied,true);
  f.manager.hide();f.manager.setViewport(rectangle);assert.equal(view.visible,false);
  f.manager.activate();assert.equal(view.visible,true);
  let prevented=false;view.webContents.emit('will-navigate',{preventDefault(){prevented=true;}},'https://outside.invalid');assert.equal(prevented,true);
  f.manager.dispose();assert.equal(view.webContents.isDestroyed(),true);assert.equal(f.window.attached,null);
});

test('native beforeunload veto keeps editing context alive and can later close after save',async()=>{
  const f=viewFixture();await f.manager.load(origin,route);
  const contents=f.views[0].webContents;contents.veto=true;
  assert.equal(await f.manager.requestClose(),false);assert.equal(contents.isDestroyed(),false);
  contents.veto=false;assert.equal(await f.manager.requestClose(),true);
  assert.deepEqual(contents.closeOptions,[{waitForBeforeUnload:true},{waitForBeforeUnload:true}]);
  f.manager.dispose();
});

test('HTML load alone is not readiness: native React shell, library and timeline must mount',async()=>{
  const f=viewFixture({ready:false,readinessTimeoutMs:5});
  await assert.rejects(f.manager.load(origin,route),/EDITOR_LOAD_FAILED/);
  assert.equal(f.views[0].visible,false);assert.match(f.views[0].webContents.readyScript,/cc-editor-shell/);assert.match(f.views[0].webContents.readyScript,/cc-library-panel/);assert.match(f.views[0].webContents.readyScript,/cc-timeline/);
  f.manager.dispose();
});

test('native close may clear view.webContents: retaining original contents makes repeat teardown safe',async()=>{
  const f=viewFixture({clearContentsOnClose:true});await f.manager.load(origin,route);
  const contents=f.views[0].webContents;
  assert.equal(await f.manager.requestClose(),true);assert.equal(f.views[0].webContents,undefined);assert.equal(contents.isDestroyed(),true);
  assert.equal(await f.manager.requestClose(),true);
  assert.doesNotThrow(()=>{f.manager.hide();f.manager.resize();f.manager.reset();f.manager.dispose();});
});

function hostFixture({ ready=true, inspect, invalidOrigin, loading, timeout=100, closeAllowed=true, environment }={}) {
  const processes=[], options=[], states=[];
  let hooks;
  const view={active:false,loaded:[],visible:false,present:false,
    activate(){this.active=true;},hide(){this.active=false;this.visible=false;},
    async load(...args){this.present=true;this.loaded.push(args);if(loading)await loading;this.visible=this.active;},
    setViewport(value){this.rectangle=value;},reset(){this.present=false;this.visible=false;},dispose(){this.reset();},hasView(){return this.present;},requestClose:async()=>closeAllowed,
  };
  class Child extends EventEmitter {
    exitCode=null;connected=true;stopCount=0;
    send(message,callback){this.stopCount++;assert.equal(message.type,'openchatcut:stop');queueMicrotask(()=>{this.exitCode=0;this.emit('exit',0);});callback?.(null);}
    kill(){this.exitCode=1;this.emit('exit',1);}
  }
  const host=createEditorHost({electron:{},getWindow:()=>({}),dataDirectory:'synthetic-profile',startTimeoutMs:timeout,stopTimeoutMs:20,
    inspectRuntime:inspect||(()=>({available:true,engineCommit:ENGINE_COMMIT,servicePath:path.resolve('fake-service.mjs'),workingDirectory:path.resolve('.')})),
    createEnvironment:environment||(()=>({SAFE_ONLY:'1'})),createView:value=>{hooks=value;return view;},sendState:value=>states.push(value),
    forkService(_entry,_args,value){options.push(value);const child=new Child();processes.push(child);if(ready)queueMicrotask(()=>child.emit('message',{type:'openchatcut:ready',origin:invalidOrigin||origin,editorPath:route,engineCommit:ENGINE_COMMIT}));return child;},
  });
  return{host,view,processes,options,states,hooks:()=>hooks};
}

test('host coalesces concurrent opens, filters process inheritance and keeps origins out of public state',async()=>{
  const f=hostFixture();const [a,b]=await Promise.all([f.host.open(),f.host.open()]);
  assert.equal(a.ok,true);assert.equal(b.state.phase,'ready');assert.equal(f.processes.length,1);
  assert.deepEqual(f.options[0].env,{SAFE_ONLY:'1',ELECTRON_RUN_AS_NODE:'1'});assert.deepEqual(f.options[0].execArgv,[]);assert.equal(f.options[0].windowsHide,true);
  assert.equal(JSON.stringify(f.host.state()).includes(origin),false);
  assert.throws(()=>f.host.prepareForUpdate(),{code:'UPDATE_BUSY'});
  await f.host.dispose();assert.equal(f.processes[0].stopCount,1);assert.equal(f.host.state().state.phase,'stopped');
});

test('hide while loading prevents late reveal; explicit reopen activates existing context',async()=>{
  let loaded;const loading=new Promise(resolve=>{loaded=resolve;});const f=hostFixture({loading});
  const pending=f.host.open();await tick();f.host.hide();loaded();await pending;
  assert.equal(f.view.visible,false);assert.equal(f.view.active,false);
  await f.host.open();assert.equal(f.view.active,true);assert.equal(f.processes.length,1);
  await f.host.dispose();
});

test('invalid ready origin fails closed and can retry without leaked service details',async()=>{
  const f=hostFixture({invalidOrigin:'http://127.0.0.2:5199'});const result=await f.host.open();
  assert.equal(result.code,'EDITOR_INVALID_ORIGIN');assert.equal(f.view.loaded.length,0);
  assert.equal(JSON.stringify(result).includes('127.0.0.2'),false);
  assert.equal((await f.host.open()).ok,false);assert.equal(f.processes.length,2);await f.host.dispose();
});

test('timeout, unexpected service exit and failed preflight expose bounded codes and allow recovery',async()=>{
  const timed=hostFixture({ready:false,timeout:5});assert.equal((await timed.host.open()).code,'EDITOR_START_TIMEOUT');await timed.host.dispose();
  const live=hostFixture();await live.host.open();live.processes[0].emit('exit',1);assert.equal(live.host.state().state.code,'EDITOR_SERVICE_EXITED');assert.equal((await live.host.open()).ok,true);await live.host.dispose();
  const missing=hostFixture({inspect:()=>({available:false,code:'C:/secret/token'})});assert.equal((await missing.host.open()).code,'EDITOR_RUNTIME_UNAVAILABLE');assert.equal(missing.processes.length,0);await missing.host.dispose();
});

test('dispose and renderer failure settle an in-flight launch rather than leaving hanging IPC',async()=>{
  const stopped=hostFixture({ready:false});const pending=stopped.host.open();await stopped.host.dispose();assert.equal((await pending).code,'EDITOR_STOPPED');
  let loaded;const loading=new Promise(resolve=>{loaded=resolve;});const failed=hostFixture({loading});const opening=failed.host.open();await tick();failed.hooks().onFailure('EDITOR_RENDERER_EXITED');assert.equal((await opening).code,'EDITOR_RENDERER_EXITED');loaded();await failed.host.dispose();
});

test('guarded close does not dispose on page veto and permits a subsequent saved close',async()=>{
  let allowed=false;const f=hostFixture({closeAllowed:false});await f.host.open();assert.equal(await f.host.requestClose(),false);assert.equal(f.processes[0].stopCount,0);await f.host.dispose();
  const g=hostFixture();await g.host.open();assert.equal(await g.host.requestClose(),true);assert.equal(g.processes[0].stopCount,1);assert.equal((await g.host.open()).ok,true);await g.host.dispose();
  let notices=0;const guard=createEditorCloseGuard({getEditor:()=>({hasEditingContext:()=>true,requestClose:async()=>allowed}),getWindow:()=>null,dialog:{showMessageBox:async()=>{notices++;}}});
  assert.equal(await guard.requestClose(),false);assert.equal(notices,1);allowed=true;assert.equal(await guard.requestClose(),true);
});

test('window close guard cancels unsaved closure and allows one saved re-entrant close',async()=>{
  let allowed=false, hasContext=true, prevented=0, closes=0;
  const window={isDestroyed:()=>false,show(){},focus(){},close(){closes++;assert.equal(guard.interceptWindowClose({preventDefault(){throw new Error('saved close must not be intercepted twice');}}),false);}};
  const guard=createEditorCloseGuard({getEditor:()=>({hasEditingContext:()=>hasContext,requestClose:async()=>{if(allowed)hasContext=false;return allowed;}}),getWindow:()=>window,dialog:{showMessageBox:async()=>{}}});
  assert.equal(guard.interceptWindowClose({preventDefault(){prevented++;}}),true);
  await tick();assert.equal(closes,0);assert.equal(hasContext,true);
  allowed=true;assert.equal(guard.interceptWindowClose({preventDefault(){prevented++;}}),true);
  await tick();assert.equal(closes,1);assert.equal(prevented,2);
});

test('editor IPC validates exact argument counts and viewport fields before invoking privileged methods',async()=>{
  const handlers=new Map();let opens=0;
  const host={state:()=>({ok:true,state:{phase:'idle'}}),open:()=>{opens++;return{ok:true};},viewport:value=>validateViewport(value)?{ok:true}:{ok:false,code:'EDITOR_INVALID_VIEWPORT'},hide:()=>({ok:true})};
  const ipc=registerDesktopIpc({ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)},dialog:{},shell:{},getWindow:()=>null,policy:{isTrustedSender:event=>event.trusted===true},runtimeInfo:()=>({}),getEditorHost:()=>host});
  const call=(name,...args)=>handlers.get(name)({trusted:true},...args);
  for(const name of ['nova:editor-state','nova:editor-open','nova:editor-hide'])assert.equal((await call(name,{url:'http://evil.invalid'})).code,'INVALID_ARGUMENT');
  assert.equal(opens,0);assert.equal((await call('nova:editor-viewport')).code,'INVALID_ARGUMENT');
  assert.equal((await call('nova:editor-viewport',{...rectangle,url:'file:///secret'})).code,'EDITOR_INVALID_VIEWPORT');
  assert.equal((await call('nova:editor-open')).ok,true);assert.equal(opens,1);
  ipc.dispose();
});

test('IPC only trusts Nova main frame and exposes fixed editor operations, hiding remains allowed during update freeze',async()=>{
  const handlers=new Map();let opens=0,runs=0;
  const host={state:()=>({ok:true,state:{phase:'idle',available:true,engineCommit:ENGINE_COMMIT}}),open:()=>{opens++;return{ok:true};},viewport:value=>validateViewport(value)?{ok:true}:{ok:false,code:'EDITOR_INVALID_VIEWPORT'},hide:()=>({ok:true})};
  const ipc=registerDesktopIpc({ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)},dialog:{},shell:{},getWindow:()=>null,policy:{isTrustedSender:event=>event.trusted===true},runtimeInfo:()=>({}),getEditorHost:()=>host,getUpdateGate:()=>({run:async()=>{runs++;throw Object.assign(new Error(),{code:'UPDATE_BUSY'});}})});
  const call=(name,...args)=>handlers.get(name)({trusted:true},...args);
  assert.equal((await handlers.get('nova:editor-open')({trusted:false})).code,'IPC_FORBIDDEN');assert.equal(opens,0);
  assert.equal((await call('nova:editor-state','file://secret')).code,'INVALID_ARGUMENT');
  assert.equal((await call('nova:editor-state')).state.phase,'idle');
  assert.equal((await call('nova:editor-hide')).ok,true);
  assert.equal((await call('nova:editor-viewport',{...rectangle,visible:false})).ok,true);
  assert.equal((await call('nova:editor-open')).ok,false);assert.equal(opens,0);assert.equal(runs,1);
  ipc.dispose();assert.equal(handlers.size,0);
});

test('busy update refusal preserves editor visibility and activation',async()=>{
  const f=hostFixture();await f.host.open();
  assert.equal(f.view.visible,true);assert.equal(f.view.active,true);
  assert.throws(()=>f.host.prepareForUpdate(),{code:'UPDATE_BUSY'});
  assert.equal(f.view.visible,true);assert.equal(f.view.active,true);assert.equal(f.host.state().state.phase,'ready');
  await f.host.dispose();
  const idle=hostFixture();assert.doesNotThrow(()=>idle.host.prepareForUpdate());await idle.host.dispose();
});

test('host forwards preflight-validated shared FFmpeg only to its service environment',async()=>{
  const shared=path.resolve('resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe');let received;
  const f=hostFixture({inspect:()=>({available:true,engineCommit:ENGINE_COMMIT,servicePath:path.resolve('fake-service.mjs'),workingDirectory:path.resolve('.'),ffmpegPath:shared}),environment:options=>{received=options;return {SAFE_ONLY:'1'};}});
  assert.equal((await f.host.open()).ok,true);assert.equal(received.ffmpegPath,shared);
  assert.equal(JSON.stringify(f.host.state()).includes(shared),false);await f.host.dispose();
});
