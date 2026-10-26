'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {migrateDatabase,MIGRATIONS}=require('../storage/migrations');
const {createConnectionService}=require('../connections/service');
const {createWorkbenchStore}=require('../storage/store');
const {createTaskService}=require('../tasks/service');
const {createDiagnostics}=require('../storage/diagnostics');
const routing=require('../connections/route-policy');
const base=routing.BASES.com,key='synthetic-route-key',tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await tick();}throw Error('synthetic task did not settle');}
async function setup(t,options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-routes-')),db=new Database(path.join(directory,'tasks.sqlite'));
 await migrateDatabase({db,dbPath:db.name,migrations:options.migrations||MIGRATIONS});
 const keys=new Map(),vault={store(value){const id=randomUUID();keys.set(id,value);return id;},read(id){if(!keys.has(id))throw Object.assign(Error(),{code:'CREDENTIAL_REQUIRED'});return keys.get(id);},state:id=>keys.has(id)?'ready':'missing',revokeConnection(id){for(const row of db.prepare('SELECT credential_ref FROM connection_versions WHERE connection_id=?').all(id))keys.delete(row.credential_ref);}};
 // Keep the existing route/model assertions scoped to models; pricing has separate call-count coverage.
 const make=()=>createConnectionService({db,vault,fetchImpl:async(url,init)=>new URL(url).pathname==='/api/pricing'?Response.json({data:[]}):(options.fetchImpl|| (async()=>Response.json({data:[]})))(url,init)});
 const cleanups=[],service=make(),connection=service.save({baseUrl:base,apiKey:key});
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();if(db.open)db.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:4,retryDelay:25});});
 return {db,directory,vault,service,connection,make,cleanups,switch(route){const old=service.summary(connection.connectionId);return service.save({connectionId:old.connectionId,expectedVersionId:old.connectionVersionId,expectedRouteRevision:old.routeRevision,route});}};
}
test('route save changes only revision, keeps identity/key, validates conflicts and preserves legacy requests',async t=>{
 const f=await setup(t),first=f.connection,auth=f.service.getAuth(first.connectionVersionId);
 assert.equal(first.route,'cn');assert.equal(first.routeRevision,1);assert.equal(first.routeSupported,true);
 const second=f.switch('com');assert.equal(second.connectionVersionId,first.connectionVersionId);assert.equal(second.routeRevision,2);assert.deepEqual(f.service.getAuth(first.connectionVersionId),auth);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM connection_versions').get().n,1);
 assert.throws(()=>f.service.save({connectionId:first.connectionId,expectedVersionId:first.connectionVersionId,route:'cn',expectedRouteRevision:1}),{code:'CONNECTION_ROUTE_CONFLICT'});
 assert.throws(()=>f.service.save({connectionId:first.connectionId,expectedVersionId:first.connectionVersionId,route:'cn'}),{code:'CONNECTION_ROUTE_CONFLICT'});
 const legacy=f.service.save({connectionId:first.connectionId,expectedVersionId:first.connectionVersionId,displayName:'old client'});assert.equal(legacy.route,'com');assert.equal(legacy.routeRevision,2);
 const custom=f.service.save({baseUrl:'https://custom.invalid/v1',provider:'opensosen',apiKey:key});assert.equal(custom.routeSupported,false);assert.equal(custom.route,null);
 assert.throws(()=>f.service.save({connectionId:custom.connectionId,expectedVersionId:custom.connectionVersionId,route:'cn',expectedRouteRevision:1}),{code:'TRANSPORT_ROUTE_INVALID'});
 assert.equal(f.make().summary(first.connectionId).route,'com');
});
test('migration v10 to v11 clears old line checks but preserves versions, credentials, preferences and checksums',async t=>{
 // Build v10 without constructing the v11-aware service.
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-route-upgrade-')),db=new Database(path.join(directory,'tasks.sqlite'));t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
 await migrateDatabase({db,dbPath:db.name,migrations:MIGRATIONS.slice(0,10)});
 const connectionId=randomUUID(),versionId=randomUUID(),customId=randomUUID(),customVersion=randomUUID();
 for(const [id,v,url,provider]of [[connectionId,versionId,base,'opensosen'],[customId,customVersion,'https://custom.invalid/v1','openai-compatible']]){
 db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(id,'synthetic','2026-01-01','2026-01-01');db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(v,id,url,provider,'2026-01-01');db.prepare('INSERT INTO connection_preferences VALUES(?,?,?,?)').run(v,'openai','image','video');db.prepare('UPDATE connections SET current_version_id=? WHERE id=?').run(v,id);db.prepare('INSERT INTO connection_checks VALUES(?,?,?,?,?,?,?)').run(v,'verified','2026-10-25','2026-10-25','2026-10-25','["old-route-model"]',null);}
 const versions=db.prepare('SELECT * FROM connection_versions ORDER BY id').all(),history=db.prepare('SELECT version,checksum FROM schema_migrations').all();
 await migrateDatabase({db,dbPath:db.name});assert.deepEqual(db.prepare('SELECT * FROM connection_versions ORDER BY id').all(),versions);assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=10').all(),history);
 assert.deepEqual(db.prepare('SELECT * FROM connection_routes').get(),{connection_id:connectionId,route:'cn',revision:1});assert.equal(db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(versionId),undefined);assert.equal(db.prepare('SELECT * FROM connection_checks WHERE connection_version_id=?').get(customVersion).validation_state,'verified');
 assert.deepEqual((await migrateDatabase({db,dbPath:db.name})).applied,[]);
});
test('late route initialization clears old checks before the very first summary projection',async t=>{
 const f=await setup(t);await f.service.check(f.connection.connectionId,{connectionVersionId:f.connection.connectionVersionId});f.db.prepare('DELETE FROM connection_routes').run();
 assert.equal(f.service.summary(f.connection.connectionId).validationState,'unverified');assert.equal(f.service.models(f.connection.connectionId).modelsFetchedAt,null);
});
test('resolver maps both approved aliases only after validating methods, exact origins and endpoints',()=>{
 for(const route of ['cn','com'])for(const source of ['cn','com'])for(const [operation,method,suffix]of [['models','GET','/models'],['submit','POST','/images/generations'],['submit','POST','/images/edits'],['submit','POST','/videos'],['poll','GET','/videos/a%2Fb%3F'],['download','GET','/videos/a%2Fb%3F/content']]){
 const identity={provider:'opensosen',baseUrl:routing.BASES[source]},request={url:identity.baseUrl+suffix,method};assert.equal(routing.resolveRequest(identity,request,operation,{route,revision:3}).url,routing.BASES[route]+suffix);
 }
 const identity={provider:'opensosen',baseUrl:base};for(const url of ['https://newapi.opensosen.com.evil/v1/videos','http://newapi.opensosen.com/v1/videos','https://newapi.opensosen.com:8443/v1/videos',base+'/other',base+'/videos?key=x',base+'/a/../videos',base+'/videos#fragment','https://user@newapi.opensosen.com/v1/videos'])assert.throws(()=>routing.resolveRequest(identity,{url,method:'POST'},'submit',{route:'cn',revision:1}),{code:'TRANSPORT_ROUTE_INVALID'});
 assert.throws(()=>routing.resolveRequest(identity,{url:base+'/videos',method:'GET'},'submit',{route:'cn',revision:1}),{code:'TRANSPORT_ROUTE_INVALID'});
 const request={url:'https://cdn.invalid/file?sig=keep',method:'GET'};assert.equal(routing.resolveRequest({provider:'other',baseUrl:base},request,'download',{route:'cn',revision:1}).url,request.url);
});
test('models success/failure caches and in-flight responses cannot cross route revisions or switch back',async t=>{
 const calls=[],pending=[];const f=await setup(t,{fetchImpl:(url)=>{calls.push(url);return new Promise(resolve=>pending.push(resolve));}}),id=f.connection.connectionId,v=f.connection.connectionVersionId;
 const old=f.service.check(id,{connectionVersionId:v}),merged=f.service.check(id,{connectionVersionId:v});assert.equal(calls.length,1);
 f.switch('com');const current=f.service.check(id,{connectionVersionId:v});assert.equal(calls.length,2);pending[1](Response.json({data:[{id:'new-line-model'}]}));await current;pending[0](Response.json({data:[{id:'stale-model'}]}));assert.equal((await old).stale,true);assert.equal((await merged).stale,true);
 assert.equal(f.service.models(id).models.find(x=>x.model==='new-line-model').visibility,'visible');assert.equal(f.service.models(id).models.some(x=>x.model==='stale-model'),false);
 f.switch('cn');const back=f.service.check(id,{connectionVersionId:v,reason:'submit'});assert.equal(calls.length,3);pending[2](new Response(null,{status:401}));await back;f.switch('com');const fourth=f.service.check(id,{connectionVersionId:v,reason:'submit'});assert.equal(calls.length,4);pending[3](Response.json({data:[]}));await fourth;
 assert.deepEqual(calls,[routing.BASES.cn+'/models',base+'/models',routing.BASES.cn+'/models',base+'/models']);
});
for(const status of [200,401])test('candidate validation '+status+' is stale after external route revision, including failure writes',async t=>{
 let resolve;const f=await setup(t,{fetchImpl:()=>new Promise(r=>{resolve=r;})}),c=f.connection;
 const pending=f.service.validateAndSave({operationId:randomUUID(),connectionId:c.connectionId,expectedVersionId:c.connectionVersionId,route:'cn',expectedRouteRevision:1});
 // Simulate a second host client committing a route edit without access to this candidate's abort controller.
 f.db.prepare("UPDATE connection_routes SET route='com',revision=revision+1 WHERE connection_id=?").run(c.connectionId);
 resolve(status===200?Response.json({data:[]}):new Response(null,{status}));assert.equal((await pending).stale,true);assert.equal(f.service.summary(c.connectionId).route,'com');assert.equal(f.service.summary(c.connectionId).validationState,'unverified');
});
test('candidate checks selected route; saving only route reuses key and version, and rejection refresh uses generation route',async t=>{
 const calls=[];const f=await setup(t,{fetchImpl:async url=>{calls.push(url);return Response.json({data:[]});}}),c=f.connection;
 const result=await f.service.validateAndSave({operationId:randomUUID(),connectionId:c.connectionId,expectedVersionId:c.connectionVersionId,expectedRouteRevision:1,route:'com'});assert.equal(result.connection.route,'com');assert.equal(result.connection.connectionVersionId,c.connectionVersionId);assert.equal(calls[0],base+'/models');
 await f.service.modelRejected(c.connectionVersionId,{route:'cn',revision:1});assert.equal(calls.length,1);await f.service.modelRejected(c.connectionVersionId,{route:'com',revision:2});assert.equal(calls.length,2);
 const diagnostics=createDiagnostics(f.db);assert.ok(diagnostics.modelCatalog.some(x=>x.route==='com'&&x.routeRevision===2));assert.equal(JSON.stringify(diagnostics).includes(key),false);
});
async function taskSetup(t,options={}){
 const f=await setup(t,options),store=createWorkbenchStore({db:f.db,rootDirectory:path.join(f.directory,'storage')}),calls=[];
 const implementation={id:'synthetic',version:'1',submit:async(task,snapshot,auth)=>{calls.push({operation:'submit',auth,snapshot});return {upstreamTaskId:'original-id'};},poll:async(task,snapshot,auth)=>{calls.push({operation:'poll',auth,id:task.upstream_task_id});return {remoteState:'generating'};},...options.adapter};
 const service=createTaskService({db:f.db,store,connections:f.service,resolveAdapter:()=>implementation,policy:{intervalMs:0},downloadWorker:options.downloadWorker});f.cleanups.push(()=>service.close());
 // Cleanup must close the runtime before the fixture closes SQLite.
 const snapshot={contractVersion:1,localRequestId:randomUUID(),connectionVersionId:f.connection.connectionVersionId,mode:'video.text',model:'synthetic',prompt:'synthetic',parameters:{},inputAssets:[],adapterId:'synthetic',adapterVersion:'1'};
 return {...f,tasks:service,store,calls,snapshot,enqueue:()=>service.enqueue({snapshot,request:{},mode:'video.text'})};
}
test('generation freezes at enqueue, duplicate after switch returns same task; poll uses current route and original credential version',async t=>{
 const f=await taskSetup(t),id=f.enqueue();f.switch('com');assert.equal(f.enqueue(),id);assert.throws(()=>f.tasks.enqueue({snapshot:{...f.snapshot,transportRoute:{route:'com',revision:9}},request:{},mode:'video.text'}),{code:'INPUT_INVALID'});
 await until(()=>f.calls.some(x=>x.operation==='submit'));assert.deepEqual(f.calls[0].auth.transportRoute,{route:'cn',revision:1});assert.deepEqual(f.tasks.get(id).transportRoute,{route:'cn',revision:1});
 const current=f.service.summary(f.connection.connectionId);f.service.save({connectionId:current.connectionId,expectedVersionId:current.connectionVersionId,apiKey:'synthetic-rotated-key'});
 await until(()=>f.tasks.get(id).upstreamTaskId==='original-id');await f.tasks.poll(id);const poll=f.calls.find(x=>x.operation==='poll');assert.equal(poll.auth.apiKey,key);assert.deepEqual(poll.auth.transportRoute,{route:'com',revision:2});assert.equal(poll.id,'original-id');assert.equal(f.calls.filter(x=>x.operation==='submit').length,1);
 assert.throws(()=>f.db.prepare('UPDATE tasks SET transport_route_json=? WHERE id=?').run('{"route":"com","revision":2}',id),/IMMUTABLE_TRANSPORT_ROUTE/);
 await f.tasks.close();
});
test('queued download freezes attempt route and manual retry reads new route',async t=>{
 const downloads=[];let f;
 f=await taskSetup(t,{adapter:{submit:async()=>({resultSources:[{kind:'url',url:base+'/videos/original-id/content',authScope:'connection',mediaKind:'video'}]})},downloadWorker:async(task,sources,options)=>{downloads.push(options.transportRoute);throw Object.assign(Error(),{code:'DOWNLOAD_CONNECTION_FAILED'});}});
 const id=f.enqueue();await until(()=>f.tasks.get(id).status==='download_failed');assert.deepEqual(downloads,[{route:'cn',revision:1}]);f.switch('com');
 f.tasks.action(id,'retry-download',{requestId:randomUUID()});await until(()=>downloads.length===2&&f.tasks.get(id).status==='download_failed');assert.deepEqual(downloads[1],{route:'com',revision:2});assert.deepEqual(f.tasks.get(id).downloadAttempt.transportRoute,{route:'com',revision:2});assert.equal(f.calls.filter(x=>x.operation==='submit').length,0);
 await f.tasks.close();
});

test('legacy queued snapshot stays immutable and acquires its first transport selection before dispatch',async t=>{
 const f=await taskSetup(t),id=randomUUID(),snapshot=f.store.freezeOutputDirectory(f.snapshot);
 f.db.prepare("INSERT INTO tasks(id,status,mode,request_json,created_at,execution_media_kind,execution_timeout_seconds,lifecycle_version) VALUES(?,'local_queued','video.text','{}',?,'video',300,2)").run(id,new Date().toISOString());f.store.setTaskSnapshot(id,snapshot);const original=f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json;
 f.switch('com');await f.tasks.pump();await until(()=>f.calls.some(x=>x.operation==='submit'));
 assert.deepEqual(f.calls[0].auth.transportRoute,{route:'com',revision:2});assert.equal(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json,original);assert.deepEqual(f.tasks.get(id).transportRoute,{route:'com',revision:2});await f.tasks.close();
});
test('production image text/reference and video POST/GET use selected target with original identity and no redirect POST replay',async t=>{
 const f=await setup(t),{createFlareImageAdapter}=require('../tasks/flare-image-adapter'),{createPluginAdapter}=require('../tasks/plugin-adapter'),plugin=require('../plugin-runtime/registry').getPlugin('opensosen-video');
 const {validateCapability}=require('../tasks/workbench-input'),videoPolicy=require('../tasks/video-policy');
 const auth=f.service.getAuth(f.connection.connectionVersionId),assetId=randomUUID(),bytes=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png')),asset={assetId,kind:'image',mimeType:'image/png'};
 const options={getAsset:()=>asset,readAsset:()=>({asset,bytes}),validateCapability:(snapshot,value)=>validateCapability(f.db,snapshot,value),authorizeContext(context,snapshot,value){const cap=validateCapability(f.db,snapshot,value);if(videoPolicy.allows(cap,snapshot,value))videoPolicy.authorizeContext(context,snapshot,value,cap);else require('../tasks/controlled-video-text-validation').controlledVideoTextValidation.authorizeContext(context,snapshot,value,cap);}};
 const image=createFlareImageAdapter(options),video=createPluginAdapter(plugin,options),calls=[],previous=global.fetch,events=[];
 t.after(()=>{global.fetch=previous;});global.fetch=async(url,init)=>{calls.push({url,init});if(url.endsWith('/videos'))return Response.json({id:'same/id',status:'queued'});if(init.method==='GET')return Response.json({status:'completed'});return Response.json({data:[{b64_json:bytes.toString('base64')}]});};
 for(const route of ['cn','com'])for(const mode of ['image.text','image.reference','video.text']){
 const capability=f.service.models(f.connection.connectionId).capabilities.find(c=>c.mode===mode&&c.model===(mode.startsWith('image')?'gpt-image-2.5-flare':'grok-imagine-video-1.5-6s')&&(mode==='image.reference'?c.evidenceVersion===require('../tasks/image-policy').POLICY.evidenceVersion:mode==='image.text'?c.evidenceVersion===require('../connections/capabilities').APPLICATION_EVIDENCE_VERSION:c.evidenceVersion===require('../connections/capabilities').TEXT_VIDEO_EVIDENCE_VERSION));
 const snapshot={contractVersion:1,connectionVersionId:auth.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,mode,model:capability.model,prompt:'synthetic prompt',parameters:mode.startsWith('video')?{seconds:6}:{},inputAssets:mode==='image.reference'?[{assetId,position:0,role:'reference'}]:[],adapterId:mode.startsWith('video')?'plugin:opensosen-video':'opensosen-flare-image',adapterVersion:'1.1.0'};
 const task={input_snapshot_json:JSON.stringify(snapshot),request_json:JSON.stringify({model:snapshot.model,fields:{prompt:snapshot.prompt}})},requestAuth={...auth,transportRoute:{route,revision:route==='cn'?1:2},diagnostic:(point,value)=>events.push(value)};
 const adapter=mode.startsWith('image')?image:video;await adapter.preflight(task,snapshot,requestAuth);const result=await adapter.submit(task,snapshot,requestAuth),last=calls.at(-1);
 assert.equal(last.url,routing.BASES[route]+(mode==='image.text'?'/images/generations':mode==='image.reference'?'/images/edits':'/videos'));assert.equal(last.init.method,'POST');assert.equal(last.init.redirect,'manual');assert.equal(last.init.headers.Authorization,'Bearer '+key);
 if(mode==='image.reference'){assert.deepEqual(Buffer.from(await last.init.body.get('image').arrayBuffer()),bytes);assert.equal(last.init.body.get('prompt'),snapshot.prompt);}
 if(mode==='video.text'){assert.equal(last.init.body.get('seconds'),'6');assert.equal(last.init.body.has('size'),false);const queried=await video.poll({...task,upstream_task_id:result.upstreamTaskId},snapshot,requestAuth);assert.equal(calls.at(-1).url,routing.BASES[route]+'/videos/same%2Fid');assert.equal(calls.at(-1).init.method,'GET');assert.equal(queried.resultSources[0].url,base+'/videos/same%2Fid/content');}
 }
 assert.ok(events.some(value=>value.targetHost==='newapi.opensosen.cn'&&value.route==='cn'));
 const count=calls.length;global.fetch=async(url,init)=>{calls.push({url,init});return new Response(null,{status:307,headers:{location:base+'/images/generations'}});};
 const cap=f.service.models(f.connection.connectionId).capabilities.find(c=>c.mode==='image.text'&&c.evidenceVersion===require('../connections/capabilities').APPLICATION_EVIDENCE_VERSION),snap={model:cap.model,mode:'image.text',prompt:'synthetic',parameters:{},inputAssets:[],capabilityVersionId:cap.capabilityVersionId};
 await assert.rejects(image.submit({},snap,{...auth,transportRoute:{route:'cn',revision:1}}),{code:'SUBMISSION_UNKNOWN'});assert.equal(calls.length,count+1);
});
test('HTTP check accepts route revision and IPC saves it through the existing restricted boundary',async t=>{
 const f=await setup(t),handlers=new Map(),{registerDesktopIpc}=require('../../desktop/ipc.cjs'),{createConnectionHttp}=require('../connections/http'),http=require('node:http');
 const ipc=registerDesktopIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},policy:{isTrustedSender:()=>true},getConnectionService:()=>f.service});t.after(()=>ipc.dispose());
 const saved=await handlers.get('nova:save-connection')({}, {connectionId:f.connection.connectionId,expectedVersionId:f.connection.connectionVersionId,route:'com',expectedRouteRevision:1});assert.equal(saved.ok,true);assert.equal(saved.connection.routeRevision,2);assert.equal(saved.connection.connectionVersionId,f.connection.connectionVersionId);
 const handle=createConnectionHttp({getService:()=>f.service,readJsonBody:async req=>{let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text);},sendJson:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}});
 const server=http.createServer((req,res)=>{void handle(req,res,new URL(req.url,'http://localhost').pathname);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const url='http://127.0.0.1:'+server.address().port+'/api/nova/connections/'+f.connection.connectionId;
 const stale=await fetch(url+'/check',{method:'POST',body:JSON.stringify({connectionVersionId:f.connection.connectionVersionId,expectedRouteRevision:1})});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'CONNECTION_ROUTE_CONFLICT');
 const checked=await fetch(url+'/check',{method:'POST',body:JSON.stringify({connectionVersionId:f.connection.connectionVersionId,expectedRouteRevision:2})});assert.equal(checked.status,200);const body=await checked.json();assert.equal(body.connection.route,'com');assert.equal(body.routeRevision,2);assert.equal(JSON.stringify(body).includes(key),false);
});

test('expired source refresh and next worker call keep the queued attempt route after switching connection',async t=>{
 let f,downloads=0;const routes=[],queries=[];
 f=await taskSetup(t,{adapter:{submit:async()=>({upstreamTaskId:'refresh-original',resultSources:[{kind:'url',url:base+'/videos/refresh-original/content',authScope:'connection',mediaKind:'video'}]}),poll:async(task,snapshot,auth)=>{queries.push({route:auth.transportRoute,id:task.upstream_task_id,key:auth.apiKey});return {remoteState:'completed',resultSources:[{kind:'url',url:base+'/videos/refresh-original/content',authScope:'connection',mediaKind:'video'}]};}},downloadWorker:async(task,sources,options)=>{downloads++;routes.push(options.transportRoute);if(downloads===1){f.switch('com');throw Object.assign(Error(),{code:'DOWNLOAD_EXPIRED'});}throw Object.assign(Error(),{code:'DOWNLOAD_CONNECTION_FAILED'});}});
 const id=f.enqueue();await until(()=>f.tasks.get(id).status==='download_failed');assert.equal(downloads,2);assert.deepEqual(routes,[{route:'cn',revision:1},{route:'cn',revision:1}]);assert.deepEqual(queries,[{route:{route:'cn',revision:1},id:'refresh-original',key}]);assert.equal(f.service.summary(f.connection.connectionId).route,'com');await f.tasks.close();
});
