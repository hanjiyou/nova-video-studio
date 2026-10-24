'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const registry = require('../plugin-runtime/registry');
const { createPluginAdapter } = require('../tasks/plugin-adapter');
const { buildRequestInit } = require('../plugin-runtime/request-body');
const image = require('../tasks/flare-image-adapter');
const { snapshotFor } = require('../tasks/workbench-input');
const plugin = registry.getPlugin('opensosen-video'), driver = plugin.driver;
const auth = { connectionVersionId: randomUUID(), provider: 'opensosen', protocol: 'openai', baseUrl: 'https://newapi.opensosen.com/v1', apiKey: 'synthetic-b1-private-credential' };
const fixture = name => fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1',name));
const refs = [fixture('reference-a.png'),fixture('reference-single.jpg')].map((bytes,index)=>({bytes,asset:{assetId:randomUUID(),kind:'image',mimeType:index?'image/jpeg':'image/png'}}));
const prompt='  中文原文\n“完整对白”\r\n第二行  ';
const imageFixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/b1/flare-responses.json'),'utf8'));
const context = (extra={}) => ({...auth,mode:'video.dual_reference',model:driver.MODELS[1],fields:{prompt},parameters:{seconds:6,size:'1280x720'},
    inputAssets:refs.map(({asset},position)=>({assetId:asset.assetId,position,role:'reference',mimeType:asset.mimeType})),...extra});
const readAsset = id => { const ref=refs.find(item=>item.asset.assetId===id);assert.ok(ref);return ref; };
const options={readAsset,getAsset:id=>readAsset(id).asset};
const task = () => { const ctx=context();return {upstream_task_id:'task/A?B#C',input_snapshot_json:JSON.stringify({...ctx,prompt,fields:undefined}),request_json:JSON.stringify({model:ctx.model,fields:ctx.fields})}; };
function mock(t, response) { const previous=global.fetch,calls=[];global.fetch=async(url,init)=>{calls.push({url,init});return typeof response==='function'?response(url,init):response;};t.after(()=>{global.fetch=previous;});return calls; }

test('new package registers both exact models, with only fixed application controls and ordered references',()=>{
    assert.deepEqual(plugin.manifest.models.map(item=>item.id),driver.MODELS);
    assert.deepEqual(plugin.uiSchema.fields.find(item=>item.key==='seconds').options.map(item=>item.value),[6]);
    assert.deepEqual(plugin.uiSchema.fields.find(item=>item.key==='aspectRatio').options.map(item=>item.value),['16:9']);
    assert.equal(plugin.manifest.media.images.maxCount,7);
});
for (const count of [1,2]) test('production driver builds '+count+' repeated file parts, then host FormData preserves raw PNG/JPEG bytes and prompt',async()=>{
    const ctx=context({mode:count===1?'video.single_reference':'video.dual_reference',inputAssets:context().inputAssets.slice(0,count)});
    const request=driver.buildSubmit(ctx), init=buildRequestInit(request,ctx,readAsset);
    assert.equal(request.url,auth.baseUrl+'/videos');assert.equal(request.method,'POST');assert.equal(request.encoding,'multipart');
    assert.equal(request.headers,undefined);assert.equal(init.headers.Authorization,'Bearer '+auth.apiKey);
    assert.equal(Object.keys(init.headers).some(key=>key.toLowerCase()==='content-type'),false);
    const wire=new Request(request.url,{...init,duplex:'half'}), contentType=wire.headers.get('content-type');
    assert.match(contentType,/multipart\/form-data; boundary=/);
    const form=await wire.formData(), entries=[...form.entries()];
    assert.deepEqual(entries.slice(0,4),[['model',driver.MODELS[1]],['prompt',prompt.replace(/\r?\n/g,'\r\n')],['seconds','6'],['size','1280x720']]);
    assert.deepEqual(entries.slice(4).map(([name])=>name),Array(count).fill('input_reference'));
    for(let i=0;i<count;i++){assert.equal(entries[i+4][1].type,refs[i].asset.mimeType);assert.deepEqual(Buffer.from(await entries[i+4][1].arrayBuffer()),refs[i].bytes);}
    assert.equal(ctx.fields.prompt,prompt);
});
for(const [model,mode,count,code] of [
    [driver.MODELS[1],'video.text',0,'CAPABILITY_UNVERIFIED'],[driver.MODELS[0],'video.text',0,'CAPABILITY_UNVERIFIED'],
    [driver.MODELS[0],'video.single_reference',1,'CAPABILITY_UNVERIFIED'],[driver.MODELS[0],'video.dual_reference',2,'CAPABILITY_UNVERIFIED'],
    [driver.MODELS[1],'video.single_reference',0,'INPUT_INVALID'],[driver.MODELS[1],'video.single_reference',2,'INPUT_INVALID'],
    [driver.MODELS[1],'video.dual_reference',1,'INPUT_INVALID'],[driver.MODELS[1],'video.text',1,'INPUT_INVALID'],
]) test(model+' / '+mode+' / '+count+' inputs rejects without guessing a protocol',()=>{
    assert.throws(()=>driver.buildSubmit(context({model,mode,inputAssets:context().inputAssets.slice(0,count)})),{code});
});
test('driver rejects another service, unsupported size/seconds/extra fields and nonconsecutive input order',()=>{
    for(const extra of [{baseUrl:'https://other.invalid/v1'},{parameters:{seconds:8,size:'1280x720'}},{parameters:{seconds:6,size:'720x1280'}},{parameters:{seconds:6,size:'1280x720',duration:6}},
        {inputAssets:context().inputAssets.map(item=>({...item,position:1}))}]) assert.throws(()=>driver.buildSubmit(context(extra)));
});
test('multipart host rejects paths, MIME spoofing, manual boundary and assets outside frozen input',()=>{
    const ctx=context(),req=driver.buildSubmit(ctx);
    for(const change of [{headers:{'content-type':'multipart/form-data; boundary=manual'}},{body:{}},
        {parts:[{...req.parts[4],path:'private.png'}]},{parts:[{...req.parts[4],mimeType:'image/webp'}]},
        {parts:[{...req.parts[4],assetId:randomUUID()}]},{parts:[{...req.parts[4],fileName:'../escape.png'}]}]) assert.throws(()=>buildRequestInit({...req,...change},ctx,readAsset),{code:'INPUT_INVALID'});
    assert.throws(()=>buildRequestInit(req,ctx,()=>({...refs[0],bytes:Buffer.from('not an image')})),{code:'INPUT_INVALID'});
});
test('safe accepted driver ID is exposed before a later parser or credential error; only one POST',async t=>{
    const calls=mock(t,()=>Response.json({id:'accepted-safe',task_id:'accepted-safe',note:auth.apiKey.split('').map(c=>'%'+c.charCodeAt(0).toString(16)).join('')}));
    let observed;await assert.rejects(createPluginAdapter(plugin,options).submit(task(),{}, {...auth,onAccepted:id=>{observed=id;}}),{credentialRedacted:true});
    assert.equal(observed,'accepted-safe');assert.equal(calls.length,1);
});
for(const status of [400,401,403,429,503]) test('new multipart POST '+status+' remains single attempt and has bounded safe rejection metadata',async t=>{
    const calls=mock(t,Response.json({error:{message:'synthetic rejection'}},{status,headers:{'retry-after':'1'}}));
    await assert.rejects(createPluginAdapter(plugin,options).submit(task(),{},auth),e=>e.httpStatus===status&&e.definiteRejection===(status<500));assert.equal(calls.length,1);
});
test('driver GET encodes one opaque segment, keeps progress, normalizes only observed states and supplies stable authenticated content source',async t=>{
    const completed=JSON.parse(fixture('video-completed.json')).response.body;
    const calls=mock(t,()=>Response.json(completed));
    const output=await createPluginAdapter(plugin,options).poll(task(),{},auth);
    assert.equal(calls[0].url,auth.baseUrl+'/videos/task%2FA%3FB%23C');assert.equal(calls[0].init.method,'GET');assert.equal(output.remoteState,'completed');assert.equal(output.progress,100);
    assert.deepEqual(output.resultSources,[{kind:'url',url:auth.baseUrl+'/videos/task%2FA%3FB%23C/content',mediaKind:'video',authScope:'connection'}]);
    assert.equal(JSON.stringify(output).includes('media.fixture.invalid'),false);
});
test('unknown video status is not invented as complete/failure; empty create ID is not accepted',()=>{
    const result=driver.parseTaskResult({status:'NEW_UNKNOWN',progress:100},{...context(),upstreamTaskId:'original'});
    assert.equal(result.state,'unknown');assert.deepEqual(result.assets,[]);
    assert.throws(()=>driver.parseSubmitResponse({task_id:' '}),{code:'SUBMISSION_UNKNOWN'});
    assert.throws(()=>driver.parseSubmitResponse({id:'one',task_id:'two'}),{code:'SUBMISSION_UNKNOWN'});
});
test('flare candidate is a precise nonstream minimum and preserves prompt without extra size/quality fields',()=>{
    const snapshot={mode:'image.text',model:image.MODEL,prompt,parameters:{},inputAssets:[]},request=image.buildSubmit(snapshot,auth);
    assert.equal(request.url,auth.baseUrl+'/images/generations');assert.deepEqual(request.json,{model:'gpt-image-2.5-flare',prompt,n:1});
    for(const parameters of [{size:'1024x1024'},{quality:'high'}]) assert.deepEqual(image.buildSubmit({...snapshot,parameters},auth).json,{model:image.MODEL,prompt,n:1,...parameters});
    assert.throws(()=>image.buildSubmit({...snapshot,model:'gpt-image-2'},auth),{code:'INPUT_INVALID'});
});
test('flare reference builds only the edit path, and production preflight remains gated by the selected capability',()=>{
    const snapshot={mode:'image.reference',model:image.MODEL,prompt,parameters:{},inputAssets:[{assetId:refs[0].asset.assetId,position:0,role:'reference'}]};
    const request=image.buildSubmit(snapshot,auth,id=>readAsset(id).asset);assert.equal(request.url,auth.baseUrl+'/images/edits');assert.equal(request.parts.at(-1).name,'image');
    const adapter=image.createFlareImageAdapter({validateCapability:()=>{throw Object.assign(new Error('unverified'),{code:'CAPABILITY_UNVERIFIED'});}});
    assert.throws(()=>adapter.preflight({}, {...snapshot,mode:'image.text',inputAssets:[]},auth),{code:'CAPABILITY_UNVERIFIED'});
});
test('flare synthetic URL/base64 outputs normalize into temporary sources; empty, invalid and credential outputs reject',()=>{
    const output=image.parseSubmit({data:[...imageFixtures.inline.data,...imageFixtures.url.data]},auth);
    assert.deepEqual(output.resultSources[0].bytes,refs[0].bytes);assert.equal(output.resultSources[0].mimeType,'image/png');
    assert.equal(output.resultSources[1].url,'https://cdn.fixture.invalid/image.png?signature=synthetic');
    for(const payload of [{},{data:[]},{data:[{}]},{data:[{b64_json:'!!!'}]},{data:[{b64_json:Buffer.from('junk').toString('base64')}]},{data:[{url:'data:image/png;base64,AAAA'}]},{data:[{url:'https://cdn.invalid/'+auth.apiKey}]}]) assert.throws(()=>image.parseSubmit(payload,auth));
});
test('flare synthetic 503 and empty result use exactly one POST and no fallback model',async t=>{
    let response=Response.json({error:{message:'synthetic rejection'}},{status:503});const calls=mock(t,()=>response);
    const adapter=image.createFlareImageAdapter({validateCapability:()=>{}}); // Synthetic evidence injection, never production evidence.
    const snapshot={mode:'image.text',model:image.MODEL,prompt,parameters:{},inputAssets:[]};
    await assert.rejects(adapter.submit({},snapshot,auth),{httpStatus:503});assert.equal(calls.length,1);
    response=Response.json({data:[]});await assert.rejects(adapter.submit({},snapshot,auth),{code:'SUBMISSION_UNKNOWN'});assert.equal(calls.length,2);
    for(const call of calls)assert.equal(JSON.parse(call.init.body).model,image.MODEL);
});
test('canonical snapshot rejects mode/count mismatch and unknown request/path overrides',()=>{
    const body={localRequestId:randomUUID(),connectionVersionId:auth.connectionVersionId,capabilityVersionId:randomUUID(),mode:'video.dual_reference',model:driver.MODELS[1],prompt,parameters:{seconds:6,size:'1280x720'},inputAssets:context().inputAssets.map(({assetId,position,role})=>({assetId,position,role}))};
    const snapshot=snapshotFor(body,'1.0.0');assert.equal(snapshot.prompt,prompt);assert.equal(snapshot.adapterVersion,'1.0.0');assert.deepEqual(snapshot.inputAssets,body.inputAssets);
    for(const change of [{inputAssets:body.inputAssets.slice(0,1)},{apiKey:'synthetic'},{baseUrl:'https://other.invalid'},{inputAssets:[{...body.inputAssets[0],filePath:'private.png'}]}])assert.throws(()=>snapshotFor({...body,...change},'1.0.0'));
});

test('shared script executor supports host-only ordered multipart while old JSON remains unchanged',async t=>{
    const executor=require('../plugin-runtime/executor'),ctx=executor.buildContext({...context(),plugin,readAsset});
    const calls=mock(t,Response.json({id:'accepted-script',task_id:'accepted-script',status:'queued'}));
    assert.equal((await executor.submitTask(plugin,ctx)).upstreamTaskId,'accepted-script');assert.equal(calls.length,1);assert.ok(calls[0].init.body instanceof FormData);
    assert.deepEqual(buildRequestInit({method:'POST',body:{model:'old-model'}},{}),{method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',body:'{"model":"old-model"}'});
});

test('candidate flare deadline covers headers and stalled JSON body, with one POST and one body read',async t=>{
    const http=require('node:http'),previousFetch=global.fetch,previousTimeout=global.setTimeout;
    let count=0,reads=0;
    const server=http.createServer(async(req,res)=>{for await(const chunk of req)void chunk;count++;res.writeHead(200,{'content-type':'application/json'});res.write('{"data":[');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(async()=>{global.fetch=previousFetch;global.setTimeout=previousTimeout;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    global.setTimeout=(callback,delay,...args)=>previousTimeout(callback,delay===30*60*1000?250:delay,...args);
    global.fetch=async(url,init)=>{assert.equal(new URL(url).origin,'https://newapi.opensosen.com');const response=await previousFetch('http://127.0.0.1:'+server.address().port+'/v1/images/generations',init),text=response.text.bind(response);response.text=(...args)=>{reads++;return text(...args);};return response;};
    const adapter=image.createFlareImageAdapter({validateCapability:()=>{}}); // Local synthetic evidence injection only.
    await assert.rejects(adapter.submit({}, {mode:'image.text',model:image.MODEL,prompt,parameters:{},inputAssets:[]},auth),error=>error.name==='AbortError');
    assert.equal(count,1);assert.equal(reads,1);
});
