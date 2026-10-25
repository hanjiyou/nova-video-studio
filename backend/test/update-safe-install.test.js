'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {createUpdateGate,strictCloseDatabase}=require('../storage/update-gate');
const {migrateDatabase}=require('../storage/migrations');
const {createWorkbenchStore}=require('../storage/store');
const {createTaskService}=require('../tasks/service');
const {start}=require('./support/desktop-http-runtime.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error('Fixture did not settle');}
function temporary(){return fs.mkdtempSync(path.join(os.tmpdir(),'nova-update-'));}
function removeTemporary(dir){const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
test('activity barrier admits only save/read during preparation and refuses commit until every operation settles',async()=>{
 const g=createUpdateGate(),leave=g.enter();assert.throws(()=>g.begin(),{code:'UPDATE_BUSY'});leave();g.begin();assert.throws(()=>g.enter(),{code:'UPDATE_PREPARING'});const flush=g.enter({flush:true});assert.throws(()=>g.commit(),{code:'UPDATE_BUSY'});flush();g.commit();assert.throws(()=>g.enter({read:true}),{code:'UPDATE_PREPARING'});g.release();assert.equal(g.phase,'open');
});
test('strict SQLite checkpoint/close refuses busy/failure/false proof',()=>{
 for(const db of [{open:false},{open:true,pragma:()=>[{busy:1}],close:()=>assert.fail()},{open:true,pragma:()=>{throw Error('disk');},close:()=>assert.fail()},{open:true,pragma:()=>[{busy:0}],close:()=>{throw Error('busy');}},{open:true,pragma:()=>[{busy:0}],close(){}}])assert.throws(()=>strictCloseDatabase(db));
});
test('real HTTP active body blocks prepare; controlled draft PUT works, generation/import actions are locked, release resumes',async t=>{
 const dir=temporary(),runtime=await start(dir);t.after(async()=>{await runtime.stop();removeTemporary(dir);});
 const url=new URL(runtime.origin),request=http.request({hostname:'127.0.0.1',port:url.port,path:'/api/nova/storage/drafts/image.text',method:'PUT',headers:{...runtime.headers,'content-type':'application/json','content-length':10000}});request.on('error',()=>{});request.write('{');await new Promise(r=>setTimeout(r,50));
 await assert.rejects(runtime.prepareUpdate(),{code:'UPDATE_BUSY'});request.destroy();await new Promise(r=>setTimeout(r,50));
 await runtime.prepareUpdate();const put=await runtime.request('/api/nova/storage/drafts/image.text',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'flush中文',model:'synthetic',parameters:{},inputAssets:[],expectedRevision:0})});assert.equal(put.status,200);
 for(const route of ['/api/nova/workbench/tasks','/api/nova/assets/import','/api/nova/storage/submissions'])assert.equal((await runtime.request(route,{method:'POST',body:'{}'})).status,503);
 await runtime.releaseUpdate();assert.equal((await runtime.request('/api/nova/storage/drafts/image.text')).status,200);
 await runtime.prepareUpdate();assert.deepEqual(await runtime.closeUpdate(),{databaseClosed:true,checkpointComplete:true});const disk=new Database(path.join(dir,'tasks.sqlite'));try{assert.equal(disk.prepare("SELECT prompt FROM drafts WHERE mode='image.text'").get().prompt,'flush中文');}finally{disk.close();}
});
for(const attach of [false,true])test('live POST blocks prepare and '+(attach?'paused':'unknown')+' records survive strict close without another POST',async t=>{
 const dir=temporary(),dbPath=path.join(dir,'tasks.sqlite');let db=new Database(dbPath);await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(dir,'storage')}),version=randomUUID(),connection=randomUUID();
 db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connection,'synthetic','2026','2026');db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(version,connection,'https://fixture.invalid/v1','openai-compatible','2026');
 store.putSetting('taskExecution',{value:{imageConcurrency:1,videoConcurrency:1,imageTimeoutSeconds:120,videoTimeoutSeconds:300},expectedRevision:0});
 let posts=0,finish;const adapter={id:'synthetic',version:'1',submit:async()=>{posts++;await new Promise(r=>{finish=r;});throw Error('ambiguous');},poll:async()=>assert.fail('Paused tasks must not query')};const options={db,store,connections:{getAuth:()=>({apiKey:'synthetic-only'})},resolveAdapter:()=>adapter};let service=createTaskService(options);
 t.after(async()=>{if(finish)finish();await service.close();if(db.open)db.close();removeTemporary(dir);});const input={contractVersion:1,localRequestId:randomUUID(),connectionVersionId:version,mode:'video.text',model:'synthetic',prompt:'完整快照',parameters:{seconds:6},inputAssets:[],adapterId:'synthetic',adapterVersion:'1'};const id=service.enqueue({snapshot:input,mode:'video.text',request:{}});await until(()=>posts===1);
 assert.throws(()=>service.prepareUpdate(),{code:'UPDATE_BUSY'});assert.equal(posts,1);finish();await until(()=>service.get(id).status==='submission_unknown');const queued=service.enqueue({snapshot:{...input,localRequestId:randomUUID()},mode:'video.text',request:{}});await tick();
 const before=db.prepare('SELECT input_snapshot_json,connection_version_id,dispatch_started_at FROM tasks WHERE id=?').get(id);if(attach)service.action(id,'attach-upstream-id',{upstreamTaskId:'opaque/original?task'});const intent=randomUUID();db.prepare('INSERT INTO workbench_submission_intents VALUES(?,?,?,?)').run(intent,'{}','2026',null);assert.throws(()=>service.prepareUpdate(),{code:'UPDATE_SUBMISSION_PENDING'});db.prepare('DELETE FROM workbench_submission_intents WHERE local_request_id=?').run(intent);assert.equal(service.prepareUpdate().remoteMayContinue,true);assert.throws(()=>service.enqueue({snapshot:input,mode:'video.text',request:{}}),{code:'SERVER_NOT_ACCEPTING_TASKS'});service.persistUpdatePause();
 assert.deepEqual(strictCloseDatabase(db),{databaseClosed:true,checkpointComplete:true});service.finishUpdate();db=new Database(dbPath);const reopenedStore=createWorkbenchStore({db,rootDirectory:path.join(dir,'storage')});service=createTaskService({...options,db,store:reopenedStore});service.recover();await tick();
 assert.equal(service.get(id).status,attach?'polling_paused':'failed');assert.equal(service.get(id).upstreamTaskId,attach?'opaque/original?task':null);assert.equal(service.get(id).generationReserved,attach);assert.equal(service.get(id).remoteOutcome,'unknown');assert.equal(service.get(queued).requiresContinue,true);assert.equal(posts,1);assert.deepEqual(db.prepare('SELECT input_snapshot_json,connection_version_id,dispatch_started_at FROM tasks WHERE id=?').get(id),before);
});
test('active media save and only-memory signed result both refuse install without dropping retry data',async t=>{
 const dir=temporary(),dbPath=path.join(dir,'tasks.sqlite'),db=new Database(dbPath);await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(dir,'storage')}),version=randomUUID(),connection=randomUUID();
 db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connection,'synthetic','2026','2026');db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(version,connection,'https://fixture.invalid/v1','openai-compatible','2026');
 let finish,downloads=0,posts=0,signal;const seen=[];
 const service=createTaskService({db,store,connections:{getAuth:()=>({apiKey:'synthetic-only'})},resolveAdapter:()=>({id:'synthetic',version:'1',submit:async()=>{posts++;return {resultSources:[{kind:'url',url:'https://fixture.invalid/output.png?signature=synthetic',mediaKind:'image'}]};}}),downloadWorker:async(_task,sources,options)=>{downloads++;seen.push(sources);signal=options.signal;await new Promise(r=>{finish=r;});throw {code:'DOWNLOAD_FAILED'};}});
 t.after(async()=>{if(finish)finish();await service.close();db.close();removeTemporary(dir);});
 const input={contractVersion:1,localRequestId:randomUUID(),connectionVersionId:version,mode:'image.text',model:'synthetic',prompt:'save result',parameters:{},inputAssets:[],adapterId:'synthetic',adapterVersion:'1'};
 const id=service.enqueue({snapshot:input,mode:'image.text',request:{}});await until(()=>downloads===1);assert.throws(()=>service.prepareUpdate(),{code:'UPDATE_BUSY'});assert.equal(signal.aborted,false);finish();await until(()=>service.get(id).status==='download_failed');await tick();
 assert.throws(()=>service.prepareUpdate(),{code:'UPDATE_UNSAVED_RESULT'});assert.equal(service.get(id).status,'download_failed');service.action(id,'retry-download');await until(()=>downloads===2);assert.equal(posts,1);assert.equal(seen[1][0].url,'https://fixture.invalid/output.png?signature=synthetic');finish();await until(()=>service.get(id).status==='download_failed');
});
