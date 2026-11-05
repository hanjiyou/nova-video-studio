'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {migrateDatabase,MIGRATIONS}=require('../storage/migrations');
const {createWorkbenchStore}=require('../storage/store');
const {DEFAULT_GROUP}=require('../storage/groups');
const {snapshotFor}=require('../tasks/workbench-input');
const {createTaskService}=require('../tasks/service');
const {seedCapabilities,OPENSOSEN_URL}=require('../connections/capabilities');
const {createStorageHttp}=require('../storage/http');
const {start}=require('./support/desktop-http-runtime.cjs');
const model='gpt-image-2.5-flare';
function clean(directory){assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});}
async function rig(t,old=false){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-work-name-')),dbPath=path.join(directory,'tasks.sqlite'),db=new Database(dbPath),root=path.join(directory,'storage');
 t.after(()=>{if(db.open)db.close();clean(directory);});
 await migrateDatabase({db,dbPath,...(old?{migrations:MIGRATIONS.slice(0,13)}:{})});
 return{directory,dbPath,db,root,get store(){return createWorkbenchStore({db,rootDirectory:root});}};
}
function row(f,{prompt='完整提示词',workName,legacy=false,createdAt='2026-11-05T01:02:03.000Z',model:chosen=model}={}){
 const id=randomUUID(),snapshot={contractVersion:1,localRequestId:randomUUID(),mode:'image.text',model:chosen,prompt,parameters:{},inputAssets:[],...(workName===undefined?{}:{workName})};
 f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id,'completed',legacy?'text-to-image':'image.text',JSON.stringify(legacy?{model:chosen,prompt}:{}),createdAt);
 if(!legacy)f.store.setTaskSnapshot(id,snapshot);
 return{id,snapshot};
}
const draft=(extra={})=>({prompt:'保留提示词',model:'synthetic',parameters:{},inputAssets:[],...extra});

test('N01 migration14 appends names without changing old snapshot, old draft or migration checksums',async t=>{
 const f=await rig(t,true),oldId=randomUUID(),snapshot=JSON.stringify({contractVersion:1,mode:'image.text',model,prompt:'旧记录',inputAssets:[]});
 f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,input_snapshot_json,created_at) VALUES(?,?,?,?,?,?)').run(oldId,'failed','image.text','{}',snapshot,'2026-01-01');
 f.db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?,?)').run('image.text','旧草稿',model,'{}',7,'2026-01-01');
 const before=f.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
 assert.deepEqual((await migrateDatabase({db:f.db,dbPath:f.dbPath})).applied,[14]);
 assert.deepEqual(f.db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<14 ORDER BY version').all(),before);
 assert.equal(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(oldId).input_snapshot_json,snapshot);
 assert.deepEqual([f.store.getTask(oldId).workName,f.store.getTask(oldId).submittedWorkName,f.store.getTask(oldId).nameRevision],['','',0]);
 assert.equal(f.store.getDraft('image.text').workName,'');assert.equal(f.store.getDraft('image.text').revision,7);
 assert.equal(f.db.prepare('PRAGMA table_info(assets)').all().find(column=>column.name==='named_legacy').dflt_value,'0');
 assert.deepEqual((await migrateDatabase({db:f.db,dbPath:f.dbPath})).applied,[]);
});

test('N01 default and group drafts persist names independently by mode and group; omitted old-client field retains name',async t=>{
 const f=await rig(t),group=f.store.createGroup({name:'另一剧本'});
 assert.equal(f.store.getDraft('video.text').workName,'');assert.equal(f.store.getDraft('video.text',group.groupId).workName,'');
 const saved=f.store.putDraft('image.text',draft({workName:'  镜头甲  ',expectedRevision:0}));assert.equal(saved.workName,'镜头甲');
 f.store.putDraft('video.text',draft({workName:'镜头乙'}));f.store.putDraft('image.text',draft({workName:'镜头丙'}),group.groupId);
 const retained=f.store.putDraft('image.text',draft({prompt:'改提示词',expectedRevision:saved.revision}));assert.equal(retained.workName,'镜头甲');
 const other=f.store.getDraft('image.text',group.groupId);f.store.putDraft('image.text',draft({expectedRevision:other.revision}),group.groupId);
 assert.throws(()=>f.store.putDraft('image.text',draft({workName:'覆盖',expectedRevision:1})),{code:'DRAFT_REVISION_CONFLICT'});
 assert.deepEqual([f.store.getDraft('image.text').workName,f.store.getDraft('video.text').workName,f.store.getDraft('image.text',group.groupId).workName],['镜头甲','镜头乙','镜头丙']);
 assert.equal(f.store.putDraft('image.text',draft({workName:''})).workName,'');
 assert.equal(f.store.getDraft('video.text',group.groupId).workName,'');
 for(const name of ['字'.repeat(61),'a\u0000b','x\ny','\ud800',null,13])assert.throws(()=>f.store.putDraft('video.text',draft({workName:name})),{code:'WORK_NAME_INVALID'});
 assert.equal(f.store.putDraft('video.text',draft({workName:'🌊'.repeat(60)})).workName,'🌊'.repeat(60));
});

test('N01 snapshots freeze optional local names, old omitted shape remains unchanged, and upstream image request excludes name',()=>{
 const input={localRequestId:randomUUID(),connectionVersionId:randomUUID(),capabilityVersionId:randomUUID(),mode:'image.text',model,prompt:'合成测试',parameters:{},inputAssets:[]};
 const old=snapshotFor(input,'1.1.0'),named=snapshotFor({...input,workName:'  镜头03 / 海边 🌊  '},'1.1.0');
 assert.equal(Object.hasOwn(old,'workName'),false);assert.equal(named.workName,'镜头03 / 海边 🌊');
 assert.throws(()=>snapshotFor({...input,workName:'a'.repeat(61)},'1.1.0'),{code:'WORK_NAME_INVALID'});
 const request=require('../tasks/flare-image-adapter').buildSubmit(named,{baseUrl:OPENSOSEN_URL,provider:'opensosen',connectionVersionId:input.connectionVersionId});
 assert.deepEqual(request.json,{model,prompt:'合成测试',n:1});
});

test('N01 frozen submission retains workName and exact-intent conflict; old no-name intent still replays',async t=>{
 const f=await rig(t);seedCapabilities(f.db,'opensosen',OPENSOSEN_URL);
 const capability=f.db.prepare("SELECT id FROM model_capabilities WHERE model=? AND mode='image.text' AND evidence_level='application_verified' ORDER BY created_at DESC LIMIT 1").get(model);
 const auth={provider:'opensosen',baseUrl:OPENSOSEN_URL,protocol:'openai',apiKey:'synthetic-name-only'},input={localRequestId:randomUUID(),connectionVersionId:randomUUID(),capabilityVersionId:capability.id,mode:'image.text',model,prompt:'synthetic prompt',parameters:{},inputAssets:[],workName:'开场'};
 const prepared=f.store.prepareSubmission(input,auth,f.store);assert.equal(prepared.workName,'开场');assert.deepEqual(f.store.prepareSubmission(prepared,auth,f.store),prepared);
 assert.equal(f.store.submissions()[0].input.workName,'开场');
 assert.throws(()=>f.store.prepareSubmission({...prepared,workName:'结尾'},auth,f.store),{code:'LOCAL_REQUEST_CONFLICT'});
 const old={...input,localRequestId:randomUUID()};delete old.workName;const oldPrepared=f.store.prepareSubmission(old,auth,f.store);assert.equal(Object.hasOwn(oldPrepared,'workName'),false);assert.deepEqual(f.store.prepareSubmission(oldPrepared,auth,f.store),oldPrepared);
});

test('N01 display-name override and clearing preserve submitted snapshot and original generation deduplication',async t=>{
 const f=await rig(t),original=row(f,{workName:'提交名'}),old=row(f);const before=f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(original.id).input_snapshot_json;
 f.db.prepare("UPDATE tasks SET work_name='新展示名',work_name_revision=2,revision=revision+1 WHERE id=?").run(original.id);
 let task=f.store.getTask(original.id);assert.deepEqual([task.workName,task.submittedWorkName,task.nameRevision],['新展示名','提交名',2]);
 const service=createTaskService({db:f.db,store:f.store,connections:{getAuth(){throw Error('duplicate must not read credentials');}},resolveAdapter(){throw Error('duplicate must not submit');}});
 assert.equal(service.findDuplicate(original.snapshot),original.id);assert.equal(service.findDuplicate(old.snapshot),old.id);
 assert.throws(()=>service.findDuplicate({...original.snapshot,workName:'新展示名'}),{code:'LOCAL_REQUEST_CONFLICT'});
 f.db.prepare("UPDATE tasks SET work_name='' WHERE id=?").run(original.id);task=f.store.getTask(original.id);assert.equal(task.workName,'');assert.equal(task.submittedWorkName,'提交名');
 assert.equal(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(original.id).input_snapshot_json,before);await service.close();
});

test('N02 whitespace search is order-independent AND across current name, prompt and model with literal wildcard characters',async t=>{
 const f=await rig(t),first=row(f,{workName:'镜头03',prompt:'男子拿着行李箱 100% _片段',model:'Grok-imagine-test'}),second=row(f,{workName:'镜头03',prompt:'男子坐车',model:'Other-test'}),legacy=row(f,{legacy:true,prompt:'旧作品 行李箱',model:'Grok-legacy'});
 const ids=search=>f.store.listTasks({search}).items.map(task=>task.localTaskId).sort();
 assert.deepEqual(ids('镜头03 行李箱 grok'),[first.id]);assert.deepEqual(ids('  GROK\t行李箱　镜头03\n'),[first.id]);
 assert.deepEqual(ids('行李箱 grok').sort(),[first.id,legacy.id].sort());assert.deepEqual(ids('镜头03 Other'),[second.id]);
 assert.deepEqual(ids('100% _片段'),[first.id]);assert.deepEqual(ids('%不存在'),[]);assert.deepEqual(ids("' OR 1=1 --"),[]);
 assert.equal(ids(' \t\n　').length,3);assert.equal(ids('行李箱 不存在').length,0);
 f.db.prepare("UPDATE tasks SET work_name='新名' WHERE id=?").run(first.id);assert.equal(ids('镜头03 行李箱').length,0);assert.deepEqual(ids('新名 grok'),[first.id]);
 f.db.prepare("UPDATE tasks SET work_name='' WHERE id=?").run(first.id);assert.equal(ids('镜头03 行李箱').length,0);assert.deepEqual(ids('行李箱 100%'),[first.id]);
});

test('N02 keyword predicates compose with group/date/kind and preserve pagination totals',async t=>{
 const f=await rig(t),group=f.store.createGroup({name:'指定组'}),a=row(f,{workName:'开场',prompt:'海边日落',createdAt:'2026-11-04T01:00:00.000Z'}),b=row(f,{workName:'开场',prompt:'海边推进',createdAt:'2026-11-05T01:00:00.000Z'});
 f.db.prepare('UPDATE task_group_memberships SET group_id=? WHERE task_id=?').run(group.groupId,b.id);
 const result=f.store.listTasks({search:'海边 开场',kind:'image',groupId:group.groupId,createdFrom:'2026-11-05T00:00:00.000Z',createdBefore:'2026-11-06T00:00:00.000Z',limit:1});assert.deepEqual(result.items.map(task=>task.localTaskId),[b.id]);assert.equal(result.total,1);assert.equal(result.unfilteredTotal,1);
 const all=f.store.listTasks({search:'开场 海边',limit:1,offset:1});assert.equal(all.total,2);assert.equal(all.unfilteredTotal,2);assert.deepEqual(all.items.map(task=>task.localTaskId),[a.id]);
 assert.equal(f.store.listTasks({search:'海边',groupId:DEFAULT_GROUP}).total,1);
});

test('N03 HTTP rename action strictly validates input and emits task-changed only after success',async()=>{
 let body,result,called=0,changed=0;const taskId=randomUUID(),requestId=randomUUID();
 const handler=createStorageHttp({getStore:()=>({renameTaskWork(id,value){called++;assert.equal(id,taskId);assert.deepEqual(value,body);return{taskId,nameRevision:1,task:{workName:value.workName}};}}),readRawBody:async()=>Buffer.from(JSON.stringify(body)),onTaskChanged:id=>{assert.equal(id,taskId);changed++;},sendJson:(_res,status,value)=>{result={status,value};}});
 const run=async()=>{const route=new URL('http://local.invalid/api/nova/storage/tasks/'+taskId+'/name');await handler({method:'POST'},{},route.pathname,route.searchParams);return result;};
 for(const value of [{requestId,workName:'新名'},{requestId,expectedNameRevision:-1,workName:'新名'},{requestId:'bad',expectedNameRevision:0,workName:'新名'},{requestId,expectedNameRevision:Number.MAX_SAFE_INTEGER+1,workName:'新名'},{requestId,expectedNameRevision:0,workName:'新名',path:'outside'},null,[]]){body=value;assert.equal((await run()).status,400);}
 assert.equal(called,0);assert.equal(changed,0);body={requestId,expectedNameRevision:0,workName:'新名'};assert.equal((await run()).status,200);assert.equal(changed,1);assert.equal(called,1);
});

test('N03 actual authenticated HTTP and WS expose current names, preserve originals and reject stale edits',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-work-name-http-')),dbPath=path.join(directory,'tasks.sqlite'),db=new Database(dbPath);await migrateDatabase({db,dbPath});
 const taskId=randomUUID();db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(taskId,'failed','text-to-image',JSON.stringify({model:'synthetic-old',prompt:'历史 行李箱'}),'2026-11-05T00:00:00.000Z');db.close();
 const runtime=await start(directory);let ws;t.after(async()=>{ws?.terminate();await runtime.stop();clean(directory);});
 ws=runtime.openWebSocket();const messages=[];ws.on('message',data=>messages.push(JSON.parse(String(data))));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({type:'subscribeTasks',taskIds:[taskId]}));const initialEnd=Date.now()+3000;while(!messages.some(message=>message.type==='task'&&message.task.id===taskId)&&Date.now()<initialEnd)await new Promise(resolve=>setTimeout(resolve,15));assert.ok(messages.some(message=>message.type==='task'&&message.task.id===taskId&&message.task.nameRevision===0));
 const route='/api/nova/storage/tasks/'+taskId+'/name',body={requestId:randomUUID(),expectedNameRevision:0,workName:'旧作品新名'};
 assert.equal((await fetch(runtime.origin+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,403);
 const post=body=>runtime.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await post(body);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const result=await response.json();assert.equal(result.task.workName,'旧作品新名');assert.equal(result.task.submittedWorkName,'');assert.equal(result.task.nameRevision,1);
 const end=Date.now()+3000;while(!messages.some(message=>message.type==='task'&&message.task.id===taskId&&message.task.workName==='旧作品新名')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,15));
 assert.ok(messages.some(message=>message.type==='task'&&message.task.id===taskId&&message.task.workName==='旧作品新名'));
 const search=await(await runtime.request('/api/nova/storage/tasks?search='+encodeURIComponent('新名 行李箱 synthetic'))).json();assert.equal(search.total,1);
 assert.equal((await post({...body,requestId:randomUUID(),workName:'过期覆盖'})).status,409);assert.equal((await post(body)).status,200);
 assert.equal((await(await runtime.request('/api/nova/storage/tasks/'+taskId)).json()).task.workName,'旧作品新名');
});

test('N04 named generation saves verified media and synchronous rename preserves frozen intent, media bytes and one upstream POST',async t=>{
 const http=require('node:http'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-name-generation-')),png=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png')),posts=[];
 const upstream=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:model,supported_endpoint_types:['image-generation']}]}));return;}
  if(req.method==='GET'&&req.url==='/api/pricing'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({success:true,data:[]}));return;}
  if(req.method==='POST'&&req.url==='/v1/images/generations'){const chunks=[];for await(const chunk of req)chunks.push(chunk);posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));return;}
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const runtime=await start(directory,{opensosenOrigin:'http://127.0.0.1:'+upstream.address().port});
 t.after(async()=>{await runtime.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));clean(directory);});
 const connection=await runtime.saveConnection({baseUrl:OPENSOSEN_URL,apiKey:'synthetic-work-name-generation'}),catalog=await(await runtime.request('/api/nova/connections/'+connection.connectionId+'/models')).json();
 const capability=catalog.capabilities.find(item=>item.model===model&&item.mode==='image.text'),input={localRequestId:randomUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,mode:'image.text',model,prompt:'男子拿着行李箱',workName:'镜头03',parameters:{},inputAssets:[]};
 const post=(route,value)=>runtime.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
 const preparedResponse=await post('/api/nova/storage/submissions',input);assert.equal(preparedResponse.status,201,JSON.stringify(await preparedResponse.clone().json()));const prepared=(await preparedResponse.json()).input;
 const created=await post('/api/nova/workbench/tasks',prepared);assert.equal(created.status,202,JSON.stringify(await created.clone().json()));const taskId=(await created.json()).taskId;
 let task;const end=Date.now()+8000;do{task=await(await runtime.request('/api/nova/storage/tasks/'+taskId)).json();task=task.task;if(task.status==='completed'||task.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<end);
 assert.equal(task.status,'completed',JSON.stringify(task));assert.equal(task.workName,'镜头03');assert.equal(task.submittedWorkName,'镜头03');assert.match(task.outputAssets[0].displayName,/^镜头03_.*\.png$/);assert.equal(posts.length,1);assert.deepEqual(posts[0],{model,prompt:'男子拿着行李箱',n:1});
 const oldFile=path.join(task.outputLocation,task.outputAssets[0].displayName);assert.deepEqual(fs.readFileSync(oldFile),png);
 const renamedResponse=await post('/api/nova/storage/tasks/'+taskId+'/name',{requestId:randomUUID(),expectedNameRevision:task.nameRevision,workName:'第一幕'});assert.equal(renamedResponse.status,200,JSON.stringify(await renamedResponse.clone().json()));const renamed=(await renamedResponse.json()).task;
 assert.equal(renamed.workName,'第一幕');assert.equal(renamed.submittedWorkName,'镜头03');assert.equal(renamed.nameRevision,1);assert.match(renamed.outputAssets[0].displayName,/^第一幕_.*\.png$/);assert.equal(fs.existsSync(oldFile),false);assert.deepEqual(fs.readFileSync(path.join(renamed.outputLocation,renamed.outputAssets[0].displayName)),png);
 const preview=await runtime.request(renamed.outputAssets[0].previewUrl);assert.equal(preview.status,200);assert.deepEqual(Buffer.from(await preview.arrayBuffer()),png);
 const duplicate=await post('/api/nova/workbench/tasks',prepared);assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).taskId,taskId);assert.equal(posts.length,1);
 const search=await(await runtime.request('/api/nova/storage/tasks?scope=library&search='+encodeURIComponent('第一幕 行李箱 flare'))).json();assert.equal(search.total,1);assert.equal(search.items[0].localTaskId,taskId);
});
