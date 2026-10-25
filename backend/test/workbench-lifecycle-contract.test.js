'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { migrateDatabase, MIGRATIONS } = require('../storage/migrations');
const { createWorkbenchStore } = require('../storage/store');
const { createTaskService } = require('../tasks/service');
const { MODES, mediaKind, DEFAULT_EXECUTION_SETTINGS, validateExecutionSettings, executionSnapshot } = require('../tasks/lifecycle-contract');
const hash = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for(let i=0;i<100;i++) { if(fn())return;await tick(); }throw Error('fixture did not settle'); }
async function fixture(t, version = MIGRATIONS.length) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-i01-'));
    const dbPath = path.join(directory, 'tasks.sqlite'), db = new Database(dbPath);
    await migrateDatabase({ db, dbPath, migrations: MIGRATIONS.slice(0, version) });
    const store = createWorkbenchStore({ db, rootDirectory: path.join(directory,'storage') });
    const connection = randomUUID(), connectionVersionId = randomUUID();
    db.prepare('INSERT INTO connections(id,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(connection,'fixture','2026-10-25','2026-10-25');
    db.prepare('INSERT INTO connection_versions(id,connection_id,base_url,provider,created_at) VALUES(?,?,?,?,?)').run(connectionVersionId,connection,'https://fixture.invalid/v1','fixture','2026-10-25');
    const services = [];
    t.after(async () => {
        for(const service of services)await service.close();
        if(db.open)db.close();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));
        fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    });
    let time = Date.parse('2026-10-25T00:00:00Z'), submits=0, authCalls=0, available=true;
    const snapshot = (mode='image.text',extra={}) => ({ contractVersion:1,localRequestId:randomUUID(),connectionVersionId,mode,model:'fixture',prompt:'synthetic',parameters:{},inputAssets:[],adapterId:'fixture',adapterVersion:'1',...extra });
    const service = (overrides={}) => {
        const instance=createTaskService({db,store,now:()=>time,connections:{getAuth(){authCalls++;if(!available)throw Object.assign(Error('fixture revoked'),{code:'CREDENTIAL_REQUIRED'});return{apiKey:'synthetic-i01-key'};}},resolveAdapter:()=>({id:'fixture',version:'1',...overrides,async submit(...args){submits++;return overrides.submit?overrides.submit(...args):{upstreamTaskId:'fixture-id-'+submits};},poll:async()=>({remoteState:'generating',rawStatus:'rendering'})})});
        services.push(instance);return instance;
    };
    function insertLegacy(input,status='local_queued',fields={}) {
        const id=randomUUID();db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id,status,input.mode,'{}',new Date(time).toISOString());
        store.setTaskSnapshot(id,store.freezeOutputDirectory(input));
        if(Object.keys(fields).length)db.prepare('UPDATE tasks SET '+Object.keys(fields).map(key=>key+'=?').join(',')+' WHERE id=?').run(...Object.values(fields),id);
        return id;
    }
    return {db,dbPath,directory,store,snapshot,service,insertLegacy,advance(ms){time+=ms;},revoke(){available=false;},get submits(){return submits;},get authCalls(){return authCalls;}};
}
test('I01 exact image/video classification and finite integer settings reject coercion and unknown fields',()=>{
    for(const [mode,kind] of Object.entries(MODES)) assert.equal(mediaKind(mode),kind);
    for(const mode of ['text-to-image','image-to-image']) assert.equal(mediaKind(mode),'image');
    for(const mode of ['plugin','legacy.plugin']) assert.equal(mediaKind(mode),'video');
    for(const mode of ['video.unverified','audio.text','toString','__proto__',null])assert.equal(mediaKind(mode),null);
    assert.throws(()=>executionSnapshot('audio.text',DEFAULT_EXECUTION_SETTINGS),{code:'INVALID_TASK_MODE'});
    assert.deepEqual(validateExecutionSettings(DEFAULT_EXECUTION_SETTINGS),{imageConcurrency:3,videoConcurrency:3,imageTimeoutSeconds:120,videoTimeoutSeconds:300,imageDownloadTimeoutSeconds:30,videoDownloadTimeoutSeconds:180});
    for(const key of Object.keys(DEFAULT_EXECUTION_SETTINGS)) {
        const concurrency=key.endsWith('Concurrency'), min=concurrency?1:30,max=concurrency?5:1800;
        for(const value of [min,max])assert.equal(validateExecutionSettings({...DEFAULT_EXECUTION_SETTINGS,[key]:value})[key],value);
        for(const value of [min-1,max+1,1.5,NaN,Infinity,-Infinity,'3',null,undefined,true])assert.throws(()=>validateExecutionSettings({...DEFAULT_EXECUTION_SETTINGS,[key]:value}),{code:'INVALID_SETTING_VALUE'});
    }
    for(const value of [null,[],{},Object.create(DEFAULT_EXECUTION_SETTINGS),{...DEFAULT_EXECUTION_SETTINGS,extra:1}])assert.throws(()=>validateExecutionSettings(value),{code:'INVALID_SETTING_VALUE'});
});
test('I01 taskExecution defaults are read-only, writes are revisioned, and invalid values never change persisted config',async t=>{
    const f=await fixture(t);
    assert.deepEqual(f.store.getSetting('taskExecution'),{key:'taskExecution',value:{...DEFAULT_EXECUTION_SETTINGS},revision:0,updatedAt:null});
    assert.equal(f.db.prepare("SELECT count(*) n FROM app_settings WHERE key='taskExecution'").get().n,0);
    const value={imageConcurrency:1,videoConcurrency:5,imageTimeoutSeconds:30,videoTimeoutSeconds:1800};
    const saved=f.store.putSetting('taskExecution',{value,expectedRevision:0});assert.equal(saved.revision,1);
    assert.throws(()=>f.store.putSetting('taskExecution',{value:{...value,imageTimeoutSeconds:'120'},expectedRevision:1}),{code:'INVALID_SETTING_VALUE'});
    assert.throws(()=>f.store.putSetting('taskExecution',{value,expectedRevision:0}),{code:'SETTING_REVISION_CONFLICT'});
    assert.deepEqual(f.store.getSetting('taskExecution'),saved);
    assert.deepEqual(createWorkbenchStore({db:f.db,rootDirectory:path.join(f.directory,'storage')}).getSetting('taskExecution'),saved);
});
test('I01 v6 A-shaped WAL database upgrades with readable hashed backup, no rewrites, no network and no invented legacy budgets',async t=>{
    const f=await fixture(t,6), input=f.snapshot(), queued=f.insertLegacy(input);
    const unknown=f.insertLegacy(f.snapshot('image.reference'),'submission_unknown',{dispatch_started_at:'2026-10-24T23:19:00Z'});
    const paused=f.insertLegacy(f.snapshot('video.single_reference'),'polling_paused',{dispatch_started_at:'2026-10-24T23:19:00Z',upstream_task_id:'realistic-opaque-id',remote_state:'generating',pause_reason:'user_stopped'});
    const done=f.insertLegacy(f.snapshot('video.dual_reference'),'completed',{completed_at:'2026-10-24T23:19:10Z',remote_state:'completed'});
    const asset=f.store.importBuffer(fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png')),{mimeType:'image/png'});
    f.store.bindTaskAssets(done,[{assetId:asset.assetId,position:0,role:'reference'}],'output');
    f.db.prepare('INSERT INTO workbench_hidden_tasks VALUES(?,?)').run(done,'2026-10-24');
    f.db.pragma('journal_mode=WAL');
    const before=f.db.prepare('SELECT * FROM tasks ORDER BY id').all(),events=f.db.prepare('SELECT * FROM task_events ORDER BY id').all();
    const history=f.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    const priorFetch=global.fetch;let requests=0;global.fetch=()=>{requests++;throw Error('network forbidden in I01');};t.after(()=>{global.fetch=priorFetch;});
    const result=await migrateDatabase({db:f.db,dbPath:f.dbPath});assert.deepEqual(result.applied,MIGRATIONS.slice(6).map(item=>item.version));assert.equal(requests,0);
    const after=f.db.prepare('SELECT * FROM tasks ORDER BY id').all();
    assert.deepEqual(after.map(row=>Object.fromEntries(Object.keys(before[0]).map(key=>[key,row[key]]))),before);
    for(const row of after)for(const key of ['execution_media_kind','execution_timeout_seconds','execution_attempt_id','execution_deadline_at','local_outcome','local_finished_at','remote_outcome','execution_phase','execution_phase_started_at'])assert.equal(row[key],null);
    assert.deepEqual(f.db.prepare('SELECT * FROM task_events ORDER BY id').all(),events);
    assert.deepEqual(f.db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=6 ORDER BY version').all(),history);
    assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
    const manifest=JSON.parse(fs.readFileSync(result.backupFile+'.json','utf8'));assert.equal(manifest.fromVersion,6);assert.equal(manifest.toVersion,MIGRATIONS.at(-1).version);assert.equal(manifest.sha256,hash(fs.readFileSync(result.backupFile)));
    const backup=new Database(result.backupFile,{readonly:true,fileMustExist:true});try{assert.equal(backup.pragma('quick_check',{simple:true}),'ok');assert.deepEqual(backup.prepare('SELECT * FROM tasks ORDER BY id').all(),before);}finally{backup.close();}
    assert.equal(f.db.prepare('SELECT count(*) n FROM workbench_hidden_tasks WHERE task_id=?').get(done).n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM workbench_removed_tasks').get().n,0);
    assert.equal(f.store.listTasks().items.some(task=>task.id===done),false);assert.equal(f.store.getTask(done).outputAssets[0].assetId,asset.assetId);
    const service=f.service();f.revoke();assert.equal(service.enqueue({snapshot:input,mode:input.mode,request:{}}),queued);assert.equal(f.authCalls,0);assert.equal(f.submits,0);
    assert.throws(()=>service.findDuplicate({...input,prompt:'changed'}),{code:'LOCAL_REQUEST_CONFLICT'});
    assert.throws(()=>f.db.prepare('UPDATE tasks SET input_snapshot_json=? WHERE id=?').run('{}',queued),/IMMUTABLE_TASK_SNAPSHOT/);
    assert.throws(()=>f.db.prepare('UPDATE tasks SET execution_timeout_seconds=120 WHERE id=?').run(unknown),/IMMUTABLE_EXECUTION_SNAPSHOT/);
    assert.equal(service.get(paused).upstreamTaskId,'realistic-opaque-id');assert.equal(service.get(paused).remoteOutcome,'unknown');
    assert.deepEqual(await migrateDatabase({db:f.db,dbPath:f.dbPath}),{applied:[],backupFile:null});
});
test('I01 historical migrations 1-6 keep their exact released SQL checksums',()=>{
    assert.deepEqual(MIGRATIONS.slice(0,6).map(item=>hash(item.sql)),[
        '64593c5018c5825b3f5d6fa6bd23f2028df60fb476a87b2e5025ab05c955563a',
        'df634e04b0959b15a81b6a1b51bd4ec5fc9978a6a917c5f489c0579ffd3b112c',
        '8b1ff8d3ff5812db2c0f1cda52757d0647266b368f63920dae0129491c507c55',
        '85e28957d4d41c9b32096a2d65c98fc887e58cb652045a6d3f94ef1aee932dc4',
        'e831d4c16266f501b9b3ecfaefe2f53b2c5a9452da3408c6c0218ed09a46f747',
        '7599c3b37696e0a8de6d66b0c16fa8095f975d40502a1c60e623ef2ca6f7ccb2',
    ]);
});
test('I01 v7 DDL and history roll back atomically on failure with a usable pre-upgrade backup',async t=>{
    const f=await fixture(t,6),id=f.insertLegacy(f.snapshot());let failure;
    try{await migrateDatabase({db:f.db,dbPath:f.dbPath,migrations:[...MIGRATIONS,{version:8,name:'synthetic-failure',sql:'THIS IS INVALID SQL;'}]});}catch(error){failure=error;}
    assert.equal(failure.code,'STORAGE_MIGRATION_FAILED');assert.equal(f.db.prepare('SELECT max(version) n FROM schema_migrations').get().n,6);
    assert.equal(f.db.prepare('PRAGMA table_info(tasks)').all().some(column=>column.name==='execution_timeout_seconds'),false);
    assert.equal(f.db.prepare('SELECT id FROM tasks WHERE id=?').get(id).id,id);
    const backup=new Database(failure.backupFile,{readonly:true});try{assert.equal(backup.pragma('quick_check',{simple:true}),'ok');assert.equal(backup.prepare('SELECT id FROM tasks WHERE id=?').get(id).id,id);}finally{backup.close();}
});
test('I01 every new mode snapshots its own timeout without modifying immutable input or enabling dispatch',async t=>{
    const f=await fixture(t),service=f.service();
    for(const mode of [...Object.keys(MODES),'legacy.plugin']){
        const input=f.snapshot(mode),id=service.enqueue({snapshot:input,mode:mode==='legacy.plugin'?'plugin':mode,request:{}});
        const task=service.get(id);assert.equal(task.mediaKind,mediaKind(mode));assert.equal(task.timeoutSeconds,mediaKind(mode)==='image'?120:300);
        assert.equal(task.executionAttemptId,null);assert.equal(task.deadlineAt,null);assert.equal(task.dispatchStartedAt,null);
        const saved=JSON.parse(f.db.prepare('SELECT input_snapshot_json FROM tasks WHERE id=?').get(id).input_snapshot_json);assert.equal(saved.timeoutSeconds,undefined);
        assert.throws(()=>f.db.prepare('UPDATE tasks SET execution_timeout_seconds=90 WHERE id=?').run(id),/IMMUTABLE_EXECUTION_SNAPSHOT/);
        service.action(id,'cancel-queued');
    }
    await tick();assert.equal(f.submits,0);
});
test('I01 dispatch sets one attempt/deadline from the creation snapshot after queue time; setting changes and replay preserve it',async t=>{
    const f=await fixture(t);let release,entered=false;
    const service=f.service({preflight:async()=>{entered=true;await new Promise(resolve=>{release=resolve;});}});
    const input=f.snapshot(),id=service.enqueue({snapshot:input,mode:'text-to-image',request:{}});
    await until(()=>entered);
    f.store.putSetting('taskExecution',{value:{imageConcurrency:5,videoConcurrency:1,imageTimeoutSeconds:90,videoTimeoutSeconds:450}});
    f.advance(60000);release();await until(()=>service.get(id).executionAttemptId);
    const task=service.get(id);assert.equal(task.timeoutSeconds,120);assert.equal(task.dispatchStartedAt,'2026-10-25T00:01:00.000Z');assert.equal(task.deadlineAt,'2026-10-25T00:03:00.000Z');assert.match(task.executionAttemptId,/^[a-f0-9-]{36}$/);
    assert.throws(()=>f.db.prepare('UPDATE tasks SET execution_deadline_at=? WHERE id=?').run('2026-10-25T00:04:00Z',id),/IMMUTABLE_EXECUTION_BOUNDARY/);
    assert.throws(()=>f.db.prepare('UPDATE tasks SET execution_attempt_id=? WHERE id=?').run(randomUUID(),id),/IMMUTABLE_EXECUTION_BOUNDARY/);
    const next=f.snapshot('video.text'),second=service.enqueue({snapshot:next,mode:next.mode,request:{}});assert.equal(service.get(second).timeoutSeconds,450);assert.equal(service.get(second).deadlineAt,null);
    f.revoke();assert.equal(service.enqueue({snapshot:{...input,localRequestId:input.localRequestId.toUpperCase()},mode:'text-to-image',request:{}}),id);assert.equal(service.get(id).executionAttemptId,task.executionAttemptId);assert.equal(f.submits,1);
    await service.close();const reopened=f.service();assert.equal(reopened.get(id).deadlineAt,task.deadlineAt);assert.equal(reopened.findDuplicate(input),id);
});
test('I01 service/history/list share lifecycle semantics, separate local timeout/cancel/download failure from unknown remote outcome and expose no source',async t=>{
    const f=await fixture(t),service=f.service(),newLegacy=()=>f.insertLegacy(f.snapshot('video.text'),'submission_unknown',{dispatch_started_at:'2026-10-24T23:19:00Z',upstream_task_id:'preserved-id',result_sources_json:JSON.stringify([{kind:'url',url:'https://fixture.invalid/result?token=synthetic-secret'}])});
    for(const outcome of ['timed_out','cancelled']){
        const id=newLegacy();
        f.db.prepare("UPDATE tasks SET local_outcome=?,local_finished_at=?,execution_phase='receiving',execution_phase_started_at=? WHERE id=?").run(outcome,'2026-10-25T00:00:01Z','2026-10-24T23:19:01Z',id);
        const task=service.get(id);assert.deepEqual(task,f.store.getTask(id));assert.deepEqual(task,f.store.listTasks().items.find(item=>item.id===id));
        assert.equal(task.localOutcome,outcome);assert.equal(task.remoteOutcome,'unknown');assert.equal(task.remoteMayContinue,true);assert.equal(task.generationReserved,false);assert.equal(task.upstreamTaskId,'preserved-id');assert.equal(task.timeoutSeconds,null);assert.equal(task.deadlineAt,null);assert.equal(task.phase,'receiving');
        assert.equal(JSON.stringify(task).includes('synthetic-secret'),false);assert.equal(JSON.stringify(task).includes('https://fixture.invalid'),false);
    }
    const id=newLegacy();
    f.db.prepare("UPDATE tasks SET status='download_failed',local_outcome=NULL,remote_state='completed' WHERE id=?").run(id);
    assert.equal(service.get(id).localOutcome,'failed');assert.equal(service.get(id).remoteOutcome,'confirmed_result');assert.equal(service.get(id).generationReserved,false);assert.equal(service.get(id).remoteMayContinue,false);
    f.db.prepare("UPDATE tasks SET status='failed',remote_state=NULL,task_error_json=? WHERE id=?").run(JSON.stringify({code:'AUTH_REJECTED',transmission:'not_applicable'}),id);
    assert.equal(service.get(id).remoteOutcome,'unknown');
    f.db.prepare('UPDATE tasks SET task_error_json=? WHERE id=?').run(JSON.stringify({code:'AUTH_REJECTED',transmission:'response_received'}),id);
    assert.equal(service.get(id).remoteOutcome,'confirmed_rejected');
    f.db.prepare('UPDATE tasks SET task_error_json=?,error=? WHERE id=?').run('malformed legacy metadata','synthetic-secret',id);
    assert.equal(service.get(id).taskError,null);assert.equal(service.get(id).error,null);assert.deepEqual(service.get(id),f.store.getTask(id));
    f.db.prepare("UPDATE tasks SET status='toString',remote_state='__proto__' WHERE id=?").run(id);
    assert.equal(service.get(id).localOutcome,null);assert.equal(service.get(id).remoteOutcome,'unknown');
});

test('D01 legacy writes preserve configured download budgets and revision; partial new schema is rejected',async t=>{
 const f=await fixture(t),defaults=f.store.getSetting('taskExecution');let setting=f.store.putSetting('taskExecution',{value:{...defaults.value,imageDownloadTimeoutSeconds:75,videoDownloadTimeoutSeconds:800},expectedRevision:0});
 const legacy={imageConcurrency:2,videoConcurrency:4,imageTimeoutSeconds:90,videoTimeoutSeconds:500};setting=f.store.putSetting('taskExecution',{value:legacy,expectedRevision:setting.revision});assert.equal(setting.value.imageDownloadTimeoutSeconds,75);assert.equal(setting.value.videoDownloadTimeoutSeconds,800);assert.equal(setting.value.imageTimeoutSeconds,90);
 assert.throws(()=>f.store.putSetting('taskExecution',{value:legacy,expectedRevision:0}),{code:'SETTING_REVISION_CONFLICT'});assert.throws(()=>f.store.putSetting('taskExecution',{value:{...legacy,imageDownloadTimeoutSeconds:50},expectedRevision:setting.revision}),{code:'INVALID_SETTING_VALUE'});
});

test('D01 v8 migration retains attempt rowid order, timestamps and original checksum history',async t=>{
 const f=await fixture(t,8),id=f.insertLegacy(f.snapshot(),'download_failed'),at='2026-10-25T00:00:00Z';
 const ids=[randomUUID(),randomUUID(),randomUUID()];for(const [index,attempt] of ids.entries())f.db.prepare("INSERT INTO task_download_attempts(rowid,id,task_id,started_at,deadline_at,timeout_seconds,outcome,finished_at) VALUES(?,?,?,?,?,?,?,?)").run([3,9,20][index],attempt,id,at,'2026-10-25T00:02:00Z',120,'failed',at);
 const before=f.db.prepare('SELECT rowid,* FROM task_download_attempts ORDER BY rowid').all(),history=f.db.prepare('SELECT version,checksum FROM schema_migrations').all();await migrateDatabase({db:f.db,dbPath:f.dbPath});
 const after=f.db.prepare('SELECT rowid,id,task_id,started_at,deadline_at,timeout_seconds,outcome,finished_at FROM task_download_attempts ORDER BY rowid').all();assert.deepEqual(after,before);assert.deepEqual(f.db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=8').all(),history);assert.equal(f.store.getTask(id).downloadAttempt.id,ids[2]);assert.equal(f.store.getTask(id).downloadAttempt.attemptNumber,3);assert.equal(f.store.getTask(id).lifecycleVersion,1);
});
