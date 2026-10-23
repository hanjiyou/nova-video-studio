'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {migrateDatabase,MIGRATIONS}=require('../storage/migrations');
const {createWorkbenchStore}=require('../storage/store');
const {createTaskService}=require('../tasks/service');
const {createDownloadWorker,privateAddress}=require('../storage/download-worker');
const {validateMedia}=require('../storage/media-validator');
const {createAssetActions}=require('../../desktop/asset-actions.cjs');
const {rangeFor}=require('../storage/http');
const png=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png')),video=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4'));
async function until(fn){const end=Date.now()+12000;while(Date.now()<end){const value=fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('B2 state timeout');}
async function setup(t,options={}) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-b2-')),dbPath=path.join(directory,'tasks.sqlite'),db=new Database(dbPath);
    await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(directory,'storage')});
    const connectionId=randomUUID(),versionId=randomUUID(),key='synthetic-b2-protected';
    db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connectionId,'test','2026-01-01','2026-01-01');
    db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(versionId,connectionId,'https://provider.invalid/v1','openai-compatible','2026-01-01');
    let submits=0,polls=0,credential=true;
    const connections={getAuth(id){assert.equal(id,versionId);if(!credential)throw Object.assign(new Error(),{code:'CREDENTIAL_REQUIRED'});return {baseUrl:'https://provider.invalid/v1',connectionVersionId:id,apiKey:key};}};
    const implementation={submit:async()=>({resultSources:[{kind:'url',url:'https://cdn.invalid/video.mp4',mediaKind:'video',authScope:'none'}]}),poll:async()=>({remoteState:'completed',resultSources:[{kind:'url',url:'https://cdn.invalid/video.mp4?sig=refreshed',mediaKind:'video',authScope:'none'}]}),...options.adapter};
    const adapter={id:'b2',version:'1',submit(...args){submits++;return implementation.submit(...args);},poll(...args){polls++;return implementation.poll(...args);}};
    const worker=createDownloadWorker({store,connections,checkUrl:async()=>{},fetchImpl:async()=>new Response(video),...options.worker});
    const make=extra=>createTaskService({db,store,connections,resolveAdapter:()=>adapter,downloadWorker:worker,...extra});let service=make(options.service);
    const snapshot=extra=>({contractVersion:1,localRequestId:randomUUID(),connectionVersionId:versionId,mode:'video.text',model:'synthetic',prompt:'中文',parameters:{},inputAssets:[],adapterId:'b2',adapterVersion:'1',...extra});
    t.after(async()=>{await service.close();db.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
    return {directory,db,store,snapshot,worker,implementation,connections,key,get service(){return service;},get submits(){return submits;},get polls(){return polls;},credential(value){credential=value;},enqueue(input=snapshot()){return service.enqueue({snapshot:input,request:{},mode:'plugin'});},async restart(extra){await service.close();service=make(extra);service.recover();}};
}
test('bundled full decoder verifies every image/video frame, dimensions, duration; JSON MP4 and truncated media fail',async t=>{
    const f=await setup(t);
    for(const [name,bytes,kind]of[['image.part',png,'image'],['video.part',video,'video']]){
        const file=path.join(f.directory,name);fs.writeFileSync(file,bytes);const result=await validateMedia(file,{expectedKind:kind});
        assert.ok(result.width&&result.height);assert.equal(result.kind,kind);assert.ok(result.decodedFrames>0);if(kind==='video'){assert.equal(result.decodedFrames,24);assert.ok(result.durationSeconds>=2);}
    }
    for(const [name,bytes]of[['json.mp4',Buffer.from('{"error":"fake video"}')],['truncated.mp4',video.subarray(0,video.length-10000)],['truncated.png',png.subarray(0,33)]]){
        const file=path.join(f.directory,name);fs.writeFileSync(file,bytes);await assert.rejects(validateMedia(file),{code:'MEDIA_INVALID'});
    }
});
test('production queue only completes after actual decode and managed publication; read is offline and verified',async t=>{
    const f=await setup(t),id=f.enqueue();await until(()=>f.service.get(id).status==='completed');const task=f.service.get(id);
    assert.equal(f.submits,1);assert.equal(task.outputAssets.length,1);const asset=task.outputAssets[0];assert.equal(asset.validationState,'verified');assert.equal(asset.mimeType,'video/mp4');assert.equal(asset.width,160);
    assert.deepEqual(f.store.readAsset(asset.assetId).bytes,video);assert.equal(fs.readdirSync(f.store.downloadDirectory(task.outputRootRef)).length,0);
    await f.restart();assert.equal(f.service.get(id).status,'completed');assert.equal(f.submits,1);assert.equal(f.polls,0);
});
test('download concurrency is one while independent generation advances; no unverified output is bound',async t=>{
    let release,entered=0;const pending=new Promise(resolve=>{release=resolve;});
    const f=await setup(t,{worker:{fetchImpl:async()=>{entered++;if(entered===1)await pending;return new Response(video);}}}),first=f.enqueue(),second=f.enqueue();
    try {await until(()=>entered===1&&f.submits===2);assert.equal(f.service.get(first).status,'downloading');assert.equal(f.service.get(first).outputAssets.length,0);assert.equal(f.service.get(second).status,'remote_completed');assert.equal(f.service.stats().downloadsRunning,1);}
    finally {release();}
    await until(()=>f.service.get(second).status==='completed');assert.equal(entered,2);
});
test('each redirect recomputes auth: CDN and redirect back never receive the original version Key',async t=>{
    const calls=[],urls=['https://provider.invalid/v1/content','https://cdn.invalid/file?signature=temporary','https://provider.invalid/v1/final'];
    const f=await setup(t,{adapter:{submit:async()=>({resultSources:[{kind:'url',url:urls[0],authScope:'connection',mediaKind:'video'}]})},worker:{fetchImpl:async(url,init)=>{calls.push({url,authorization:init.headers.Authorization});return calls.length<3?new Response(null,{status:302,headers:{location:urls[calls.length]}}):new Response(video);}}});
    const id=f.enqueue();await until(()=>f.service.get(id).status==='completed');assert.deepEqual(calls.map(item=>item.authorization),['Bearer '+f.key,undefined,undefined]);
    const publicState=JSON.stringify({task:f.service.get(id),events:f.store.events(id)});assert.equal(publicState.includes('signature'),false);assert.equal(publicState.includes(f.key),false);
});
test('cross-origin auth scope, private redirects and encoded credential URL are rejected without leaking Key',async t=>{
    const sent=[];const f=await setup(t,{worker:{fetchImpl:async(url,init)=>{sent.push(init.headers.Authorization);return new Response(video);}}});
    const task={connection_version_id:f.snapshot().connectionVersionId};
    await assert.rejects(f.worker(task,[{kind:'url',url:'https://cdn.invalid/file',authScope:'connection'}]),{code:'DOWNLOAD_FORBIDDEN'});assert.equal(sent.length,0);
    const encoded=[...f.key].map(char=>'%'+char.charCodeAt(0).toString(16)).join('');
    await assert.rejects(f.worker(task,[{kind:'url',url:'https://provider.invalid/v1/file?x='+encoded,authScope:'connection'}]),{code:'DOWNLOAD_FORBIDDEN'});assert.equal(sent.length,0);
    for(const address of['127.0.0.1','10.1.1.1','172.31.1.1','192.168.1.1','169.254.1.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(privateAddress(address),true);
});
test('actual production URL policy rejects private/downgrade redirects before a second transport call',async t=>{
    const f=await setup(t),task={connection_version_id:f.snapshot().connectionVersionId};
    for(const location of['https://127.0.0.1/private','https://[::1]/private','http://203.0.113.1/downgrade']){
        let calls=0;const worker=createDownloadWorker({store:f.store,connections:f.connections,fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}});
        await assert.rejects(worker(task,[{kind:'url',url:'https://203.0.113.1/result',authScope:'none',mediaKind:'video'}]),{code:'DOWNLOAD_FORBIDDEN'});assert.equal(calls,1);
    }
});
test('cleared original version pauses download and never selects another connection; no transport call',async t=>{
    let calls=0;const f=await setup(t,{worker:{fetchImpl:async()=>{calls++;return new Response(video);}},service:{downloadWorker:null}}),id=f.enqueue();await until(()=>f.service.get(id).status==='remote_completed');f.credential(false);await f.restart();await until(()=>f.service.get(id).status==='download_failed');assert.equal(f.service.get(id).taskError.code,'CREDENTIAL_REQUIRED');assert.equal(calls,0);assert.equal(f.submits,1);
});
for(const item of[{name:'JSON 伪 MP4',code:'MEDIA_INVALID',response:()=>new Response('{"error":"not media"}',{headers:{'content-type':'video/mp4'}})},
    {name:'字节数短缺',code:'DOWNLOAD_INCOMPLETE',response:()=>new Response(video,{headers:{'content-length':String(video.length+10)}})},
    {name:'断流',code:'DOWNLOAD_INCOMPLETE',response:()=>new Response(new ReadableStream({start(controller){controller.enqueue(video.subarray(0,30));controller.error(new TypeError('stream error'));}}))},
    {name:'超预算',code:'DOWNLOAD_TOO_LARGE',response:()=>new Response(video,{headers:{'content-length':String(101*1024*1024)}})}])test(item.name+' has explicit download_failed; retry is download only',async t=>{
    let broken=true;const f=await setup(t,{worker:{fetchImpl:async()=>broken?item.response():new Response(video)}}),id=f.enqueue();await until(()=>f.service.get(id).status==='download_failed');assert.equal(f.service.get(id).taskError.code,item.code);assert.equal(f.service.get(id).outputAssets.length,0);
    broken=false;f.service.action(id,'retry-download');await until(()=>f.service.get(id).status==='completed');assert.equal(f.submits,1);assert.equal(f.polls,0);
});
test('signed synchronous URL is handed off only in memory; restart explains no-ID expiry without POST',async t=>{
    const signed='https://cdn.invalid/file.mp4?signature=synthetic-sensitive';
    const f=await setup(t,{adapter:{submit:async()=>({resultSources:[{kind:'url',url:signed,mediaKind:'video'}]})},service:{downloadWorker:null}}),id=f.enqueue();await until(()=>f.service.get(id).status==='remote_completed');
    const stored=f.db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json;assert.equal(stored.includes('signature'),false);assert.equal(stored.includes('cdn.invalid'),false);
    await f.restart();assert.equal(f.service.get(id).status,'download_failed');assert.equal(f.service.get(id).taskError.code,'RESULT_NOT_RECOVERABLE');assert.equal(f.submits,1);assert.equal(f.polls,0);
});
test('same-session signed URL and inline PNG both reach verified local output without URL/base64 exposure',async t=>{
    const f=await setup(t,{adapter:{submit:async()=>({resultSources:[{kind:'url',url:'https://cdn.invalid/file?sig=ephemeral',mediaKind:'video'}]})}}),id=f.enqueue();await until(()=>f.service.get(id).status==='completed');
    assert.equal(f.db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json.includes('sig='),false);
    f.implementation.submit=async()=>({resultSources:[{kind:'inline',bytes:png,mimeType:'image/png'}]});const image=f.enqueue(f.snapshot({mode:'image.text'}));await until(()=>f.service.get(image).status==='completed');assert.equal(f.service.get(image).outputAssets[0].kind,'image');assert.equal(JSON.stringify(f.service.get(image)).includes(png.toString('base64')),false);
});
test('restart with ID refreshes signed result by original read-only ID and downloads; never creates again',async t=>{
    const f=await setup(t,{adapter:{submit:async()=>({upstreamTaskId:'original/中文',resultSources:[{kind:'url',url:'https://cdn.invalid/v?sig=old',mediaKind:'video'}]}),poll:async task=>{assert.equal(task.upstream_task_id,'original/中文');return {remoteState:'completed',resultSources:[{kind:'url',url:'https://cdn.invalid/v?sig=new',mediaKind:'video'}]};}},service:{downloadWorker:null}}),id=f.enqueue();await until(()=>f.service.get(id).status==='remote_completed');
    await f.restart();await until(()=>f.service.get(id).status==='completed');assert.equal(f.submits,1);assert.equal(f.polls,1);assert.equal(f.db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json.includes('sig='),false);
});
test('expired URL refresh obeys long Retry-After and explicit retry never queries too early',async t=>{
    const f=await setup(t,{adapter:{submit:async()=>({upstreamTaskId:'original',resultSources:[{kind:'url',url:'https://cdn.invalid/expired',mediaKind:'video'}]}),poll:async()=>{throw Object.assign(new Error(),{httpStatus:429,retryAfter:'300'});}},worker:{fetchImpl:async()=>new Response(null,{status:410})}}),id=f.enqueue();await until(()=>f.service.get(id).status==='download_failed');
    assert.equal(f.service.get(id).taskError.code,'RATE_LIMITED');assert.throws(()=>f.service.action(id,'retry-download'),{code:'POLL_NOT_BEFORE'});await f.restart();assert.throws(()=>f.service.action(id,'retry-download'),{code:'POLL_NOT_BEFORE'});assert.equal(f.submits,1);assert.equal(f.polls,1);
});
test('missing/corrupt files preserve records; selected output roots freeze and default change does not retarget old intent',async t=>{
    const f=await setup(t),a=path.join(f.directory,'中文 a'),b=path.join(f.directory,'目录 b');fs.mkdirSync(a);fs.mkdirSync(b);
    const first=f.store.selectOutputDirectory(a),input=f.snapshot(),id=f.enqueue(input);await until(()=>f.service.get(id).status==='completed');const asset=f.service.get(id).outputAssets[0];assert.ok(f.store.resolveAssetPath(asset.assetId).startsWith(fs.realpathSync.native(a)+path.sep));
    f.store.selectOutputDirectory(b);assert.equal(f.enqueue(input),id);const second=f.enqueue();await until(()=>f.service.get(second).status==='completed');assert.ok(f.store.resolveAssetPath(f.service.get(second).outputAssets[0].assetId).startsWith(fs.realpathSync.native(b)+path.sep));
    assert.equal(f.db.prepare('SELECT output_root_ref FROM tasks WHERE id=?').get(id).output_root_ref,first.outputRootRef);
    const file=f.store.resolveAssetPath(asset.assetId);fs.writeFileSync(file,'corrupt');assert.throws(()=>f.store.readAsset(asset.assetId),{code:'ASSET_CORRUPT'});assert.equal(f.service.get(id).outputAssets[0].availability,'corrupt');fs.writeFileSync(file,video);assert.equal(f.store.readAsset(asset.assetId).asset.availability,'available');fs.unlinkSync(file);assert.throws(()=>f.store.readAsset(asset.assetId),{code:'ASSET_MISSING'});assert.equal(f.service.get(id).outputAssets[0].availability,'missing');
});
test('disappeared output root fails without creating a replacement or retargeting a saved task',async t=>{
    const f=await setup(t,{service:{downloadWorker:null}}),selected=path.join(f.directory,'removed-volume');fs.mkdirSync(selected);const version=f.store.selectOutputDirectory(selected),id=f.enqueue();await until(()=>f.service.get(id).status==='remote_completed');fs.rmdirSync(selected);
    await f.restart();await until(()=>f.service.get(id).status==='download_failed');assert.equal(f.service.get(id).taskError.code,'DIRECTORY_NOT_WRITABLE');assert.equal(fs.existsSync(selected),false);assert.equal(f.service.get(id).outputRootRef,version.outputRootRef);
});
test('asset binding/completed transaction failure rolls back outputs and retry only downloads',async t=>{
    const f=await setup(t);f.db.exec("CREATE TRIGGER b2_completion_failure BEFORE UPDATE OF status ON tasks WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DB_FAILURE');END;");const id=f.enqueue();await until(()=>f.service.get(id).status==='download_failed');assert.equal(f.service.get(id).outputAssets.length,0);assert.equal(f.db.prepare('SELECT state FROM task_downloads WHERE task_id=?').get(id).state,'failed');
    f.db.exec('DROP TRIGGER b2_completion_failure');f.service.action(id,'retry-download');await until(()=>f.service.get(id).status==='completed');assert.equal(f.submits,1);
});
test('output-directory transaction failure leaves prior default and version count intact',async t=>{
    const f=await setup(t),before=f.store.outputDirectory(),count=f.db.prepare('SELECT count(*) n FROM storage_roots').get().n,selected=path.join(f.directory,'selection');fs.mkdirSync(selected);
    f.db.exec("CREATE TRIGGER b2_directory_failure BEFORE INSERT ON output_directory_versions BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DB_FAILURE');END;");assert.throws(()=>f.store.selectOutputDirectory(selected));assert.deepEqual(f.store.outputDirectory(),before);assert.equal(f.db.prepare('SELECT count(*) n FROM storage_roots').get().n,count);
});
for(const [errno,code]of[['ENOSPC','DISK_FULL'],['EBUSY','FILE_BUSY'],['EACCES','DIRECTORY_NOT_WRITABLE'],['ENAMETOOLONG','PATH_TOO_LONG']])test('publication '+errno+' preserves explicit status and no completed output',async t=>{
    const f=await setup(t);f.store.publishVerifiedFile=()=>{throw Object.assign(new Error(),{code:errno});};const id=f.enqueue();await until(()=>f.service.get(id).status==='download_failed');assert.equal(f.service.get(id).taskError.code,code);assert.equal(f.service.get(id).outputAssets.length,0);
});
test('save copy uses only resolved asset and OS target, atomically overwrites confirmed file; cancel and reveal are separate',async t=>{
    const f=await setup(t),asset=f.store.importBuffer(png,{mimeType:'image/png'}),target=path.join(f.directory,'中文 副本.png');fs.writeFileSync(target,'old');let canceled=false,revealed;
    const actions=createAssetActions({getStore:()=>f.store,getWindow:()=>null,shell:{showItemInFolder:file=>{revealed=file;}},dialog:{showSaveDialog:async()=>({canceled,filePath:target})}});
    assert.equal((await actions.save(asset.assetId)).ok,true);assert.deepEqual(fs.readFileSync(target),png);assert.equal((await actions.reveal(asset.assetId)).ok,true);assert.equal(revealed,f.store.resolveAssetPath(asset.assetId));
    canceled=true;assert.equal((await actions.save(asset.assetId)).cancelled,true);await assert.rejects(actions.save('../arbitrary'),{code:'INVALID_ID'});
});
test('single byte ranges include suffix/open bounds and reject invalid/multi/unsatisfiable forms',()=>{
    assert.deepEqual(rangeFor('bytes=2-4',10),{start:2,end:4});assert.deepEqual(rangeFor('bytes=-3',10),{start:7,end:9});assert.deepEqual(rangeFor('bytes=8-',10),{start:8,end:9});assert.deepEqual(rangeFor('bytes=0-100',10),{start:0,end:9});
    for(const value of['bytes=10-','bytes=4-2','bytes=-0','bytes=0-1,3-4','other=1-2','bytes=-'])assert.equal(rangeFor(value,10),false);
});
test('v4 to v5 keeps referenced asset IDs, foreign keys, immutable old SQL and upgrade backup',async t=>{
    const f=await setup(t),file=path.join(f.directory,'v4.sqlite'),db=new Database(file);try{
        await migrateDatabase({db,dbPath:file,migrations:MIGRATIONS.slice(0,4)});const asset=randomUUID(),task=randomUUID();
        db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(task,'completed','image.text','{}','2026-01-01');
        db.prepare('INSERT INTO assets(id,kind,storage_key,display_name,mime_type,byte_length,sha256,source_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(asset,'image','aa/'+'a'.repeat(64)+'.png','old','image/png',20,'a'.repeat(64),'generated','2026-01-01');
        db.prepare('INSERT INTO task_assets VALUES(?,?,?,?)').run(task,asset,'output',0);const old=db.prepare('SELECT version,checksum FROM schema_migrations').all();const result=await migrateDatabase({db,dbPath:file});
        assert.deepEqual(result.applied,[5]);assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<5').all(),old);assert.equal(db.prepare('SELECT asset_id FROM task_assets').get().asset_id,asset);assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('quick_check',{simple:true}),'ok');
        assert.throws(()=>db.prepare('INSERT INTO assets SELECT ?,kind,storage_key,display_name,mime_type,byte_length,sha256,width,height,duration_seconds,source_kind,validation_state,availability,created_at,root_ref FROM assets WHERE id=?').run(randomUUID(),asset),/UNIQUE/);
    }finally{db.close();}
});
