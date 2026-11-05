'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const rules=require('../connections/video-rules'),{migrateDatabase}=require('../storage/migrations'),{createConnectionService}=require('../connections/service');
const {snapshotFor,validateCapability}=require('../tasks/workbench-input'),policy=require('../tasks/video-policy'),driver=require('../plugins/opensosen-video');
const {start}=require('./support/desktop-http-runtime.cjs');
const first='fixture-video-alpha',second='fixture-video-beta',key='synthetic-video-config-key';
function definitions(){const template=Object.values(rules.RULES.models).find(rule=>rule.submissionEnabled);return {
  [first]:{...template,label:'Fixture Alpha',preset:false,legacyUi:false,modes:['video.text','video.single_reference'],minSeconds:2,maxSeconds:8,defaultSeconds:4,centsPerSecond:7},
  [second]:{...template,label:'Fixture Beta',preset:false,legacyUi:false,modes:['video.text','video.dual_reference','video.multi_reference'],minSeconds:2,maxSeconds:10,defaultSeconds:6,sendSize:true,sizes:['640x360'],defaultSize:'640x360',centsPerSecond:null,referenceLimits:{'video.multi_reference':{min:3,max:4}}}
};}
async function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-video-config-'));const db=new Database(path.join(directory,'test.sqlite'));await migrateDatabase({db,dbPath:db.name});const additions=definitions();Object.assign(rules.RULES.models,additions);t.after(()=>{for(const name of Object.keys(additions))delete rules.RULES.models[name];db.close();fs.rmSync(directory,{recursive:true,force:true,maxRetries:4});});const vault={store:()=>randomUUID(),read:()=>key,state:()=> 'ready'},service=createConnectionService({db,vault,fetchImpl:async()=>Response.json({data:[]})}),connection=service.save({baseUrl:rules.RULES.baseUrl,apiKey:key});return {db,service,connection,auth:service.getAuth(connection.connectionVersionId)};}
function input(f,model,mode='video.text',count=0){const cap=f.service.models(f.connection.connectionId).capabilities.find(item=>item.model===model&&item.mode===mode&&item.evidenceVersion===rules.RULES.version);const rule=rules.videoRule(model);return {localRequestId:randomUUID(),connectionVersionId:f.connection.connectionVersionId,capabilityVersionId:cap.capabilityVersionId,mode,model,prompt:'synthetic prompt',parameters:{seconds:rule.defaultSeconds,...(rule.sendSize?{size:rule.defaultSize}:{})},inputAssets:Array.from({length:count},(_,position)=>({assetId:randomUUID(),position,role:'reference'}))};}

test('unseen model names gain classification, rules, capabilities and actual wire requests from configuration alone',async t=>{
  const f=await setup(t),catalog=f.service.models(f.connection.connectionId);
  for(const name of [first,second]){
    assert.equal(catalog.models.find(item=>item.model===name)?.submissionEnabled,true);assert.deepEqual(catalog.models.find(item=>item.model===name).categories,['video']);
    assert.equal(catalog.videoRules[name].defaultSeconds,name===first?4:6);
    const snapshot=snapshotFor(input(f,name),'1.1.0'),cap=validateCapability(f.db,snapshot,f.auth),context={...f.auth,model:name,mode:snapshot.mode,fields:{prompt:snapshot.prompt},parameters:snapshot.parameters,inputAssets:[]};
    policy.authorizeContext(context,snapshot,f.auth,cap);assert.equal(policy.isAuthorizedContext(context),true);
    const submit=driver.buildSubmit(context);assert.equal(submit.url,f.auth.baseUrl+'/videos');assert.equal(submit.parts.find(item=>item.name==='model').value,name);assert.equal(submit.parts.some(item=>item.name==='size'),name===second);
    const query=driver.buildQuery('synthetic-id',context);assert.equal(query.url,f.auth.baseUrl+'/videos/synthetic-id');
    const result=driver.parseTaskResult({status:'completed'},{...context,upstreamTaskId:'synthetic-id'});assert.equal(result.assets[0].url,f.auth.baseUrl+'/videos/synthetic-id/content');
    assert.equal(cap.evidence_level,'unverified');assert.equal(JSON.parse(cap.evidence_json).applicationVerified,false);
  }
});

test('configured mode, integer bounds, reference budget, price and driver support remain independent gates',async t=>{
  const f=await setup(t),a=rules.videoRule(first),b=rules.videoRule(second);
  assert.equal(rules.validParameters(a,{seconds:8},'video.text'),true);assert.equal(rules.validParameters(a,{seconds:9},'video.text'),false);
  assert.equal(rules.validParameters(a,{seconds:4,size:'640x360'},'video.text'),false);assert.equal(rules.validParameters(a,{seconds:4},'video.dual_reference'),false);
  assert.equal(rules.validReferences(b,'video.multi_reference',Array(4)),true);assert.equal(rules.validReferences(b,'video.multi_reference',Array(5)),false);assert.equal(b.centsPerSecond,null);
  const unsupported={...definitions()[first],modes:['video.first_last_frame']};assert.equal(rules.videoRule('fixture-video-unsupported',null,{...rules.RULES,models:{'fixture-video-unsupported':unsupported}}),null);
  assert.equal(rules.videoRule('toString'),null);assert.equal(rules.videoRule(first,{provider:'other',baseUrl:rules.RULES.baseUrl}),null);
  for(const malformed of [null,[],{...definitions()[first],profile:'missing-driver'},{...definitions()[first],maxSeconds:Number.MAX_SAFE_INTEGER+1}])assert.equal(rules.videoRule(first,null,{...rules.RULES,models:{[first]:malformed}}),null);
  assert.throws(()=>snapshotFor({...input(f,first),model:'fixture-video-unregistered'},'1.1.0'),{code:'INPUT_INVALID'});
  const existing=input(f,first),snapshot=snapshotFor(existing,'1.1.0'),cap=validateCapability(f.db,snapshot,f.auth);
  rules.RULES.models[first].maxSeconds=3;rules.RULES.models[first].defaultSeconds=3;
  assert.equal(policy.allowsNewSubmission(snapshot,f.auth),false,'A stale capability cannot bypass current duration limits for a new intent');
  assert.equal(policy.allows(cap,snapshot,f.auth),true,'Previously accepted task keeps its frozen duration limits');
  const originalVersion=rules.RULES.version;
  try{rules.RULES.version='fixture-next-version';assert.equal(policy.allows(cap,snapshot,f.auth),true,'Configuration version changes do not invalidate frozen protocol snapshots');}finally{rules.RULES.version=originalVersion;}
  rules.RULES.models[first].submissionEnabled=false;
  assert.equal(policy.allowsNewSubmission(snapshot,f.auth),false);assert.equal(policy.allows(cap,snapshot,f.auth),true,'Existing task retains its frozen capability');
  assert.throws(()=>validateCapability(f.db,{...snapshot,parameters:{seconds:99}},f.auth),{code:'CAPABILITY_UNVERIFIED'});
});

test('new capability versions are additive and replay legacy configured rows without rewriting them',async t=>{
  const f=await setup(t),legacy=f.db.prepare('SELECT * FROM model_capabilities WHERE evidence_version=? AND model=? AND mode=?').get(rules.LEGACY.version,rules.LEGACY.primaryModel,'video.text');
  assert.ok(legacy);assert.deepEqual(JSON.parse(legacy.parameters_json),rules.LEGACY.models[rules.LEGACY.primaryModel]);
  const all=f.db.prepare('SELECT * FROM model_capabilities ORDER BY id').all();
  createConnectionService({db:f.db,vault:{read:()=>key,state:()=> 'ready'}});
  assert.deepEqual(f.db.prepare('SELECT * FROM model_capabilities ORDER BY id').all(),all);
  const snapshot={mode:legacy.mode,model:legacy.model,parameters:{seconds:3},inputAssets:[],connectionVersionId:f.auth.connectionVersionId,capabilityVersionId:legacy.id};
  assert.equal(validateCapability(f.db,snapshot,f.auth).id,legacy.id);
});

test('editing a configured rule appends a new capability and distinguishes it from older snapshots',async t=>{
  const f=await setup(t),old=input(f,first),snapshot=snapshotFor(old,'1.1.0'),before=f.db.prepare('SELECT * FROM model_capabilities WHERE id=?').get(snapshot.capabilityVersionId);
  rules.RULES.models[first].maxSeconds=12;rules.RULES.models[first].defaultSeconds=10;
  createConnectionService({db:f.db,vault:{read:()=>key,state:()=> 'ready'}});
  const entries=f.service.models(f.connection.connectionId).capabilities.filter(cap=>cap.model===first&&cap.mode==='video.text'&&cap.evidenceVersion===rules.RULES.version);
  assert.equal(entries.filter(cap=>cap.configurationCurrent).length,1);assert.equal(entries.find(cap=>cap.configurationCurrent).parameters.defaultSeconds,10);
  assert.equal(entries.find(cap=>cap.capabilityVersionId===before.id).configurationCurrent,false);assert.deepEqual(f.db.prepare('SELECT * FROM model_capabilities WHERE id=?').get(before.id),before);
  assert.equal(validateCapability(f.db,snapshot,f.auth).id,before.id);
});

test('actual authenticated HTTP pipeline submits, queries, validates and saves two new configured models without production code changes', {timeout:60000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-video-profile-http-')),video=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4')),calls=[];
  const upstream=http.createServer(async(req,res)=>{
    if(req.url==='/api/pricing'){res.setHeader('content-type','application/json');res.end('{"data":[]}');return;}
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[first,second,rules.LEGACY.primaryModel].map(id=>({id,supported_endpoint_types:['video-generation']}))}));return;}
    if(req.method==='POST'&&req.url==='/v1/videos'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();const model=form.get('model');calls.push({method:'POST',model,fields:[...form.entries()]});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:model}));return;}
    calls.push({method:req.method,path:req.url});
    if(req.url.endsWith('/content')){res.setHeader('content-type','video/mp4');res.end(video);return;}
    res.setHeader('content-type','application/json');res.end('{"status":"completed","progress":100}');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const opensosenOrigin='http://127.0.0.1:'+upstream.address().port;
  let runtime=await start(directory,{opensosenOrigin,videoModels:definitions()});
  t.after(async()=>{await runtime.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(directory,{recursive:true,force:true,maxRetries:4});});
  const connection=await runtime.saveConnection({baseUrl:rules.RULES.baseUrl,apiKey:key});
  const catalog=await(await runtime.request('/api/nova/connections/'+connection.connectionId+'/models')).json();
  const post=body=>runtime.request('/api/nova/workbench/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const accepted=[];
  for(const model of [first,second]){
    const rule=catalog.videoRules[model],cap=catalog.capabilities.find(item=>item.model===model&&item.mode==='video.text'&&item.evidenceVersion===rules.RULES.version);
    const body={localRequestId:randomUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:cap.capabilityVersionId,mode:'video.text',model,prompt:'Synthetic HTTP video',parameters:{seconds:rule.defaultSeconds,...(rule.sendSize?{size:rule.defaultSize}:{})},inputAssets:[]};
    const response=await post(body);assert.equal(response.status,202);const taskId=(await response.json()).taskId;assert.equal((await(await post(body)).json()).taskId,taskId);accepted.push({body,taskId});
    let task;const end=Date.now()+26000;while(Date.now()<end){task=await(await runtime.request('/api/nova/tasks/'+taskId)).json();if(['completed','failed','download_failed'].includes(task.status))break;await new Promise(resolve=>setTimeout(resolve,40));}
    assert.equal(task.status,'completed',JSON.stringify(task.taskError));assert.equal(task.model,model);assert.equal(task.outputAssets[0].validationState,'verified');
    const sent=calls.filter(call=>call.method==='POST'&&call.model===model);assert.equal(sent.length,1);assert.equal(sent[0].fields.some(([name])=>name==='size'),model===second);
    assert.ok(calls.some(call=>call.path==='/v1/videos/'+model+'/content'));
  }
  const changed=definitions();changed[first].maxSeconds=3;changed[first].defaultSeconds=3;changed[second].submissionEnabled=false;
  await runtime.stop();runtime=await start(directory,{opensosenOrigin,videoModels:changed});
  for(const {body,taskId}of accepted){
    const replay=await post(body);assert.equal(replay.status,202);assert.equal((await replay.json()).taskId,taskId);
    assert.equal((await post({...body,localRequestId:randomUUID()})).status,400,'A new intent cannot borrow old duration/open-state authorization');
    assert.equal((await post({...body,prompt:'changed intent'})).status,409,'A repeated ID cannot change its frozen intent');
  }
  assert.equal(calls.filter(call=>call.method==='POST').length,2,'Configuration changes must not create another generation POST');
});
