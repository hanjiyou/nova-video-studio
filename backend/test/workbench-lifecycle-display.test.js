'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {migrateDatabase}=require('../storage/migrations'),{createWorkbenchStore}=require('../storage/store');
const {createTaskService}=require('../tasks/service'),{createStorageHttp}=require('../storage/http');
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-i05-')),dbPath=path.join(directory,'tasks.sqlite');let db=new Database(dbPath);await migrateDatabase({db,dbPath});let store=createWorkbenchStore({db,rootDirectory:path.join(directory,'storage')});
 t.after(()=>{db.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:3});});
 const snapshot=(mode)=>({contractVersion:1,localRequestId:randomUUID(),mode,model:'synthetic-only',prompt:'synthetic task',parameters:{},inputAssets:[],adapterId:'synthetic',adapterVersion:'1'});
 const task=(mode='image.text',status='completed')=>{const id=randomUUID();db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id,status,mode,'{}',new Date().toISOString());store.setTaskSnapshot(id,snapshot(mode));return id;};
 return {get db(){return db;},get store(){return store;},task,reopen(){db.close();db=new Database(dbPath);store=createWorkbenchStore({db,rootDirectory:path.join(directory,'storage')});}};
}
for(const mode of ['image.text','video.text'])test('I05 '+mode+' removes both task displays durably while keeping library, outputs, aliases and dedup identity',async t=>{
 const f=await fixture(t),id=f.task(mode),input=JSON.parse(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json),png=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png'));
 const asset=f.store.importBuffer(png,{mimeType:'image/png',sourceKind:'generated',validation:{width:2,height:2}});f.store.bindTaskAssets(id,[{assetId:asset.assetId,position:0,role:'reference'}],'output');const other=f.task();f.store.bindTaskAssets(other,[{assetId:asset.assetId,position:0,role:'reference'}],'output');
 const before=f.store.events(id);assert.deepEqual(f.store.removeTaskDisplay(id),{removed:true,worksRetained:true});assert.equal(f.store.removeTaskDisplay(id).removed,true);
 for(const query of [{},{scope:'workbench'}])assert.ok(!f.store.listTasks(query).items.some(task=>task.id===id));
 assert.ok(f.store.listTasks({scope:'library'}).items.some(task=>task.id===id));assert.equal(f.store.getTask(id).removedFromWorkbench,true);assert.deepEqual(f.store.readAsset(asset.assetId).bytes,png);assert.deepEqual(f.store.events(id),before);
 f.reopen();assert.ok(!f.store.listTasks().items.some(task=>task.id===id));assert.ok(f.store.listTasks({scope:'library'}).items.some(task=>task.id===id));assert.deepEqual(f.store.readAsset(asset.assetId).bytes,png);
 let network=0;const service=createTaskService({db:f.db,store:f.store,connections:{getAuth(){network++;throw Error('no auth needed for duplicate');}},resolveAdapter(){network++;throw Error('no network');}});
 assert.equal(service.enqueue({snapshot:input,mode,request:{}}),id);assert.equal(network,0);await service.close();assert.equal(f.store.getTask(other).outputAssets[0].availability,'available');
});
test('I05 legacy library hiding keeps its prior meaning and does not restore previously hidden records',async t=>{
 const f=await fixture(t),hidden=f.task(),visible=f.task();f.store.removeHistory(hidden,{deleteOutputs:false});f.store.removeTaskDisplay(visible);
 assert.equal(f.store.listTasks().total,0);assert.deepEqual(f.store.listTasks({scope:'library'}).items.map(task=>task.id),[visible]);assert.equal(f.db.prepare('SELECT count(*) n FROM workbench_hidden_tasks').get().n,1);assert.throws(()=>f.store.listTasks({scope:'arbitrary'}),{code:'INVALID_HISTORY_FILTER'});
});
for(const status of ['local_queued','submitting','polling_paused','downloading'])test('I05 refuses active '+status+' without hiding either task or works',async t=>{
 const f=await fixture(t),id=f.task('image.text',status);for(const remove of [()=>f.store.removeTaskDisplay(id),()=>f.store.removeHistory(id,{deleteOutputs:false})])assert.throws(remove,{code:'TASK_ACTIVE'});
 assert.equal(f.store.listTasks().total,1);assert.equal(f.store.listTasks({scope:'library'}).total,1);assert.equal(f.db.prepare('SELECT count(*) n FROM workbench_removed_tasks').get().n,0);
});
test('I05 cancelled/timeout/download failure can be removed, but active independent download requires cancellation confirmation',async t=>{
 const f=await fixture(t);for(const status of ['local_cancelled','timed_out','download_failed'])assert.equal(f.store.removeTaskDisplay(f.task('video.text',status)).removed,true);
 const id=f.task('image.text','download_failed'),attempt=randomUUID(),started=new Date().toISOString();f.db.prepare('INSERT INTO task_download_attempts(id,task_id,started_at,deadline_at,timeout_seconds) VALUES(?,?,?,?,?)').run(attempt,id,started,new Date(Date.now()+120000).toISOString(),120);
 assert.equal(f.store.getTask(id).localOutcome,'failed');assert.equal(f.store.getTask(id).downloadAttempt.active,true);assert.throws(()=>f.store.removeTaskDisplay(id),{code:'TASK_ACTIVE'});
 f.db.prepare("UPDATE task_download_attempts SET outcome='cancelled',finished_at=? WHERE id=?").run(started,attempt);assert.equal(f.store.removeTaskDisplay(id).removed,true);
});
test('I05 HTTP action validates an empty body and keeps library DELETE distinct',async t=>{
 const f=await fixture(t),id=f.task();let input={},response;const handle=createStorageHttp({getStore:()=>f.store,readRawBody:async()=>Buffer.from(JSON.stringify(input)),sendJson:(_res,status,value)=>{response={status,value};}}),request=async(method,route)=>{const url=new URL(route,'http://local.invalid');await handle({method},{},url.pathname,url.searchParams);return response;};
 input={deleteOutputs:true};assert.equal((await request('POST','/api/nova/storage/tasks/'+id+'/remove')).status,400);assert.equal(f.store.listTasks().total,1);
 input={};assert.deepEqual((await request('POST','/api/nova/storage/tasks/'+id+'/remove')).value,{removed:true,worksRetained:true});assert.equal((await request('GET','/api/nova/storage/tasks?scope=workbench')).value.total,0);assert.equal((await request('GET','/api/nova/storage/tasks?scope=library')).value.total,1);
 input={deleteOutputs:false};assert.equal((await request('DELETE','/api/nova/storage/tasks/'+id)).value.removed,true);assert.equal((await request('GET','/api/nova/storage/tasks?scope=library')).value.total,0);assert.equal((await request('GET','/api/nova/storage/tasks/'+id)).value.task.id,id);
});
