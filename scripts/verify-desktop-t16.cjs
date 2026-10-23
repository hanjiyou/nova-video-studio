'use strict';
// Installed EXE acceptance. Only synthetic fixtures and loopback; no main-process injection.
// CDP is enabled explicitly on loopback for test control and is not a normal launch setting.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn,execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3'),WebSocket=require('ws');
const {migrateDatabase}=require('../backend/storage/migrations'),{createWorkbenchStore}=require('../backend/storage/store'),{resolveBackendPort}=require('../desktop/runtime.cjs');
const [exeArg,outputArg,phase='first']=process.argv.slice(2),root=path.resolve(__dirname,'..'),exe=path.resolve(exeArg||''),output=path.resolve(outputArg||''),data=path.join(output,'隔离配置 中文 profile'),manifestFile=path.join(output,'fixture-manifest.json');
assert.ok(exeArg&&outputArg&&['first','restart','after-upgrade','after-reinstall'].includes(phase));
const evidence={phase,executable:exe,startedAt:new Date().toISOString(),scope:'Actual installed local test EXE, synthetic persisted media, explicit profile, normal inherited token, scrubbed developer PATH. No real provider and no GUI dialog/Explorer claim.',checks:{},requests:[]};
const check=(name,value)=>{assert.ok(value,name);evidence.checks[name]=true;};
evidence.packageHashes=Object.fromEntries([['exe',exe],['asar',path.join(path.dirname(exe),'resources/app.asar')]].map(([name,file])=>[name,require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
let child,exit,client,server;
async function until(fn,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){if(exit)throw Error('App exited '+JSON.stringify(exit));try{const v=await fn();if(v)return v;}catch(error){last=error;}await new Promise(r=>setTimeout(r,100));}throw last||Error('Timed out');}
async function connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let id=0;const pending=new Map();socket.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});return{close:()=>socket.close(),call(method,params={}){return new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>{pending.delete(next);reject(Error('CDP timeout '+method));},15000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}));});}};}
(async()=>{
 if(phase==='first'){
  assert.ok(!fs.existsSync(output),'Fresh explicit output required');fs.mkdirSync(data,{recursive:true});
  const dbPath=path.join(data,'nova-tasks.sqlite'),db=new Database(dbPath);await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(data,'storage')}),manifest={media:[],retained:[]};
  for(const [fixture,mimeType]of[['workbench-v1/reference-a.png','image/png'],['b2/valid-video.mp4','video/mp4']]){
   const bytes=fs.readFileSync(path.join(root,'backend/test/fixtures',fixture)),asset=store.importBuffer(bytes,{mimeType,sourceKind:'generated'}),id=randomUUID();
   db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,result_sources_json,remote_state) VALUES(?,?,?,?,?,?,?)').run(id,'remote_completed',mimeType.startsWith('video')?'video.text':'image.text','{}',new Date().toISOString(),JSON.stringify([{kind:'asset',assetId:asset.assetId}]),'completed');
   db.prepare('INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,?,?,?)').run(id,'waiting',new Date().toISOString(),new Date().toISOString());manifest.media.push(id);
  }
  for(const state of['local_queued','submission_unknown','polling_paused']){const id=randomUUID();db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,requires_continue,dispatch_started_at,upstream_task_id) VALUES(?,?,?,?,?,?,?,?)').run(id,state,'video.single_reference','{}',new Date().toISOString(),state==='local_queued'?1:0,state==='local_queued'?null:new Date().toISOString(),state==='polling_paused'?'synthetic-original-id':null);manifest.retained.push({id,state});}
  db.close();fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(data,'保留验证 sentinel.txt'),'keep-after-upgrade-and-uninstall\n');
 }else assert.ok(fs.existsSync(manifestFile),'Prior isolated test required');
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),port=await resolveBackendPort(0),debugPort=await resolveBackendPort(0),origin='http://127.0.0.1:'+port;
 server=http.createServer((req,res)=>{evidence.requests.push({method:req.method,path:req.url});res.writeHead(503);res.end('Synthetic test server: no generation permitted');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={...process.env};for(const key of Object.keys(env))if(/^NOVA_|^ELECTRON_RUN_AS_NODE$|^PORTABLE_EXECUTABLE_DIR$|^NODE_PATH$|^NODE_OPTIONS$/i.test(key))delete env[key];
 env.PATH=path.join(process.env.SystemRoot,'System32')+';'+process.env.SystemRoot;env.NOVA_DATA_DIR=data;env.NOVA_BACKEND_PORT=String(port);env.NOVA_ELECTRON_CDP_ENABLED='true';env.NOVA_ELECTRON_CDP_PORT=String(debugPort);
 evidence.childPath=env.PATH;evidence.controllerIdentity=execFileSync('whoami.exe',[],{encoding:'utf8'}).trim();evidence.tokenGroups=execFileSync('whoami.exe',['/groups'],{encoding:'utf8'});
 child=spawn(exe,[],{cwd:path.dirname(exe),env,windowsHide:true,stdio:['ignore','pipe','pipe']});evidence.pid=child.pid;child.once('exit',(code,signal)=>{exit={code,signal};});for(const stream of['stdout','stderr'])child[stream].on('data',bytes=>fs.appendFileSync(path.join(output,phase+'-'+stream+'.log'),bytes));
 const target=await until(async()=>{const list=await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();return list.find(t=>t.type==='page'&&t.url===origin+'/');});client=await connect(target.webSocketDebuggerUrl);
 const evaluate=async expression=>{const r=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await until(()=>evaluate('document.readyState==="complete"&&!document.getElementById("app-boot-loader")&&!!window.novaDesktop'));
 
 check('installed runtime and narrow renderer bridge',await evaluate('typeof require==="undefined"&&typeof process==="undefined"&&!!window.novaDesktop.exportDiagnostics'));
 const runtime=await evaluate('window.novaDesktop.getRuntimeInfo()');evidence.runtime=runtime;check('explicit profile and app version',runtime.ok&&runtime.storageMode==='override'&&runtime.version==='3.4.0');
 check('visible offline test qualification',await until(()=>evaluate('document.body.innerText.includes("本地离线测试版")&&document.body.innerText.includes("真实生成能力尚未完成验证")')));
 check('external sessionless client denied',(await fetch(origin+'/api/nova/config')).status===403);
 const read=route=>evaluate('fetch('+JSON.stringify(route)+').then(r=>r.json())');
 const put=(route,payload)=>evaluate('fetch('+JSON.stringify(route)+',{method:"PUT",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(payload))+'}).then(async r=>({status:r.status,body:await r.json()}))');
 if(phase==='first'){
  const progress=await read('/api/nova/storage/settings/onboarding');const skipped=await put('/api/nova/storage/settings/onboarding',{value:{dismissed:true,step:'completed'},expectedRevision:progress.setting?.revision??progress.revision??0});check('installed local setting saves',skipped.status===200);
  const draft=await put('/api/nova/storage/drafts/image.text',{prompt:'T16 中文路径\n"原始草稿" — offline',model:'gpt-image-2.5-flare',parameters:{},inputAssets:[],expectedRevision:0});check('installed Chinese multiline draft saves',draft.body.draft?.prompt==='T16 中文路径\n"原始草稿" — offline');
  const saved=await evaluate('window.novaDesktop.saveConnection('+JSON.stringify({baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',provider:'openai-compatible',apiKey:'t16-synthetic-only-not-a-real-key',displayName:'T16 合成离线连接'})+')');
  check('installed Windows encrypted configuration saves',saved.ok&&saved.connection.credentialState==='ready');check('save DTO has no key or credential reference',!JSON.stringify(saved).includes('t16-synthetic-only-not-a-real-key')&&!JSON.stringify(saved).includes('credentialRef'));manifest.connection=saved.connection;fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  await client.call('Page.reload');await until(()=>evaluate('!!document.querySelector(".wb-shell")'));
 }else{
  const current=await read('/api/nova/connections/current');evidence.connectionSummary=current;check('same configuration version and decryptable credential restored',current.connection?.connectionVersionId===manifest.connection.connectionVersionId&&current.connection?.credentialState==='ready');
  const draft=await read('/api/nova/storage/drafts/image.text');check('Chinese multiline draft restored',draft.draft?.prompt==='T16 中文路径\n"原始草稿" — offline');
  const onboarding=await read('/api/nova/storage/settings/onboarding');check('setup completion restored',(onboarding.setting||onboarding).value?.dismissed===true);
 }
 const tasks=await until(async()=>{const values=await Promise.all(manifest.media.map(id=>read('/api/nova/tasks/'+id)));return values.every(t=>t.status==='completed')?values:null;});evidence.outputAssets=tasks.map(t=>t.outputAssets[0]);
 check('installed bundled FFmpeg verifies synthetic PNG and H264 AAC',tasks.every(t=>t.outputAssets[0].validationState==='verified'));
 for(const item of manifest.retained){const task=await read('/api/nova/tasks/'+item.id);check(item.state+' survives without auto submission',task.status===item.state);if(item.state==='polling_paused')check('paused upstream ID preserved',task.upstreamTaskId==='synthetic-original-id');}
 const video=tasks[1].outputAssets[0],playback=await evaluate('(async()=>{const v=document.createElement("video");v.controls=true;v.muted=true;v.src='+JSON.stringify(video.previewUrl)+';document.body.append(v);await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(Error("decode"))});await v.play();await new Promise(r=>setTimeout(r,180));v.pause();await new Promise(r=>{v.onseeked=r;v.currentTime=1.2});v.volume=0.4;const result={width:v.videoWidth,height:v.videoHeight,duration:v.duration,time:v.currentTime,paused:v.paused,volume:v.volume,readyState:v.readyState};v.remove();return result})()');evidence.playback=playback;
 check('installed Chromium plays pauses seeks and changes volume',playback.width===160&&playback.height===96&&playback.duration>=1.9&&playback.duration<=2.1&&playback.time>=1.19&&playback.paused&&playback.volume===0.4&&playback.readyState>=2);
 const range=await evaluate('fetch('+JSON.stringify(video.previewUrl)+',{headers:{Range:"bytes=0-99"}}).then(async r=>({status:r.status,length:(await r.arrayBuffer()).byteLength}))');check('installed local range playback',range.status===206&&range.length===100);
 await evaluate('[...document.querySelectorAll("nav button")].find(b=>b.innerText==="设置").click()');
 check('installed settings exposes diagnostics',await until(()=>evaluate('document.body.innerText.includes("导出脱敏诊断")')));
 check('diagnostic preload exposes no path parameter',await evaluate('window.novaDesktop.exportDiagnostics.length===0'));
 if(phase==='first'){const screenshot=await client.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,'installed-settings.png'),Buffer.from(screenshot.data,'base64'));}
 check('zero synthetic provider traffic including no POST',evidence.requests.length===0);
 await client.call('Runtime.evaluate',{expression:'setTimeout(()=>window.close(),20);true'});await until(()=>exit).catch(()=>{});check('installed app clean exit',exit?.code===0);
 const db=new Database(path.join(data,'nova-tasks.sqlite'),{readonly:true}),cipher=db.prepare('SELECT ciphertext FROM credential_entries LIMIT 1').get().ciphertext;
 check('credential ciphertext and SQLite integrity',Buffer.isBuffer(cipher)&&!cipher.includes(Buffer.from('t16-synthetic-only-not-a-real-key'))&&db.pragma('quick_check',{simple:true})==='ok'&&db.pragma('foreign_key_check').length===0);db.close();
 check('out-of-install profile sentinel retained',fs.readFileSync(path.join(data,'保留验证 sentinel.txt'),'utf8')==='keep-after-upgrade-and-uninstall\n');evidence.exit=exit;evidence.status='passed';
})().catch(error=>{evidence.status='failed';evidence.error=error.stack;process.exitCode=1;}).finally(()=>{client?.close();server?.closeAllConnections();server?.close();if(child&&!exit)child.kill();evidence.finishedAt=new Date().toISOString();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,phase+'-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({phase,status:evidence.status,checks:Object.keys(evidence.checks).length,error:evidence.error}));});
