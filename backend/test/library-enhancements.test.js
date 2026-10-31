'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID,createHash}=require('node:crypto'),Database=require('better-sqlite3');
const {migrateDatabase}=require('../storage/migrations'),{createWorkbenchStore}=require('../storage/store'),{DEFAULT_GROUP}=require('../storage/groups');
const {createPreviewReader}=require('../storage/preview-reader'),{start}=require('./support/desktop-http-runtime.cjs');
const png=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png'));
async function fixture(t){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-library-enhance-')),dbPath=path.join(directory,'tasks.sqlite'),db=new Database(dbPath);
    await migrateDatabase({db,dbPath});
    const store=createWorkbenchStore({db,rootDirectory:path.join(directory,'storage')}),asset=store.importBuffer(png,{mimeType:'image/png',sourceKind:'generated',validation:{width:1,height:1}}),f={directory,db,store,asset};
    t.after(async()=>{if(f.runtime)await f.runtime.stop();if(db.open)db.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});});
    return f;
}
function save(f,createdAt,{groupId=DEFAULT_GROUP,mode='image.text',prompt='海边',model='synthetic'}={}){
    const id=randomUUID(),snapshot=f.store.freezeOutputDirectory({contractVersion:1,localRequestId:randomUUID(),mode,model,prompt,parameters:{},inputAssets:[],groupId});
    f.db.prepare('INSERT INTO tasks(id,status,mode,request_json,created_at) VALUES(?,?,?,?,?)').run(id,'failed',mode,'{}',createdAt);
    f.store.setTaskSnapshot(id,snapshot);
    f.db.prepare("INSERT INTO task_downloads(task_id,state,created_at,updated_at) VALUES(?,'waiting','2026-10-31','2026-10-31')").run(id);
    f.store.bindTaskAssets(id,[{assetId:f.asset.assetId,position:0,role:'reference'}],'output');
    f.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(id);
    f.db.prepare("UPDATE task_downloads SET state='completed' WHERE task_id=?").run(id);
    return id;
}
test('library creation dates use half-open absolute boundaries across milliseconds and stored timezone offsets',async t=>{
    const f=await fixture(t),from='2026-10-30T16:00:00.000Z',before='2026-10-31T16:00:00.000Z';
    save(f,'2026-10-30T15:59:59.999Z');
    const ids=[save(f,'2026-10-30T16:00:00Z'),save(f,'2026-10-31T00:00:00.000+08:00'),save(f,'2026-10-31T23:59:59.999+08:00')];
    save(f,'2026-10-31T16:00:00Z');
    const result=f.store.listTasks({scope:'library',createdFrom:from,createdBefore:before});
    assert.deepEqual(new Set(result.items.map(item=>item.id)),new Set(ids));assert.equal(result.total,3);assert.equal(result.unfilteredTotal,5);
    assert.equal(f.store.listTasks({scope:'library',createdFrom:before}).total,1);
    assert.equal(f.store.listTasks({scope:'library',createdBefore:from}).total,1);
    assert.equal(f.store.listTasks({scope:'library'}).total,5);
});
test('library creation dates are applied before pagination and combine with group/type/search without changing base counts',async t=>{
    const f=await fixture(t),group=f.store.createGroup({name:'日期分页'}),other=f.store.createGroup({name:'其他'}),expected=[];
    for(let i=0;i<39;i++){
        const inRange=i%3!==0,kind=i%2===0?'image':'video',groupId=i<35?group.groupId:other.groupId;
        const id=save(f,(inRange?'2026-10-31':'2026-10-29')+'T01:'+String(i).padStart(2,'0')+':00.000Z',{groupId,mode:kind+'.text',prompt:i%5?'海边片段':'森林'});
        if(inRange&&kind==='image'&&i<35&&i%5)expected.push(id);
    }
    const query={scope:'library',groupId:group.groupId,kind:'image',search:'海边',createdFrom:'2026-10-30T16:00:00.000Z',createdBefore:'2026-10-31T16:00:00.000Z'};
    const all=f.store.listTasks({...query,limit:100}),pages=[0,3,6,9].flatMap(offset=>f.store.listTasks({...query,limit:3,offset}).items.map(item=>item.id));
    assert.deepEqual(new Set(all.items.map(item=>item.id)),new Set(expected));assert.deepEqual(pages,all.items.map(item=>item.id));
    assert.equal(all.total,expected.length);assert.equal(all.unfilteredTotal,35);
    assert.equal(f.store.groups().items.find(item=>item.groupId===group.groupId).workCount,35);
});
test('library creation bounds reject normalized-invalid dates, local timestamps and non-increasing intervals',async t=>{
    const f=await fixture(t);
    const invalid=[null,0,[],{},'2026-02-30T00:00:00Z','2026-10-31','2026-10-31T00:00:00','2026-10-31T00:00:00+08:00','2026-10-31T24:00:00Z','2026-10-31T00:00:61Z','2026-10-31T00:00:00.0000Z',' 2026-10-31T00:00:00Z','not-a-date'];
    for(const value of invalid)for(const name of ['createdFrom','createdBefore'])assert.throws(()=>f.store.listTasks({[name]:value}),{code:'INVALID_HISTORY_FILTER'},String(value));
    for(const from of ['2026-10-31T00:00:00Z','2026-11-01T00:00:00Z'])assert.throws(()=>f.store.listTasks({createdFrom:from,createdBefore:'2026-10-31T00:00:00Z'}),{code:'INVALID_HISTORY_FILTER'});
    assert.doesNotThrow(()=>f.store.listTasks({createdFrom:'2028-02-29T00:00:00Z',createdBefore:'2028-03-01T00:00:00.0Z'}));
});
test('actual protected HTTP passes creation bounds, validates them and keeps pagination totals',async t=>{
    const f=await fixture(t);save(f,'2026-10-30T16:00:00.000Z');save(f,'2026-10-31T15:59:59.999Z');save(f,'2026-10-31T16:00:00.000Z');
    f.runtime=await start(f.directory);
    const query=new URLSearchParams({scope:'library',createdFrom:'2026-10-30T16:00:00.000Z',createdBefore:'2026-10-31T16:00:00.000Z',limit:'1',offset:'1'});
    const response=await f.runtime.request('/api/nova/storage/tasks?'+query);assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.total,2);assert.equal(data.unfilteredTotal,3);assert.equal(data.items.length,1);
    for(const suffix of ['createdFrom=2026-02-30T00%3A00%3A00Z','createdBefore=garbage','createdFrom=2026-11-01T00%3A00%3A00Z&createdBefore=2026-10-31T00%3A00%3A00Z']){
        const result=await f.runtime.request('/api/nova/storage/tasks?'+suffix);assert.equal(result.status,400);assert.equal((await result.json()).code,'INVALID_HISTORY_FILTER');
    }
    assert.equal((await fetch(f.runtime.origin+'/api/nova/storage/tasks?'+query)).status,403);
});
function readerFixture(t,maxEntries=2){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-preview-reader-')),reader=createPreviewReader({maxEntries,fail:(code,message,statusCode=400)=>Object.assign(Error(message),{code,statusCode})});
    t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:30});});
    const add=(name='video',bytes=Buffer.alloc(700000,37))=>{const file=path.join(directory,name);fs.writeFileSync(file,bytes);return{file,bytes,asset:{id:name,byte_length:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};};
    return{directory,reader,add};
}
test('verified preview identity cache avoids full reads on later ranges, is bounded, and closes every per-request handle',async t=>{
    const f=readerFixture(t),source=f.add(),original=fs.promises.open,handles=[];let readBytes=0;
    fs.promises.open=async(...args)=>{const handle=await original(...args),read=handle.read.bind(handle);handle.read=async(...parts)=>{const result=await read(...parts);readBytes+=result.bytesRead;return result;};handles.push(handle);return handle;};
    try{
        let opened=await f.reader.open(source.file,source.asset);assert.deepEqual(await opened.read(100,199),source.bytes.subarray(100,200));await opened.close();await opened.close();assert.equal(opened.closed,true);assert.equal(readBytes,source.bytes.length+100);
        const after=readBytes;opened=await f.reader.open(source.file,source.asset);assert.deepEqual(await opened.read(20,59),source.bytes.subarray(20,60));await opened.close();assert.equal(readBytes-after,40);
        opened=await f.reader.open(source.file,source.asset);await opened.close();assert.equal(readBytes-after,40,'cached HEAD-style verification reads no video payload');
        for(const name of ['second','third']){const item=f.add(name);opened=await f.reader.open(item.file,item.asset);await opened.close();}
        assert.equal(f.reader.cacheSize,2);
        const evicted=readBytes;opened=await f.reader.open(source.file,source.asset);await opened.close();assert.equal(readBytes-evicted,source.bytes.length);
        assert.ok(handles.every(handle=>handle.fd===-1),'all underlying OS handles are closed');
    }finally{fs.promises.open=original;for(const handle of handles)if(handle.fd!==-1)await handle.close();}
});
test('preview verification coalesces concurrent full hashes while keeping independent short-lived handles',async t=>{
    const f=readerFixture(t),source=f.add(),original=fs.promises.open;let readBytes=0;const handles=[];
    fs.promises.open=async(...args)=>{const handle=await original(...args),read=handle.read.bind(handle);handle.read=async(...parts)=>{const result=await read(...parts);readBytes+=result.bytesRead;return result;};handles.push(handle);return handle;};
    try{const opened=await Promise.all([f.reader.open(source.file,source.asset),f.reader.open(source.file,source.asset)]);assert.equal(readBytes,source.bytes.length);for(const item of opened)await item.close();assert.ok(handles.every(handle=>handle.fd===-1));}
    finally{fs.promises.open=original;for(const handle of handles)if(handle.fd!==-1)await handle.close();}
});
test('preview cache rejects same-size corruption even with restored mtime and closes failed verification handles',async t=>{
    const f=readerFixture(t),source=f.add(),opened=await f.reader.open(source.file,source.asset);await opened.close();
    const stat=fs.statSync(source.file),damaged=Buffer.from(source.bytes);damaged[0]^=1;fs.writeFileSync(source.file,damaged);fs.utimesSync(source.file,stat.atime,stat.mtime);
    await assert.rejects(f.reader.open(source.file,source.asset),{code:'ASSET_CORRUPT'});assert.equal(f.reader.cacheSize,0);
    fs.writeFileSync(source.file,source.bytes);const restored=await f.reader.open(source.file,source.asset);await restored.close();
    fs.unlinkSync(source.file);await assert.rejects(f.reader.open(source.file,source.asset),{code:'ENOENT'});assert.equal(f.reader.cacheSize,0);
});
test('preview read refuses replacement or truncation after verification and can close a refused read',async t=>{
    const f=readerFixture(t),source=f.add();let opened=await f.reader.open(source.file,source.asset);
    fs.truncateSync(source.file,10);await assert.rejects(opened.read(0,9),{code:'ASSET_CORRUPT'});await opened.close();
    fs.writeFileSync(source.file,source.bytes);opened=await f.reader.open(source.file,source.asset);
    const moved=source.file+'.old';fs.renameSync(source.file,moved);fs.writeFileSync(source.file,source.bytes);
    await assert.rejects(opened.read(0,9),{code:'ASSET_CORRUPT'});await opened.close();assert.equal(opened.closed,true);
});
test('actual preview HTTP preserves Range/HEAD/If-Range, detects corruption/loss, and follows moved asset identities',async t=>{
    const f=await fixture(t),taskId=save(f,'2026-10-31T00:00:00.000Z');f.runtime=await start(f.directory);
    const url=f.asset.previewUrl;
    let response=await f.runtime.request(url,{headers:{Range:'bytes=3-17'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 3-17/'+png.length);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png.subarray(3,18));
    const etag=response.headers.get('etag');
    response=await f.runtime.request(url,{method:'HEAD',headers:{Range:'bytes=999999-'}});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(png.length));assert.equal((await response.arrayBuffer()).byteLength,0);
    response=await f.runtime.request(url,{headers:{Range:'bytes=3-17','If-Range':etag}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png.subarray(3,18));
    response=await f.runtime.request(url,{headers:{Range:'bytes=3-17','If-Range':'"wrong"'}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    for(const range of ['bytes='+png.length+'-','bytes=0-1,4-5','garbage']){response=await f.runtime.request(url,{headers:{Range:range}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */'+png.length);await response.arrayBuffer();}
    const file=f.store.resolveAssetPath(f.asset.assetId),damaged=Buffer.from(png);damaged[0]^=1;fs.writeFileSync(file,damaged);
    response=await f.runtime.request(url,{headers:{Range:'bytes=3-17'}});assert.equal(response.status,409);assert.equal((await response.json()).code,'ASSET_CORRUPT');
    fs.unlinkSync(file);response=await f.runtime.request(url);assert.equal(response.status,404);assert.equal((await response.json()).code,'ASSET_MISSING');
    fs.writeFileSync(file,png);response=await f.runtime.request(url);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
    const target=f.store.createGroup({name:'新预览路径'}),moved=f.store.moveTaskToGroup(taskId,{groupId:target.groupId,requestId:randomUUID()}),after=moved.task.outputAssets[0];
    assert.notEqual(after.assetId,f.asset.assetId);response=await f.runtime.request(after.previewUrl,{headers:{Range:'bytes=0-15'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),png.subarray(0,16));
});


test('preview HTTP always closes its handle for HEAD, invalid ranges, read errors and disconnected consumers',async()=>{
    const {createStorageHttp}=require('../storage/http');
    for(const mode of ['HEAD','range-error','read-error','disconnected']){
        let closes=0,reads=0,sent;
        const req={method:mode==='HEAD'?'HEAD':'GET',headers:mode==='range-error'?{range:'bytes=999-'}:{}};
        const res={destroyed:mode==='disconnected',writeHead(status,headers){sent={status,headers};},end(){}};
        const store={openPreviewAsset:async()=>({asset:{mimeType:'video/mp4',sha256:'a'.repeat(64)},byteLength:20,async read(){reads++;if(mode==='read-error')throw Object.assign(Error('changed'),{code:'ASSET_CORRUPT',statusCode:409});return Buffer.alloc(20);},async close(){closes++;}})};
        const handler=createStorageHttp({getStore:()=>store,sendJson(_res,status,value){sent={status,value};}});
        assert.equal(await handler(req,res,'/api/nova/assets/'+randomUUID()+'/content',new URLSearchParams()),true);
        assert.equal(closes,1,mode);
        if(mode==='HEAD'){assert.equal(sent.status,200);assert.equal(reads,0);}
        if(mode==='range-error'){assert.equal(sent.status,416);assert.equal(reads,0);}
        if(mode==='read-error'){assert.equal(sent.status,409);assert.equal(sent.value.code,'ASSET_CORRUPT');}
        if(mode==='disconnected')assert.equal(reads,0);
    }
});
test('preview rejects symbolic links even when their bytes match the asset',async t=>{
    const f=readerFixture(t),source=f.add(),link=source.file+'-link';
    try{fs.symlinkSync(source.file,link,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not grant file symlink permission');return;}throw error;}
    try { await assert.rejects(f.reader.open(link,source.asset),error=>['ASSET_PATH_REJECTED','ELOOP'].includes(error.code)); }
    finally { fs.unlinkSync(link); }
});
