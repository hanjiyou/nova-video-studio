'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3'),WebSocket=require('ws');
const {migrateDatabase}=require('../backend/storage/migrations'),{createWorkbenchStore}=require('../backend/storage/store'),{resolveBackendPort}=require('../desktop/runtime.cjs');
const [exeArg,outputArg]=process.argv.slice(2),root=path.resolve(__dirname,'..'),executable=path.resolve(exeArg),output=path.resolve(outputArg),data=path.join(output,'data');
assert.ok(exeArg&&outputArg&&!fs.existsSync(output),'Fresh explicit output required');fs.mkdirSync(data,{recursive:true});
const report={scope:'Actual packaged Windows EXE; production media worker from persisted inline candidates; no provider network or main-process injection. Renderer decoding, play/seek and Range. System dialog/shell GUI not automated.',checks:{}},check=(name,value)=>{assert.ok(value,name);report.checks[name]=true;};
let child,exit,client;
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(exit)throw new Error('Packaged app exited');const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Packaged B2 timeout');}
async function connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});let next=0;const pending=new Map();socket.on('message',bytes=>{const message=JSON.parse(bytes),entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error('CDP failed')):entry.resolve(message.result);}});return{close:()=>socket.close(),call(method,params){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(new Error('CDP timeout')),10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}};}
(async()=>{
    const dbPath=path.join(data,'nova-tasks.sqlite'),db=new Database(dbPath);await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(data,'storage')}),ids=[];
    for(const [name,mimeType]of[['workbench-v1/reference-a.png','image/png'],['b2/valid-video.mp4','video/mp4']]){
        const asset=store.importBuffer(fs.readFileSync(path.join(root,'backend/test/fixtures',name)),{mimeType,sourceKind:'generated'}),id=randomUUID();ids.push(id);
        db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at,result_sources_json,remote_state) VALUES(?,?,?,?,?,?,?)').run(id,'remote_completed',mimeType.startsWith('video')?'video.text':'image.text','{}',new Date().toISOString(),JSON.stringify([{kind:'asset',assetId:asset.assetId}]),'completed');
        db.prepare('INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,?,?,?)').run(id,'waiting',new Date().toISOString(),new Date().toISOString());
    }
    db.close();const port=await resolveBackendPort(0),debugPort=await resolveBackendPort(0),origin='http://127.0.0.1:'+port,env={...process.env,NOVA_DATA_DIR:data,NOVA_BACKEND_PORT:String(port),NOVA_ELECTRON_CDP_ENABLED:'true',NOVA_ELECTRON_CDP_PORT:String(debugPort)};
    for(const key of['ELECTRON_RUN_AS_NODE','PORTABLE_EXECUTABLE_DIR','NOVA_CDP_ENABLED','NOVA_CDP_LAUNCH_ENABLED','NOVA_AGENT_ENABLED'])delete env[key];
    child=spawn(executable,[],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.once('exit',(code,signal)=>{exit={code,signal};});for(const stream of['stdout','stderr'])child[stream].on('data',bytes=>fs.appendFileSync(path.join(output,stream+'.log'),bytes));
    const target=await until(async()=>{try{return(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(item=>item.type==='page'&&item.url===origin+'/');}catch{return null;}});client=await connect(target.webSocketDebuggerUrl);
    const evaluate=async expression=>{const result=await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    await until(()=>evaluate('document.readyState==="complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop?.getOutputDirectory'));
    const tasks=await until(async()=>{const value=await evaluate('Promise.all('+JSON.stringify(ids)+'.map(id=>fetch("/api/nova/tasks/"+id).then(r=>r.json())))');return value.every(task=>task.status==='completed')?value:null;});
    check('packaged production decoder verifies PNG and all H264/AAC frames',tasks.every(task=>task.outputAssets[0].validationState==='verified'));report.assets=tasks.map(task=>task.outputAssets[0]);
    const video=tasks[1].outputAssets[0],playback=await evaluate('(async()=>{const v=document.createElement("video");v.muted=true;v.src='+JSON.stringify(video.previewUrl)+';document.body.append(v);await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(Error("decode"))});await v.play();await new Promise(resolve=>setTimeout(resolve,150));v.pause();await new Promise(resolve=>{v.onseeked=resolve;v.currentTime=1.2});const result={width:v.videoWidth,height:v.videoHeight,time:v.currentTime,readyState:v.readyState};v.remove();return result})()');
    check('actual packaged Chromium plays and seeks local video',playback.width===160&&playback.height===96&&playback.time>=1.19&&playback.readyState>=2);report.playback=playback;
    const ranges=await evaluate('Promise.all(["bytes=0-99","bytes=-64","bytes=999999999-"].map(range=>fetch('+JSON.stringify(video.previewUrl)+',{headers:{Range:range}}).then(async r=>({status:r.status,length:(await r.arrayBuffer()).byteLength,range:r.headers.get("content-range")}))))');
    check('packaged HTTP supports range seek and unsatisfiable response',ranges[0].status===206&&ranges[0].length===100&&ranges[1].status===206&&ranges[1].length===64&&ranges[2].status===416);report.ranges=ranges;
    check('packaged IPC rejects renderer path',(await evaluate('window.novaDesktop.saveAssetCopy("../arbitrary")')).code==='INVALID_ASSET_ID');
    check('packaged output directory is opaque',(await evaluate('window.novaDesktop.getOutputDirectory()')).ok);
    check('unauthorized local media read rejected',(await fetch(origin+video.previewUrl)).status===403);
    check('packaged renderer has no Node access',await evaluate('typeof require==="undefined" && typeof process==="undefined"'));
    await client.call('Runtime.evaluate',{expression:'setTimeout(()=>window.close(),20); true'});await until(()=>exit).catch(()=>{});check('packaged process exits cleanly',exit?.code===0);
    const after=new Database(dbPath,{readonly:true});check('SQLite integrity and foreign keys preserved',after.pragma('quick_check',{simple:true})==='ok'&&after.pragma('foreign_key_check').length===0);after.close();
    report.status='passed';
})().catch(error=>{report.status='failed';report.error=error.stack;process.exitCode=1;}).finally(()=>{client?.close();if(child&&!exit)child.kill();fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));});
