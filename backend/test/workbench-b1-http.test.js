'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto'),Database=require('better-sqlite3');
const {start}=require('./support/desktop-http-runtime.cjs');
const KEY='synthetic-b1-http-protected';
const MODEL='grok-imagine-video-1.5-6s';
const prompt='  中文完整台词\n“你好”\r\n第二行  ';
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1',name));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(15);}throw new Error('B1 synthetic HTTP timed out');}
async function rig(t,behavior={}){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-b1-http-')),calls=[];
    const inspect=fn=>{const db=new Database(path.join(directory,'tasks.sqlite'));try{return fn(db);}finally{db.close();}};
    const upstream=http.createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const record={method:req.method,path:req.url,authorization:req.headers.authorization,contentType:req.headers['content-type'],rawBody:Buffer.concat(chunks)};
        calls.push(record);
        if(req.method==='GET'&&req.url.endsWith('/content')){const bytes=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4'));res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);return;}
        if(req.method==='POST'){
            record.dispatch=inspect(db=>db.prepare("SELECT dispatch_started_at,input_snapshot_json FROM tasks WHERE status='submitting'").get());
            const form=await new Response(record.rawBody,{headers:{'content-type':record.contentType}}).formData();
            record.parts=[];for(const[name,value]of form.entries())record.parts.push(typeof value==='string'?{name,value}:{name,fileName:value.name,mimeType:value.type,bytes:Buffer.from(await value.arrayBuffer())});
        }
        const data=(req.method==='POST'?behavior.submit:behavior.poll)||{body:req.method==='POST'?{id:'task_b1_original',task_id:'task_b1_original',status:'queued'}:{id:'task_b1_original',status:'completed',progress:100,video_url:'https://cdn.invalid/video.mp4?signature=synthetic'}};
        if(data.disconnect){res.destroy();return;}
        res.writeHead(data.status||200,{'content-type':'application/json',...data.headers});
        if(data.stall){res.write('{"id":"unfinished');return;}
        res.end(JSON.stringify(data.body));
    });
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const opensosenOrigin='http://127.0.0.1:'+upstream.address().port;
    let runtime=await start(directory,{opensosenOrigin,...(behavior.timeout?{pluginRequestTimeoutMs:behavior.timeout}:{})});
    t.after(async()=>{await runtime.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
    const connection=await runtime.saveConnection({baseUrl:'https://newapi.opensosen.com/v1',apiKey:KEY});
    const models=await(await runtime.request('/api/nova/connections/'+connection.connectionId+'/models')).json();
    const imported=[];
    for(const name of ['reference-a.png','reference-single.jpg']){
        const response=await runtime.request('/api/nova/assets/import',{method:'POST',headers:{'content-type':name.endsWith('png')?'image/png':'image/jpeg'},body:fixture(name)});assert.equal(response.status,201);imported.push((await response.json()).asset);
    }
    const refs=imported.map((asset,position)=>({assetId:asset.assetId,position,role:'reference'}));
    const input=(extra={})=>{
        const mode=extra.mode||'video.dual_reference',model=extra.model||MODEL;
        return {localRequestId:randomUUID(),connectionVersionId:connection.connectionVersionId,mode,model,prompt,parameters:mode.startsWith('video.')?{seconds:6,size:'1280x720'}:{},
            capabilityVersionId:models.capabilities.find(item=>item.mode===mode&&item.model===model)?.capabilityVersionId,inputAssets:mode==='video.single_reference'?refs.slice(0,1):mode.endsWith('.text')?[]:refs,...extra};
    };
    const post=(route,body)=>runtime.request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const create=async body=>{const response=await post('/api/nova/workbench/tasks',body||input());assert.equal(response.status,202,JSON.stringify(await response.clone().json()));return(await response.json()).taskId;};
    const task=async id=>(await runtime.request('/api/nova/tasks/'+id)).json();
    return{directory,calls,connection,models,refs,input,create,post,task,inspect,behavior,get runtime(){return runtime;},
        async restart(){await runtime.crash();inspect(db=>db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE status IN ('remote_queued','generating')").run());runtime=await start(directory,{opensosenOrigin,...(behavior.timeout?{pluginRequestTimeoutMs:behavior.timeout}:{})});},
        posts:()=>calls.filter(item=>item.method==='POST'),gets:()=>calls.filter(item=>item.method==='GET')};
}
for(const count of[1,2])test('actual desktop B1 '+count+' file request freezes original assets and completes through B2 verified local download',async t=>{
    const f=await rig(t),input=f.input({mode:count===1?'video.single_reference':'video.dual_reference'});
    if(count===2)input.inputAssets=[{...f.refs[1],position:0},{...f.refs[0],position:1}];
    const id=await f.create(input);await until(async()=>(await f.task(id)).status==='remote_queued');
    const post=f.posts()[0];assert.ok(post.dispatch.dispatch_started_at);assert.equal(f.posts().length,1);assert.match(post.contentType,/multipart\/form-data; boundary=/);
    assert.deepEqual(post.parts.slice(0,4),[{name:'model',value:MODEL},{name:'prompt',value:prompt.replace(/\r?\n/g,'\r\n')},{name:'seconds',value:'6'},{name:'size',value:'1280x720'}]);
    const referenceBytes=count===1?[fixture('reference-a.png')]:[fixture('reference-single.jpg'),fixture('reference-a.png')];
    assert.deepEqual(post.parts.slice(4).map(item=>item.name),Array(count).fill('input_reference'));
    post.parts.slice(4).forEach((item,index)=>assert.deepEqual(item.bytes,referenceBytes[index]));
    const snapshot=JSON.parse(post.dispatch.input_snapshot_json);assert.equal(snapshot.prompt,prompt);assert.deepEqual(snapshot.inputAssets,input.inputAssets);assert.equal(snapshot.adapterVersion,'1.0.0');assert.equal(snapshot.capabilityVersionId,input.capabilityVersionId);
    assert.equal(await f.create(input),id);
    await f.runtime.saveConnection({connectionId:f.connection.connectionId,expectedVersionId:f.connection.connectionVersionId,baseUrl:'https://other.invalid/v1',apiKey:'synthetic-new-b1'});
    await f.restart();await until(async()=>(await f.task(id)).status==='completed');
    assert.equal(f.posts().length,1);assert.equal(f.gets().length,2);assert.equal(f.gets()[0].path,'/v1/videos/task_b1_original');assert.equal(f.gets()[1].path,'/v1/videos/task_b1_original/content');assert.ok(f.gets().every(call=>call.authorization==='Bearer '+KEY));
    const dto=await f.task(id);assert.ok(dto.completedAt);assert.equal(dto.outputAssets[0].validationState,'verified');assert.equal(JSON.stringify(dto).includes('opensosen.com'),false);
    const stored=f.inspect(db=>({task:db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id),download:db.prepare('SELECT state FROM task_downloads WHERE task_id=?').get(id)}));
    assert.equal(stored.download.state,'completed');assert.deepEqual(JSON.parse(stored.task.result_sources_json),[{kind:'url',url:'https://newapi.opensosen.com/v1/videos/task_b1_original/content',authScope:'connection',mediaKind:'video'}]);
    assert.equal(stored.task.result_sources_json.includes('signature'),false);
    const asset=dto.outputAssets[0],bytes=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4'));
    for(const [range,start,end]of[['bytes=0-99',0,99],['bytes=100-',100,bytes.length-1],['bytes=-128',bytes.length-128,bytes.length-1]]){const result=await f.runtime.request(asset.previewUrl,{headers:{Range:range}});assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes '+start+'-'+end+'/'+bytes.length);assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes.subarray(start,end+1));}
    const invalid=await f.runtime.request(asset.previewUrl,{headers:{Range:'bytes='+bytes.length+'-'}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */'+bytes.length);
    const head=await f.runtime.request(asset.previewUrl,{method:'HEAD',headers:{Range:'bytes=0-1'}});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));
    await f.restart();assert.equal((await f.task(id)).status,'completed');assert.equal(f.posts().length,1);assert.equal(f.gets().length,2);assert.deepEqual(Buffer.from(await(await f.runtime.request(asset.previewUrl)).arrayBuffer()),bytes);
    t.diagnostic(JSON.stringify({mode:input.mode,files:count,postCount:f.posts().length,getCount:f.gets().length,localState:'completed',download:'verified and readable offline',range:'206/416/HEAD exact bytes'}));
});
test('canonical admission keeps all unverified modes explicit, rejects count/asset/version/legacy bypasses before any paid request',async t=>{
    const f=await rig(t);
    for(const extra of [
        {mode:'image.text',model:'gpt-image-2.5-flare'},{mode:'image.reference',model:'gpt-image-2.5-flare'},
        {mode:'video.text'},{mode:'video.text',model:'grok-imagine-video-6s'},{model:'grok-imagine-video-6s'},
    ]){const response=await f.post('/api/nova/workbench/tasks',f.input(extra));assert.equal(response.status,400);assert.equal((await response.json()).code,'CAPABILITY_UNVERIFIED');}
    for(const extra of [{inputAssets:f.refs.slice(0,1)},{inputAssets:[{...f.refs[1],position:1},f.refs[0]]},{parameters:{seconds:6,size:'720x1280'}},{apiKey:KEY},
        {inputAssets:[{...f.refs[0],filePath:'private.png'},f.refs[1]]},{capabilityVersionId:f.models.capabilities.find(item=>item.mode==='video.text'&&item.model===MODEL).capabilityVersionId}]){
        const response=await f.post('/api/nova/workbench/tasks',f.input(extra));assert.equal(response.status,400);
    }
    for(const[route,body]of[['/api/nova/tasks',{localRequestId:randomUUID(),connectionVersionId:f.connection.connectionVersionId,model:'gpt-image-2.5-flare'}],['/api/nova/plugin-tasks',{pluginId:'opensosen-video'}]]){
        const response=await f.post(route,body);assert.equal(response.status,400);assert.equal((await response.json()).code,'WORKBENCH_INPUT_REQUIRED');
    }
    assert.equal((await fetch(f.runtime.origin+'/api/nova/workbench/tasks',{method:'POST'})).status,403);
    assert.equal(f.calls.length,0);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM tasks').get().n),0);
});
test('script accepted ID persists before encoded credential contamination; query resumes only explicit original GET and URLs do not escape',async t=>{
    const percent=value=>[...Buffer.from(value)].map(byte=>'%'+byte.toString(16)).join('');
    const f=await rig(t,{submit:{body:{id:'task_b1_original',task_id:'task_b1_original',note:percent(percent(KEY))}}}),id=await f.create();
    await until(async()=>(await f.task(id)).status==='polling_paused');
    const dto=await f.task(id);assert.equal(dto.upstreamTaskId,'task_b1_original');assert.equal(dto.generationReserved,true);
    const next=await f.create();await sleep(40);assert.equal((await f.task(next)).status,'local_queued');assert.equal(f.posts().length,1);
    await f.post('/api/nova/tasks/'+next+'/cancel-queued');
    const ws=f.runtime.openWebSocket(),messages=[];ws.on('message',data=>messages.push(String(data)));await new Promise(resolve=>ws.once('open',resolve));
    await f.post('/api/nova/tasks/'+id+'/resume-polling');await until(async()=>(await f.task(id)).status==='completed');
    ws.close();await new Promise(resolve=>ws.once('close',resolve));
    const history=await(await f.runtime.request('/api/nova/storage/tasks')).json();
    const persistence=f.inspect(db=>JSON.stringify({tasks:db.prepare('SELECT request_json,input_snapshot_json,result_sources_json,task_error_json FROM tasks').all(),events:db.prepare('SELECT payload_json FROM task_events').all()}));
    for(const text of[JSON.stringify(dto),JSON.stringify(history),messages.join(''),persistence,f.runtime.output()]){
        assert.equal(text.includes(KEY),false);assert.equal(text.includes(percent(KEY)),false);assert.equal(text.includes(percent(percent(KEY))),false);assert.equal(text.includes('cdn.invalid'),false);
    }
    assert.equal(f.gets()[0].path,'/v1/videos/task_b1_original');
    // The following queued task was explicitly cancelled before it could be dispatched.
    assert.equal(f.posts().length,1);
});
for(const kind of['disconnect','stalled-body'])test('actual B1 '+kind+' becomes submission_unknown, survives restart and attach-ID never queries before explicit resume',async t=>{
    const f=await rig(t,{submit:kind==='disconnect'?{disconnect:true}:{stall:true},timeout:250}),id=await f.create();
    await until(async()=>(await f.task(id)).status==='submission_unknown');
    assert.equal((await f.task(id)).generationReserved,true);const next=await f.create();
    await f.restart();assert.equal((await f.task(id)).status,'submission_unknown');assert.equal(f.posts().length,1);assert.equal(f.gets().length,0);
    assert.equal((await f.post('/api/nova/tasks/'+id+'/attach-upstream-id',{upstreamTaskId:KEY})).status,400);
    assert.equal((await f.post('/api/nova/tasks/'+id+'/attach-upstream-id',{upstreamTaskId:'known/A?B#C'})).status,200);
    assert.equal((await f.task(id)).status,'polling_paused');assert.equal(f.gets().length,0);
    assert.equal((await f.post('/api/nova/tasks/'+next+'/cancel-queued')).status,200);
    assert.equal((await f.post('/api/nova/tasks/'+id+'/resume-polling')).status,200);
    await until(()=>f.gets().length===1);assert.equal(f.gets()[0].path,'/v1/videos/known%2FA%3FB%23C');assert.equal(f.posts().length,1);
});
for(const response of[
    {name:'401',status:401,body:{error:'synthetic authentication'},code:'AUTH_REJECTED'},
    {name:'403',status:403,body:{error:'synthetic authentication'},code:'AUTH_REJECTED'},
    {name:'long Retry-After',status:429,headers:{'retry-after':'180'},body:{error:'synthetic throttle'},code:'RATE_LIMITED'},
    {name:'unknown status',body:{status:'NEW_STATUS'},code:'REMOTE_STATUS_UNKNOWN'},
])test('actual B1 GET '+response.name+' retains ID, original credential and conservative occupied slot',async t=>{
    const f=await rig(t,{poll:response}),id=await f.create();await until(async()=>(await f.task(id)).status==='remote_queued');await f.restart();
    const dto=await until(async()=>{const value=await f.task(id);return value.status==='polling_paused'?value:null;});
    assert.equal(dto.upstreamTaskId,'task_b1_original');assert.equal(dto.taskError.code,response.code);assert.equal(dto.generationReserved,true);
    await f.create();await sleep(30);assert.equal(f.posts().length,1);assert.equal(f.gets()[0].authorization,'Bearer '+KEY);
    if(response.status===429)assert.equal((await f.post('/api/nova/tasks/'+id+'/resume-polling')).status,409);
});
test('cleared original credential keeps an accepted B1 task paused and never rebinds another saved credential',async t=>{
    const f=await rig(t),id=await f.create();await until(async()=>(await f.task(id)).status==='remote_queued');
    await f.runtime.clearConnectionCredential({connectionId:f.connection.connectionId,expectedVersionId:f.connection.connectionVersionId});await f.restart();
    await until(async()=>(await f.task(id)).status==='polling_paused');assert.equal(f.gets().length,0);assert.equal(f.posts().length,1);
    const cleared=await(await f.runtime.request('/api/nova/connections/current')).json();
    await f.runtime.saveConnection({connectionId:f.connection.connectionId,expectedVersionId:cleared.connection.connectionVersionId,apiKey:'synthetic-replacement'});
    const resume=await f.post('/api/nova/tasks/'+id+'/resume-polling');assert.equal(resume.status,409);assert.equal((await resume.json()).code,'CREDENTIAL_REQUIRED');assert.equal(f.gets().length,0);
});

for(const invalid of ['.','..'])test('review actual HTTP accepted dot ID '+invalid+' remains unknown/reserved; invalid attach does not GET, mutate ID, or rePOST',async t=>{
    const f=await rig(t,{submit:{body:{id:invalid,task_id:invalid,status:'completed',video_url:'https://cdn.invalid/untrusted-result.mp4'}}}),id=await f.create();
    await until(async()=>(await f.task(id)).status==='submission_unknown');
    let dto=await f.task(id);assert.equal(dto.upstreamTaskId,null);assert.equal(dto.generationReserved,true);
    assert.equal(f.posts().length,1);assert.equal(f.gets().length,0);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM task_downloads').get().n),0);
    const next=await f.create(),eventCount=f.inspect(db=>db.prepare('SELECT count(*) n FROM task_events WHERE task_id=?').get(id).n);
    for(const upstreamTaskId of ['.','..']){
        const rejected=await f.post('/api/nova/tasks/'+id+'/attach-upstream-id',{upstreamTaskId});
        assert.equal(rejected.status,400);assert.equal((await rejected.json()).code,'INVALID_UPSTREAM_ID');
    }
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM task_events WHERE task_id=?').get(id).n),eventCount);
    assert.equal(f.posts().length,1);assert.equal(f.gets().length,0);assert.equal((await f.task(id)).upstreamTaskId,null);
    await f.restart();dto=await f.task(id);assert.equal(dto.status,'submission_unknown');assert.equal(dto.generationReserved,true);
    await f.post('/api/nova/tasks/'+next+'/continue-queued');await sleep(30);assert.equal(f.posts().length,1);assert.equal(f.gets().length,0);
    const normal='任务/opaque%.版本';assert.equal((await f.post('/api/nova/tasks/'+id+'/attach-upstream-id',{upstreamTaskId:normal})).status,200);
    assert.equal((await f.task(id)).status,'polling_paused');assert.equal(f.gets().length,0);
    await f.post('/api/nova/tasks/'+next+'/cancel-queued');
    assert.equal((await f.post('/api/nova/tasks/'+id+'/resume-polling')).status,200);
    await until(async()=>(await f.task(id)).status==='completed');
    const encoded=encodeURIComponent(normal);assert.equal(f.gets().length,2);assert.equal(f.gets()[0].path,'/v1/videos/'+encoded);assert.equal(f.gets()[1].path,'/v1/videos/'+encoded+'/content');
    const sources=f.inspect(db=>JSON.parse(db.prepare('SELECT result_sources_json FROM tasks WHERE id=?').get(id).result_sources_json));
    assert.equal(new URL(sources[0].url).pathname,'/v1/videos/'+encoded+'/content');assert.equal(f.posts().length,1);
    t.diagnostic(JSON.stringify({rejectedId:invalid,postCount:1,getCount:1,queryPath:f.gets()[0].path,contentPath:new URL(sources[0].url).pathname,reattachedOnlyAfterValidation:true}));
});
