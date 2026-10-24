'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),{randomUUID,createHash}=require('node:crypto');
const {createT15ProxyTransport}=require('../../scripts/lib/t15-proxy-transport.cjs');
const {createNetworkPolicy}=require('../../desktop/network.cjs');
const {createControlledVideoTextValidationGate,controlledVideoTextValidation:gate}=require('../tasks/controlled-video-text-validation');
const {snapshotFor,validateCapability}=require('../tasks/workbench-input'),{createPluginAdapter}=require('../tasks/plugin-adapter');
const driver=require('../plugins/opensosen-video');
const input={mode:'video.text',model:'grok-imagine-video-1.5-6s',localRequestId:randomUUID(),connectionVersionId:randomUUID(),capabilityVersionId:randomUUID(),prompt:'  no-size 中文\nline two  ',parameters:{seconds:6},inputAssets:[]};
const auth={connectionVersionId:input.connectionVersionId,provider:'opensosen',baseUrl:'https://newapi.opensosen.com/v1',protocol:'openai',apiKey:'synthetic-no-size-only'};
const capability={id:input.capabilityVersionId,provider:auth.provider,base_url:auth.baseUrl,model:input.model,mode:input.mode,protocol:'openai',evidence_level:'unverified',parameters_json:'{}'};
const options=dispatchPermitted=>({candidate:'without-size',localRequestId:input.localRequestId,connectionVersionId:input.connectionVersionId,capabilityVersionId:input.capabilityVersionId,promptSha256:createHash('sha256').update(input.prompt).digest('hex'),dispatchPermitted});
async function rig(t){
 const records=[],sockets=new Set();let connects=0;
 const receiver=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);records.push({path:req.url,method:req.method,contentType:req.headers['content-type'],authorization:req.headers.authorization,bytes:Buffer.concat(chunks)});res.writeHead(200,{'content-type':'application/json'});res.end('{"task_id":"fixture-text-original-id"}')});
 receiver.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const target='127.0.0.1:'+receiver.address().port;
 const proxy=http.createServer((_req,res)=>{res.writeHead(405);res.end()});proxy.on('connect',(req,client,head)=>{assert.equal(req.url,target);connects++;const upstream=net.connect(receiver.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)});for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy()})}});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const transport=createT15ProxyTransport('http://127.0.0.1:'+proxy.address().port),network=createNetworkPolicy({backendOrigin:'http://127.0.0.1:1',mode:'system',directFetch:()=>{throw Error('DIRECT_PATH_FORBIDDEN')},proxyFetch:transport.fetch});
 t.after(async()=>{network.abortPending();await transport.close();sockets.forEach(s=>s.destroy());await Promise.all([new Promise(r=>receiver.close(r)),new Promise(r=>proxy.close(r))])});return {records,network,url:'http://'+target+'/v1/videos',connects:()=>connects};
}

test('no-size candidate needs exact host grant; every other request keeps ordinary parameter rules',()=>{
 const local=createControlledVideoTextValidationGate();assert.equal(local.allowsInput(input),false);assert.throws(()=>validateCapability({prepare:()=>({get:()=>capability})},snapshotFor(input,'1'),auth),{code:'CAPABILITY_UNVERIFIED'});
 assert.throws(()=>local.configure({...options(()=>true),candidate:'guess'}));let posts=0;local.configure(options(()=>posts===0));assert.equal(local.allows(input,auth,capability),true);
 for(const diff of [{localRequestId:randomUUID()},{connectionVersionId:randomUUID()},{capabilityVersionId:randomUUID()},{prompt:input.prompt+'x'},{model:'grok-imagine-video-6s'},{parameters:{seconds:6,size:'1280x720'}},{parameters:{}},{parameters:{seconds:5}},{inputAssets:[{assetId:randomUUID()}]}])assert.equal(local.allowsInput({...input,...diff}),false);
 assert.equal(local.allows(input,{...auth,baseUrl:'https://example.com/v1'},capability),false);assert.equal(local.allows(input,auth,{...capability,id:randomUUID()}),false);
 const ctx={...auth,mode:input.mode,model:input.model,parameters:{seconds:6},fields:{prompt:input.prompt},inputAssets:[]};local.authorizeContext(ctx,input,auth,capability);assert.equal(local.candidateFor(ctx),'without-size');assert.equal(local.candidateFor({...ctx,candidate:'without-size'}),null);posts=1;assert.equal(local.allowsInput(input),false);assert.equal(local.candidateFor(ctx),null);
});
test('canonical adapter sends exactly three scalar fields and no size/files through actual CONNECT wire once',async t=>{
 const env=await rig(t);let posts=0;gate.configure(options(()=>posts===0));t.after(()=>gate.revoke());
 const snapshot=snapshotFor(input,'1');assert.deepEqual(snapshot.parameters,{seconds:6});
 assert.throws(()=>snapshotFor({...input,mode:'video.single_reference',inputAssets:[{assetId:randomUUID(),position:0,role:'reference'}]},'1'),{code:'INPUT_INVALID'});for(const diff of [{localRequestId:randomUUID()},{model:'grok-imagine-video-6s'}])assert.throws(()=>validateCapability({prepare:()=>({get:()=>capability})},snapshotFor({...input,...diff},'1'),auth),{code:'CAPABILITY_UNVERIFIED'});
 const context={...auth,mode:input.mode,model:input.model,parameters:{seconds:6},fields:{prompt:input.prompt},inputAssets:[],candidate:'without-size'};assert.throws(()=>driver.buildSubmit(context),{code:'CAPABILITY_UNVERIFIED'});
 const db={prepare:()=>({get:()=>capability})},validate=(s,a)=>validateCapability(db,s,a),plugin={id:'opensosen-video',allowedHosts:new Set(['newapi.opensosen.com']),manifest:{version:'1',runtime:{}},driver};
 const adapter=createPluginAdapter(plugin,{readAsset:()=>{throw Error('NO_FILES_ALLOWED')},validateCapability:validate,authorizeContext:(ctx,s,a)=>gate.authorizeContext(ctx,s,a,validate(s,a))});
 const task={request_json:JSON.stringify({mode:input.mode,model:input.model,fields:{prompt:input.prompt}}),input_snapshot_json:JSON.stringify(snapshot)};await adapter.preflight(task,snapshot,auth);
 const original=global.fetch;t.after(()=>{global.fetch=original});global.fetch=async(url,init)=>{assert.equal(url,auth.baseUrl+'/videos');assert.equal(posts,0);posts=1;return env.network.fetch(env.url,init)};
 const accepted=await adapter.submit(task,snapshot,auth);assert.equal(accepted.upstreamTaskId,'fixture-text-original-id');assert.equal(env.records.length,1);assert.equal(env.connects(),1);
 const record=env.records[0];assert.equal(record.method,'POST');assert.equal(record.path,'/v1/videos');assert.equal(record.authorization,'Bearer '+auth.apiKey);assert.match(record.contentType,/^multipart\/form-data; boundary=/);
 const form=await new Response(record.bytes,{headers:{'content-type':record.contentType}}).formData();assert.deepEqual([...form.entries()],[['model',input.model],['prompt',input.prompt.replace(/\r?\n/g,'\r\n')],['seconds','6']]);assert.equal([...form.values()].every(x=>typeof x==='string'),true);for(const name of ['size','input_reference','input_reference[]'])assert.equal(form.has(name),false);
 await assert.rejects(adapter.submit(task,snapshot,auth),{code:'CAPABILITY_UNVERIFIED'});assert.equal(env.records.length,1);assert.throws(()=>validateCapability(db,snapshotFor(input,'1'),auth),{code:'CAPABILITY_UNVERIFIED'});assert.equal(capability.evidence_level,'unverified');assert.equal(capability.parameters_json,'{}');
 t.diagnostic(JSON.stringify({candidate:'without-size',postCount:1,proxyConnects:1,scalarCount:3,fileParts:0,sizeParts:0,inputReferenceParts:0}));
});
