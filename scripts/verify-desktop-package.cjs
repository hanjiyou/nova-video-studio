'use strict';
// Real packaged desktop smoke using explicit loopback-only CDP and synthetic credentials.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const http=require('node:http');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const Database=require('better-sqlite3');
const [executableArg,mode='override',outputArg]=process.argv.slice(2);
assert.ok(executableArg && ['system','override','portable'].includes(mode));
if(process.argv.includes('--credential-errors'))assert.ok(process.argv.includes('--connections'),'Credential-error probe requires --connections');
if(process.argv.includes('--connections'))assert.equal(mode,'override','T04 connection probe requires a fresh explicit profile');
const executable=path.resolve(executableArg);
const output=path.resolve(outputArg || path.join(__dirname,'../temp/t02-package-'+mode+'-'+Date.now()));
fs.mkdirSync(output,{recursive:true});
const candidates=['nova-image','Nova Image Studio'].map(name=>path.join(process.env.APPDATA,name));
if(mode==='system') for(const candidate of candidates) assert.ok(!fs.existsSync(candidate),'Refusing to use an existing system profile');
const data=mode==='override'?path.join(output,'data'):mode==='portable'?path.join(output,'portable','data'):null;
if(data) assert.ok(!fs.existsSync(data),'Fresh profile required');
const evidence={startedAt:new Date().toISOString(),executable,mode,providerRequests:'none',checks:{}};
let child;
let exit;
let client;
let modelsServer;
const check=(name,value)=>{assert.ok(value,name);evidence.checks[name]=true};
const free=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
async function until(fn,timeout=30000){const end=Date.now()+timeout;let last;while(Date.now()<end){if(exit)throw new Error('Desktop exited: '+JSON.stringify(exit));try{const value=await fn();if(value)return value}catch(error){last=error}await new Promise(resolve=>setTimeout(resolve,100))}throw last || new Error('Timed out')}
async function connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});let id=0;const pending=new Map();socket.on('message',raw=>{const result=JSON.parse(raw);const entry=pending.get(result.id);if(!entry)return;pending.delete(result.id);clearTimeout(entry.timer);result.error?entry.reject(new Error(JSON.stringify(result.error))):entry.resolve(result.result)});return{close:()=>socket.close(),call(method,params={}){return new Promise((resolve,reject)=>{const next=++id;const timer=setTimeout(()=>{pending.delete(next);reject(new Error('CDP timeout'))},5000);pending.set(next,{resolve,reject,timer});socket.send(JSON.stringify({id:next,method,params}))})}}}
(async()=>{
 const port=await free();const debugPort=await free();const origin='http://127.0.0.1:'+port;
 const env={...process.env,NODE_ENV:'production',NOVA_BACKEND_PORT:String(port),NOVA_ELECTRON_CDP_ENABLED:'true',NOVA_ELECTRON_CDP_PORT:String(debugPort)};
 for(const key of ['ELECTRON_RUN_AS_NODE','NOVA_DATA_DIR','PORTABLE_EXECUTABLE_DIR','NOVA_CDP_ENABLED','NOVA_CDP_LAUNCH_ENABLED','NOVA_AGENT_ENABLED'])delete env[key];
 if(mode==='override')env.NOVA_DATA_DIR=data;
 if(mode==='portable')env.PORTABLE_EXECUTABLE_DIR=path.dirname(data);
 child=spawn(executable,[],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>fs.appendFileSync(path.join(output,'stdout.log'),chunk));child.stderr.on('data',chunk=>fs.appendFileSync(path.join(output,'stderr.log'),chunk));child.once('exit',(code,signal)=>{exit={code,signal}});
 const target=await until(async()=>{const response=await fetch('http://127.0.0.1:'+debugPort+'/json/list');return(await response.json()).find(item=>item.type==='page' && item.url===origin+'/')});
 client=await connect(target.webSocketDebuggerUrl);
 const evaluate=async expression=>{const result=await client.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value};
 await until(()=>evaluate('document.readyState === "complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop'));
 const runtime=await evaluate('window.novaDesktop.getRuntimeInfo()');evidence.runtime=runtime;
 check('expected storage mode',runtime.ok && runtime.storageMode===mode);
 check('desktop defaults disabled',await evaluate('window.novaDesktop.features.agent===false && window.novaDesktop.features.browserAutomation===false'));
 check('main renderer HTTP authorized',await evaluate('fetch("/api/nova/config").then(r=>r.status===200)'));
 check('unauthenticated API rejected',(await fetch(origin+'/api/nova/config')).status===403);
 check('main renderer WS authorized',await evaluate('new Promise(resolve=>{const ws=new WebSocket(location.origin.replace("http:","ws:")+"/api/nova/ws");const timer=setTimeout(()=>{ws.close();resolve(false)},3000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)}})'));
 check('desktop PWA not registered',await evaluate('navigator.serviceWorker.getRegistrations().then(r=>r.length===0)'));
 check('Node globals unavailable',await evaluate('typeof process === "undefined" && typeof require === "undefined"'));
 if(process.argv.includes('--storage')) {
   const bytes=[...fs.readFileSync(path.join(__dirname,'../backend/test/fixtures/workbench-v1/reference-a.png'))];
   const imported=await evaluate('fetch("/api/nova/assets/import",{method:"POST",headers:{"content-type":"image/png"},body:new Uint8Array('+JSON.stringify(bytes)+')}).then(r=>r.json())');
   check('packaged managed asset import',Boolean(imported.asset?.assetId) && imported.asset.validationState==='unverified');
   const dto={prompt:'打包后的中文\n"原文"',model:'fixture',parameters:{duration:6},inputAssets:[{assetId:imported.asset.assetId,position:0,role:'reference'}],expectedRevision:0};
   const saved=await evaluate('fetch("/api/nova/storage/drafts/video.single_reference",{method:"PUT",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(dto))+'}).then(r=>r.json())');
   check('packaged persistent draft',saved.draft?.prompt===dto.prompt && saved.draft?.inputAssets[0].assetId===imported.asset.assetId);
   const hash=await evaluate('fetch('+JSON.stringify(imported.asset.previewUrl)+').then(r=>r.arrayBuffer()).then(b=>crypto.subtle.digest("SHA-256",b)).then(b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""))');
   check('packaged managed asset bytes match digest',hash===imported.asset.sha256);
   evidence.storageAssetId=imported.asset.assetId;
 }


 if(process.argv.includes('--connections')) {
   evidence.providerRequests=process.argv.includes('--credential-errors')?'loopback GET /v1/models and two synthetic failing image POSTs only; no external provider requests':'read-only loopback GET /v1/models only; no external provider requests';
   const key='t04-pack-A9';const requests=[];const encodeBytes=value=>[...Buffer.from(value,'utf8')].map(byte=>'%'+byte.toString(16).padStart(2,'0').toUpperCase()).join('');
   const secretForms=[key,encodeBytes(key),encodeBytes(encodeBytes(key))];const hasSecret=value=>secretForms.some(secret=>JSON.stringify(value).includes(secret));
   modelsServer=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,authorized:req.headers.authorization==='Bearer '+key});if(req.method==='POST'){const depth=requests.filter(item=>item.method==='POST').length;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic failure: bad=%ZZ%FF '+secretForms[depth]}}));return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'gpt-image-2.5-flare'},{id:'grok-imagine-video-1.5-6s'}]}));});
   await new Promise(resolve=>modelsServer.listen(0,'127.0.0.1',resolve));
   const saved=await evaluate('window.novaDesktop.saveConnection('+JSON.stringify({baseUrl:'http://127.0.0.1:'+modelsServer.address().port+'/v1',provider:'openai-compatible',apiKey:key})+')');
   check('packaged OS-encrypted connection save',saved.ok && saved.connection.credentialState==='ready');
   check('packaged IPC summary has no credential',!JSON.stringify(saved).includes(key) && !JSON.stringify(saved).includes('credentialRef'));
   const connection=saved.connection;
   const checked=await evaluate('fetch('+JSON.stringify('/api/nova/connections/'+connection.connectionId+'/check')+',{method:"POST",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify({connectionVersionId:connection.connectionVersionId}))+'}).then(r=>r.json())');
   check('packaged read-only model check',checked.connection.validationState==='verified' && requests.length===1 && requests[0].method==='GET' && requests[0].path==='/v1/models' && requests[0].authorized);
   check('packaged visibility does not upgrade capabilities',checked.capabilities.every(cap=>cap.evidenceLevel==='unverified'));
   const inspection=new Database(path.join(data,'nova-tasks.sqlite'),{readonly:true});const cipher=inspection.prepare('SELECT ciphertext FROM credential_entries').get().ciphertext;inspection.close();
   check('packaged database contains ciphertext only',Buffer.isBuffer(cipher) && !cipher.includes(Buffer.from(key)));
   if(process.argv.includes('--credential-errors')) {
     evidence.credentialErrorCases=[];
     for(const depth of [1,2]) {
       const taskPayload={connectionVersionId:connection.connectionVersionId,mode:'text-to-image',model:'gpt-image-2',prompt:'T04 synthetic credential echo',parallelCount:1,outputSize:'auto',aspectRatio:'auto',images:[]};
       const result=await evaluate('(async()=>{const ws=new WebSocket(location.origin.replace("http:","ws:")+"/api/nova/ws");await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});const response=await fetch("/api/nova/tasks",{method:"POST",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(taskPayload))+'});if(response.status!==202)throw Error("Synthetic task rejected");const created=await response.json();const event=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("No terminal WS message")),3000);ws.onmessage=message=>{const event=JSON.parse(message.data);if(event.type==="task" && event.task.id===created.taskId && event.task.status==="failed"){clearTimeout(timer);resolve(event)}};ws.send(JSON.stringify({type:"subscribeTasks",taskIds:[created.taskId]}))});ws.close();return {task:await (await fetch("/api/nova/tasks/"+created.taskId)).json(),event,history:await (await fetch("/api/nova/storage/tasks")).json(),events:await (await fetch("/api/nova/storage/tasks/"+created.taskId+"/events")).json()}})()');
       check('packaged encoded error depth '+depth+' HTTP safe',result.task.status==='failed' && result.task.error.includes('连接凭据') && !hasSecret(result.task));
       check('packaged encoded error depth '+depth+' WS safe',result.event.task.error.includes('连接凭据') && !hasSecret(result.event));
       check('packaged encoded error depth '+depth+' history safe',!hasSecret({history:result.history,events:result.events}));
       const inspection=new Database(path.join(data,'nova-tasks.sqlite'),{readonly:true});
       const persisted={task:inspection.prepare('SELECT error FROM tasks WHERE id=?').get(result.task.id),items:inspection.prepare('SELECT error FROM task_items WHERE task_id=?').all(result.task.id),events:inspection.prepare('SELECT payload_json FROM task_events WHERE task_id=?').all(result.task.id)};inspection.close();
       check('packaged encoded error depth '+depth+' SQLite safe',persisted.task.error.includes('连接凭据') && persisted.items.length===1 && persisted.items[0].error.includes('连接凭据') && !hasSecret(persisted));
       evidence.credentialErrorCases.push({depth,malformedPercentPrefix:true,taskId:result.task.id,status:'passed'});
     }
     check('packaged exactly two synthetic image POSTs',requests.filter(item=>item.method==='POST').length===2 && requests.filter(item=>item.method==='POST').every(item=>item.path==='/v1/images/generations' && item.authorized));
   }
   if(process.argv.includes('--b1')) {
     const plugins=await evaluate('fetch("/api/nova/plugins").then(r=>r.json())');
     check('packaged B1 plugin includes exact Grok models',JSON.stringify(plugins.plugins.find(item=>item.id==='opensosen-video')?.models.map(item=>item.id))===JSON.stringify(['grok-imagine-video-6s','grok-imagine-video-1.5-6s']));
     for(const [mode,model,parameters]of[['image.text','gpt-image-2.5-flare',{}],['video.text','grok-imagine-video-1.5-6s',{seconds:6,size:'1280x720'}]]) {
       const body={localRequestId:require('node:crypto').randomUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:checked.capabilities.find(item=>item.mode===mode&&item.model===model).capabilityVersionId,mode,model,prompt:'打包后的B1能力闸门',parameters,inputAssets:[]};
       const response=await evaluate('fetch("/api/nova/workbench/tasks",{method:"POST",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(body))+'}).then(async r=>({status:r.status,body:await r.json()}))');
       check('packaged canonical '+mode+' remains unverified',response.status===400&&response.body.code==='CAPABILITY_UNVERIFIED');
     }
     const legacy={localRequestId:require('node:crypto').randomUUID(),connectionVersionId:connection.connectionVersionId,mode:'text-to-image',model:'gpt-image-2.5-flare',prompt:'合成边界',parallelCount:1,images:[]};
     const blocked=await evaluate('fetch("/api/nova/tasks",{method:"POST",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(legacy))+'}).then(async r=>({status:r.status,body:await r.json()}))');
     check('packaged flare cannot bypass new protocol boundary',blocked.status===400&&blocked.body.code==='WORKBENCH_INPUT_REQUIRED');
     check('packaged B1 evidence gates send no provider POST',requests.length===1&&requests[0].method==='GET');
   }
   const cleared=await evaluate('window.novaDesktop.clearConnectionCredential('+JSON.stringify({connectionId:connection.connectionId,expectedVersionId:connection.connectionVersionId})+')');
   check('packaged actual IPC clears credentials',cleared.ok && !cleared.connection.hasCredential);
   evidence.connectionChecks=requests;
 }

 if(mode==='system'){const created=candidates.filter(candidate=>fs.existsSync(path.join(candidate,'nova-tasks.sqlite')));check('database under fresh system userData',created.length===1);evidence.dataDirectory=created[0];check('no executable adjacent data directory',!fs.existsSync(path.join(path.dirname(executable),'data')))}else{evidence.dataDirectory=data;check('explicit data policy honored',fs.existsSync(path.join(data,'nova-tasks.sqlite')))}
 await client.call('Browser.close').catch(()=>{});
 await new Promise((resolve,reject)=>{if(exit)return resolve();const timer=setTimeout(()=>reject(new Error('Desktop did not quit')),8000);child.once('exit',()=>{clearTimeout(timer);resolve()})});
 check('clean desktop exit',exit.code===0);evidence.exit=exit;
 if(process.argv.includes('--credential-errors')) {const logs=['stdout.log','stderr.log'].filter(name=>fs.existsSync(path.join(output,name))).map(name=>fs.readFileSync(path.join(output,name),'utf8')).join('\n');const key='t04-pack-A9',encoded=[...Buffer.from(key)].map(byte=>'%'+byte.toString(16).padStart(2,'0').toUpperCase()).join('');const twice=[...Buffer.from(encoded)].map(byte=>'%'+byte.toString(16).padStart(2,'0').toUpperCase()).join('');check('packaged encoded errors absent from process logs',[key,encoded,twice].every(secret=>!logs.includes(secret)));}
 const db=new Database(path.join(evidence.dataDirectory,'nova-tasks.sqlite'),{readonly:true,fileMustExist:true});evidence.databaseQuickCheck=db.pragma('quick_check');db.close();assert.deepEqual(evidence.databaseQuickCheck,[{quick_check:'ok'}]);
 evidence.status='passed';
})().catch(error=>{evidence.status='failed';evidence.error=error.stack;process.exitCode=1}).finally(()=>{client?.close();modelsServer?.closeAllConnections();modelsServer?.close();if(child && !exit)child.kill();evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2))});
