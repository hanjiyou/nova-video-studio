'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID,createHash}=require('node:crypto'),Database=require('better-sqlite3');
const rules=require('../connections/video-rules'),policy=require('../tasks/video-policy'),driver=require('../plugins/opensosen-video');
const {migrateDatabase}=require('../storage/migrations'),{createConnectionService}=require('../connections/service');
const {snapshotFor,validateCapability}=require('../tasks/workbench-input'),{start}=require('./support/desktop-http-runtime.cjs');
const A='fixture-video-dynamic-alpha',B='fixture-video-dynamic-beta',CHAT='fixture-chat-only',KEY='synthetic-inherited-video-key';
const list=()=>[{id:A,supported_endpoint_types:['video-generation']},{id:B,supported_endpoint_types:['openai']},{id:CHAT,supported_endpoint_types:['openai']}];
const cleanup=directory=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5});};
async function setup(t,baseUrl=rules.RULES.baseUrl){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-video-inherit-')),filename=path.join(directory,'tasks.sqlite');
  const db=new Database(filename);await migrateDatabase({db,dbPath:filename});
  let visible=list(),offline=false;
  const vault={store:()=>randomUUID(),read:()=>KEY,state:()=> 'ready'};
  const service=createConnectionService({db,vault,fetchImpl:async url=>{if(new URL(url).pathname==='/api/pricing')return Response.json({data:[]});if(offline)throw Error('synthetic offline');return Response.json({data:visible});}});
  const connection=service.save({baseUrl,apiKey:KEY});
  t.after(()=>{db.close();cleanup(directory);});
  return {directory,db,service,connection,auth:service.getAuth(connection.connectionVersionId),setList:value=>{visible=value;},setOffline:value=>{offline=value;},check:()=>service.check(connection.connectionId,{connectionVersionId:connection.connectionVersionId,force:true})};
}
function bodyFor(f,model=A,parameters={seconds:2},mode='video.text',assets=[]){
  const catalog=f.service.models(f.connection.connectionId),cap=catalog.capabilities.find(row=>row.model===model&&row.mode===mode&&row.configurationCurrent);
  assert.ok(cap,'A classified video model has its own current capability');
  return {localRequestId:randomUUID(),connectionVersionId:f.connection.connectionVersionId,capabilityVersionId:cap.capabilityVersionId,mode,model,prompt:'Synthetic dynamic video',parameters,inputAssets:assets};
}
function saveDisplay(f,patch){const catalog=f.service.models(f.connection.connectionId),{revision,...settings}=catalog.displaySettings;return f.service.updateModelDisplay(f.connection.connectionId,{connectionVersionId:catalog.connectionVersionId,expectedRouteRevision:catalog.routeRevision,expectedRevision:revision,...settings,...patch});}

test('dynamic video catalog and user classification inherit protocol without production model registration',async t=>{
  const f=await setup(t);assert.equal(Object.hasOwn(rules.RULES.models,A),false);assert.equal(Object.hasOwn(rules.RULES.models,B),false);
  let catalog=await f.check();
  assert.ok(catalog.videoRules[A]);assert.equal(catalog.videoRules[B],undefined);assert.equal(catalog.videoRules[CHAT],undefined);
  assert.equal(catalog.capabilities.some(cap=>cap.model===CHAT),false);
  catalog=f.service.updateModelSettings(f.connection.connectionId,{connectionVersionId:f.connection.connectionVersionId,model:B,categories:['video']});
  assert.ok(catalog.videoRules[B]);assert.equal(catalog.videoRules[A].maxSeconds,null);assert.equal(catalog.videoRules[A].defaultSeconds,2);
  assert.equal(catalog.videoRules[A].sizeOptional,true);assert.equal(catalog.videoRules[A].defaultSize,null);assert.equal(catalog.videoRules[A].centsPerSecond,null);
  const a=catalog.capabilities.find(cap=>cap.model===A&&cap.mode==='video.text'&&cap.configurationCurrent),b=catalog.capabilities.find(cap=>cap.model===B&&cap.mode==='video.text'&&cap.configurationCurrent);
  assert.notEqual(a.capabilityVersionId,b.capabilityVersionId);assert.equal(a.evidenceLevel,'unverified');assert.equal(a.evidence.applicationVerified,false);
  assert.equal(catalog.displaySettings.videoModels.includes(A),false);assert.equal(catalog.displaySettings.videoModels.includes(B),false);
  const input=bodyFor(f,A,{seconds:37,size:'720x1280'}),snapshot=snapshotFor(input,'1.1.0',f.db.prepare('SELECT * FROM model_capabilities WHERE id=?').get(input.capabilityVersionId));
  const cap=validateCapability(f.db,snapshot,f.auth),context={...f.auth,model:A,mode:snapshot.mode,fields:{prompt:snapshot.prompt},parameters:snapshot.parameters,inputAssets:[]};
  policy.authorizeContext(context,snapshot,f.auth,cap);assert.equal(policy.isAuthorizedContext(context),true);
  assert.deepEqual(driver.buildSubmit(context).parts.map(part=>[part.name,part.value]),[['model',A],['prompt',snapshot.prompt],['seconds','37'],['size','720x1280']]);
  const noSize=bodyFor(f,A),noSnapshot=snapshotFor(noSize,'1.1.0'),noCap=validateCapability(f.db,noSnapshot,f.auth),noContext={...f.auth,model:A,mode:noSnapshot.mode,fields:{prompt:noSnapshot.prompt},parameters:noSnapshot.parameters,inputAssets:[]};
  policy.authorizeContext(noContext,noSnapshot,f.auth,noCap);assert.equal(driver.buildSubmit(noContext).parts.some(part=>part.name==='size'),false);
  const updated=f.service.updateModelSettings(f.connection.connectionId,{connectionVersionId:f.connection.connectionVersionId,model:A,defaultSeconds:37});
  assert.equal(updated.modelSettings[A].defaultSeconds,37);
  for(const parameters of [{seconds:0},{seconds:1.5},{seconds:'2'},{seconds:Number.MAX_SAFE_INTEGER+1},{seconds:2,size:'0x1280'},{seconds:2,size:null},{seconds:2,unknown:true}])assert.equal(rules.validParameters(catalog.videoRules[A],parameters,'video.text'),false);
  assert.equal(rules.validParameters(rules.videoRule(rules.LEGACY.primaryModel),{seconds:2,size:'720x1280'},'video.text'),false,'An exact no-size override wins');
});

test('scope, explicit closures and invalid exact rules cannot be opened by defaults',async t=>{
  for(const baseUrl of ['https://custom.invalid/v1','https://newapi.opensosen.com.evil.invalid/v1']){
    const f=await setup(t,baseUrl),catalog=await f.check();assert.equal(catalog.videoRules[A],undefined);assert.equal(catalog.capabilities.some(cap=>cap.model===A),false);
  }
  const scope={provider:'opensosen',baseUrl:rules.RULES.baseUrl,protocol:'openai'};
  assert.equal(rules.videoRule(A,{...scope,provider:'openai-compatible'}),null);
  assert.equal(rules.videoRule(A,{...scope,protocol:'anthropic'}),null);
  for(const existing of ['grok-imagine-video-6s','grok-imagine-video-1.5-preview'])assert.equal(rules.videoRule(existing,scope).submissionEnabled,false);
  assert.equal(rules.videoRule('doubao-seedance-2.0-mini',scope),null);
  for(const exact of [null,[],{profile:null},{profile:'missing-driver'},{maxSeconds:-1},{sendSize:false,sizeOptional:true}])assert.equal(rules.videoRule(A,scope,{...rules.RULES,models:{[A]:exact}}),null);
  assert.equal(rules.videoRule(A,scope,{...rules.RULES,models:{[A]:{submissionEnabled:false}}}).submissionEnabled,false);
  const cn=await setup(t,'https://newapi.opensosen.cn/v1'),catalog=await cn.check(),input=bodyFor(cn),snapshot=snapshotFor(input,'1.1.0'),cap=validateCapability(cn.db,snapshot,cn.auth),context={...cn.auth,model:A,mode:snapshot.mode,fields:{prompt:snapshot.prompt},parameters:snapshot.parameters,inputAssets:[]};
  assert.ok(catalog.videoRules[A]);policy.authorizeContext(context,snapshot,cn.auth,cap);assert.equal(driver.buildQuery('cn-original',context).url,'https://newapi.opensosen.cn/v1/videos/cn-original');
});

test('template changes append capabilities, preserve frozen records and do not invalidate old task authority',async t=>{
  const f=await setup(t);await f.check();const input=bodyFor(f,A,{seconds:37}),snapshot=snapshotFor(input,'1.1.0'),cap=validateCapability(f.db,snapshot,f.auth),before={...cap};
  const original={...rules.RULES.videoDefaults};
  try {
    rules.RULES.videoDefaults.maxSeconds=3;
    const catalog=f.service.models(f.connection.connectionId),entries=catalog.capabilities.filter(row=>row.model===A&&row.mode==='video.text'&&row.evidenceVersion===rules.RULES.version);
    assert.equal(entries.filter(row=>row.configurationCurrent).length,1);assert.equal(entries.find(row=>row.configurationCurrent).parameters.maxSeconds,3);
    assert.deepEqual(f.db.prepare('SELECT * FROM model_capabilities WHERE id=?').get(cap.id),before);
    assert.equal(policy.allowsNewSubmission(snapshot,f.auth),false);assert.equal(policy.allows(cap,snapshot,f.auth),true);
    rules.RULES.videoDefaults.submissionEnabled=false;assert.equal(policy.allowsNewSubmission({...snapshot,parameters:{seconds:2}},f.auth),false);assert.equal(policy.allows(cap,snapshot,f.auth),true);
  } finally { Object.assign(rules.RULES.videoDefaults,original); }
});

test('successful removals retain category and old selection; absent/custom cannot be newly selected or reassigned as default',async t=>{
  const f=await setup(t);await f.check();saveDisplay(f,{imageModels:[],defaultImageModel:null,videoModels:[A],defaultVideoModel:A});
  f.service.updateModelSettings(f.connection.connectionId,{connectionVersionId:f.connection.connectionVersionId,model:A,custom:true});
  f.setList([]);let catalog=await f.check();assert.equal(catalog.models.find(row=>row.model===A).visibility,'absent');assert.deepEqual(catalog.models.find(row=>row.model===A).categories,['video']);
  assert.equal(catalog.displaySettings.defaultVideoModel,A);
  catalog=saveDisplay(f,{pricingGroup:null});assert.equal(catalog.displaySettings.defaultVideoModel,A,'An unchanged absent old default remains a historical selection');
  assert.throws(()=>saveDisplay(f,{videoModels:[A,B],defaultVideoModel:A}),{code:'MODEL_DISPLAY_INVALID'});
  saveDisplay(f,{videoModels:[],defaultVideoModel:null});
  assert.throws(()=>saveDisplay(f,{videoModels:[A],defaultVideoModel:A}),{code:'MODEL_DISPLAY_INVALID'},'Removing the old choice does not permit adding it back');
  f.setOffline(true);const time=catalog.modelsFetchedAt;catalog=await f.check();assert.equal(catalog.modelsFetchedAt,time);assert.equal(catalog.models.find(row=>row.model===A).visibility,'absent');assert.ok(catalog.refreshError);
});

test('legacy string known catalogs migrate additively and retain only approved model endpoint metadata',async t=>{
  const f=await setup(t);await f.check();
  const row=f.db.prepare("SELECT key FROM app_settings WHERE key LIKE '%:known'").get(),legacy='grok-imagine-video-retired-fixture';
  f.db.prepare('UPDATE app_settings SET value_json=? WHERE key=?').run(JSON.stringify([legacy]),row.key);
  assert.ok(f.service.models(f.connection.connectionId).models.some(item=>item.model===legacy));
  f.setList([{id:A,supported_endpoint_types:['video-generation','unapproved-custom-endpoint'],arbitrary:'untrusted-ignored-field',url:'https://ignored.invalid/private'}]);
  await f.check();
  const remembered=JSON.parse(f.db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(row.key).value_json);
  assert.ok(remembered.some(item=>item.model===legacy));
  assert.deepEqual(remembered.find(item=>item.model===A),{model:A,endpointTypes:['video-generation']});
  assert.ok(remembered.every(item=>Object.keys(item).sort().join(',')==='endpointTypes,model'));
  assert.equal(JSON.stringify(remembered).includes('untrusted-ignored-field'),false);
  f.setList([]);const catalog=await f.check(),retired=catalog.models.find(item=>item.model===A);
  assert.equal(retired.visibility,'absent');assert.deepEqual(retired.categories,['video']);
});

test('two unregistered models complete protected HTTP flow, retain ordered bytes, reject stale intent and resume original ID after restart',{timeout:90000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-video-inherit-http-')),video=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4')),calls=[];
  let visible=list(),hold=false;
  const upstream=http.createServer(async(req,res)=>{
    if(req.url==='/api/pricing'){res.setHeader('content-type','application/json');res.end('{"data":[]}');return;}
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:visible}));return;}
    if(req.method==='POST'&&req.url==='/v1/videos'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData(),parts=[];
      for(const[name,value]of form.entries())parts.push(typeof value==='string'?{name,value}:{name,bytes:Buffer.from(await value.arrayBuffer()),fileName:value.name});
      const id='original-'+(calls.filter(call=>call.method==='POST').length+1);calls.push({method:'POST',model:form.get('model'),parts,id});
      res.setHeader('content-type','application/json');res.end(JSON.stringify({id}));return;
    }
    calls.push({method:req.method,path:req.url});
    if(req.url.endsWith('/content')){res.setHeader('content-type','video/mp4');res.end(video);return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:hold?'in_progress':'completed',progress:hold?30:100}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const opensosenOrigin='http://127.0.0.1:'+upstream.address().port;
  let runtime=await start(directory,{opensosenOrigin});
  t.after(async()=>{await runtime.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));cleanup(directory);});
  const connection=await runtime.saveConnection({baseUrl:rules.RULES.baseUrl,apiKey:KEY}),prefix='/api/nova/connections/'+connection.connectionId;
  const request=(route,body,method='POST')=>runtime.request(route,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const check=async()=>{const response=await request(prefix+'/check',{connectionVersionId:connection.connectionVersionId,force:true});assert.equal(response.status,200);return response.json();};
  let catalog=await check();assert.ok(catalog.videoRules[A]);assert.equal(catalog.videoRules[B],undefined);
  let response=await request(prefix+'/model-settings',{connectionVersionId:connection.connectionVersionId,model:B,categories:['video']},'PUT');assert.equal(response.status,200);catalog=await response.json();
  const display=async patch=>{const {revision,...settings}=catalog.displaySettings;const response=await request(prefix+'/model-display',{connectionVersionId:connection.connectionVersionId,expectedRouteRevision:catalog.routeRevision,expectedRevision:revision,...settings,...patch},'PUT');assert.equal(response.status,200,JSON.stringify(await response.clone().json()));catalog=await response.json();};
  await display({imageModels:[],defaultImageModel:null,videoModels:[A,B],defaultVideoModel:A});
  const inputs=[];
  for(const name of ['reference-a.png','reference-single.jpg']){const bytes=fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1',name));const response=await runtime.request('/api/nova/assets/import',{method:'POST',headers:{'content-type':name.endsWith('.png')?'image/png':'image/jpeg'},body:bytes});assert.equal(response.status,201);inputs.push({asset:(await response.json()).asset,bytes});}
  const make=(model,parameters,mode='video.text')=>({localRequestId:randomUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:catalog.capabilities.find(cap=>cap.model===model&&cap.mode===mode&&cap.configurationCurrent).capabilityVersionId,mode,model,prompt:'Synthetic inherited protocol',parameters,inputAssets:mode==='video.text'?[]:inputs.slice().reverse().map(({asset},position)=>({assetId:asset.assetId,position,role:'reference'}))});
  const until=async fn=>{const deadline=Date.now()+25000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Synthetic inherited HTTP timed out');};
  const task=id=>runtime.request('/api/nova/tasks/'+id).then(response=>response.json());
  const post=body=>request('/api/nova/workbench/tasks',body);
  const admitted=[];
  for(const body of [make(A,{seconds:2,size:'720x1280'}),make(B,{seconds:37},'video.dual_reference')]){
    const response=await post(body);assert.equal(response.status,202,JSON.stringify(await response.clone().json()));const taskId=(await response.json()).taskId;
    assert.equal((await(await post(body)).json()).taskId,taskId);
    const completed=await until(async()=>{const value=await task(taskId);return value.status==='completed'?value:null;});assert.equal(completed.outputAssets[0].validationState,'verified');
    const sent=calls.find(call=>call.method==='POST'&&call.model===body.model);assert.equal(sent.parts.find(part=>part.name==='seconds').value,String(body.parameters.seconds));assert.equal(sent.parts.some(part=>part.name==='size'),body.model===A);
    if(body.model===B)assert.deepEqual(sent.parts.filter(part=>part.name==='input_reference').map(part=>createHash('sha256').update(part.bytes).digest('hex')),inputs.slice().reverse().map(input=>createHash('sha256').update(input.bytes).digest('hex')));
    admitted.push({body,taskId});
  }
  assert.equal(calls.filter(call=>call.method==='POST').length,2);
  assert.equal((await post({...admitted[0].body,prompt:'different intent'})).status,409);
  const chat=await post({...admitted[0].body,localRequestId:randomUUID(),model:CHAT});assert.equal(chat.status,409);assert.equal((await chat.json()).code,'MODEL_HIDDEN','An unclassified chat row cannot borrow a video capability or display choice');
  await request(prefix+'/model-settings',{connectionVersionId:connection.connectionVersionId,model:A,categories:['image']},'PUT');
  assert.equal((await post({...admitted[0].body,localRequestId:randomUUID()})).status,400,'Old video capability does not override current classification');
  await request(prefix+'/model-settings',{connectionVersionId:connection.connectionVersionId,model:A,categories:['video']},'PUT');
  catalog=await check();
  hold=true;const recovering=make(A,{seconds:2}),accepted=await post(recovering);assert.equal(accepted.status,202);const recoveringId=(await accepted.json()).taskId;
  await until(async()=>{const value=await task(recoveringId);return value.upstreamTaskId?value:null;});
  await runtime.crash();const db=new Database(path.join(directory,'tasks.sqlite'));db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE id=?").run(recoveringId);db.close();
  visible=[];hold=false;runtime=await start(directory,{opensosenOrigin});catalog=await check();
  assert.equal(catalog.models.find(row=>row.model===A).visibility,'absent');assert.deepEqual(catalog.models.find(row=>row.model===A).categories,['video']);
  for(const {body,taskId}of admitted){const replay=await post(body);assert.equal(replay.status,202);assert.equal((await replay.json()).taskId,taskId);assert.equal((await post({...body,localRequestId:randomUUID()})).status,400);}
  await request(prefix+'/model-settings',{connectionVersionId:connection.connectionVersionId,model:A,custom:true},'PUT');
  assert.equal((await post({...admitted[0].body,localRequestId:randomUUID()})).status,400,'Custom cannot bypass a successful empty directory');
  assert.equal((await request('/api/nova/tasks/'+recoveringId+'/resume-polling',{})).status,200);
  await until(async()=>{const value=await task(recoveringId);return value.status==='completed'?value:null;});
  assert.equal(calls.filter(call=>call.method==='POST').length,3,'Restart/removal/replay/resume query only original IDs');
});
