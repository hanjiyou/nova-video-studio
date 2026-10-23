'use strict';
// Real packaged desktop smoke using explicit loopback-only CDP. No provider or credential calls.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const WebSocket=require('ws');
const Database=require('better-sqlite3');
const [executableArg,mode='override',outputArg]=process.argv.slice(2);
assert.ok(executableArg && ['system','override','portable'].includes(mode));
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
 if(mode==='system'){const created=candidates.filter(candidate=>fs.existsSync(path.join(candidate,'nova-tasks.sqlite')));check('database under fresh system userData',created.length===1);evidence.dataDirectory=created[0];check('no executable adjacent data directory',!fs.existsSync(path.join(path.dirname(executable),'data')))}else{evidence.dataDirectory=data;check('explicit data policy honored',fs.existsSync(path.join(data,'nova-tasks.sqlite')))}
 await client.call('Browser.close').catch(()=>{});
 await new Promise((resolve,reject)=>{if(exit)return resolve();const timer=setTimeout(()=>reject(new Error('Desktop did not quit')),8000);child.once('exit',()=>{clearTimeout(timer);resolve()})});
 check('clean desktop exit',exit.code===0);evidence.exit=exit;
 const db=new Database(path.join(evidence.dataDirectory,'nova-tasks.sqlite'),{readonly:true,fileMustExist:true});evidence.databaseQuickCheck=db.pragma('quick_check');db.close();assert.deepEqual(evidence.databaseQuickCheck,[{quick_check:'ok'}]);
 evidence.status='passed';
})().catch(error=>{evidence.status='failed';evidence.error=error.stack;process.exitCode=1}).finally(()=>{client?.close();if(child && !exit)child.kill();evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2))});
