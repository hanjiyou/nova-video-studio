'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {createControlledVideoTextValidationGate,controlledVideoTextValidation}=require('../tasks/controlled-video-text-validation');
const {validateCapability,snapshotFor}=require('../tasks/workbench-input');
const {createPluginAdapter}=require('../tasks/plugin-adapter');
const driver=require('../plugins/opensosen-video');
const prompt='  candidate 中文\nsecond line  ',id=randomUUID(),connection=randomUUID(),request=randomUUID();
const snapshot={mode:'video.text',model:'grok-imagine-video-1.5-6s',localRequestId:request,connectionVersionId:connection,capabilityVersionId:id,prompt,parameters:{seconds:6,size:'1280x720'},inputAssets:[]};
const auth={connectionVersionId:connection,provider:'opensosen',baseUrl:'https://newapi.opensosen.com/v1',protocol:'openai',apiKey:'synthetic-only'};
const capability={id,provider:auth.provider,base_url:auth.baseUrl,protocol:'openai',mode:snapshot.mode,model:snapshot.model,evidence_level:'unverified',parameters_json:'{}'};
const options=dispatchPermitted=>({localRequestId:request,connectionVersionId:connection,capabilityVersionId:id,promptSha256:createHash('sha256').update(prompt).digest('hex'),dispatchPermitted});
const context=()=>({...auth,mode:snapshot.mode,model:snapshot.model,fields:{prompt},parameters:{...snapshot.parameters},inputAssets:[]});
test('unverified text defaults to denial at both gates; renderer flags cannot authorize it',()=>{
 const db={prepare:()=>({get:()=>capability})};assert.throws(()=>validateCapability(db,snapshot,auth),{code:'CAPABILITY_UNVERIFIED'});
 assert.throws(()=>driver.buildSubmit({...context(),videoTextAuthorized:true}),{code:'CAPABILITY_UNVERIFIED'});
 assert.throws(()=>snapshotFor({...snapshot,controlledVideoText:true},'1'),{code:'INPUT_INVALID'});
});
test('exact host permit rejects tuple, prompt, reference, parameter and budget mismatches',()=>{
 let posts=0;const gate=createControlledVideoTextValidationGate();gate.configure(options(()=>posts===0));assert.equal(gate.allows(snapshot,auth,capability),true);
 for(const diff of [{mode:'video.single_reference'},{model:'grok-imagine-video-6s'},{localRequestId:randomUUID()},{connectionVersionId:randomUUID()},{capabilityVersionId:randomUUID()},{prompt:prompt+'x'},{parameters:{seconds:6,size:'1280x720',other:true}},{parameters:{seconds:5,size:'1280x720'}},{parameters:{seconds:6,size:'720x1280'}},{inputAssets:[{assetId:randomUUID()}]}])assert.equal(gate.allows({...snapshot,...diff},auth,capability),false);
 for(const diff of [{connectionVersionId:randomUUID()},{provider:'other'},{baseUrl:'https://example.com/v1'},{protocol:'other'}])assert.equal(gate.allows(snapshot,{...auth,...diff},capability),false);
 const trusted=context();gate.authorizeContext(trusted,snapshot,auth,capability);assert.equal(gate.isAuthorizedContext(trusted),true);assert.equal(gate.isAuthorizedContext({...trusted}),false);trusted.fields.prompt+='x';assert.equal(gate.isAuthorizedContext(trusted),false);
 posts=1;assert.equal(gate.allows(snapshot,auth,capability),false);assert.throws(()=>gate.configure(options(()=>true)));gate.revoke();assert.equal(gate.allows(snapshot,auth,capability),false);
 const failed=createControlledVideoTextValidationGate();failed.configure(options(()=>{throw Error()}));assert.equal(failed.allows(snapshot,auth,capability),false);
});
test('canonical adapter preflight and submit require host authority; one refused POST is never retried',async t=>{
 let posts=0;controlledVideoTextValidation.configure(options(()=>posts===0));t.after(()=>controlledVideoTextValidation.revoke());
 const db={prepare:()=>({get:()=>capability})},validate=(s,a)=>validateCapability(db,s,a);
 const plugin={id:'opensosen-video',allowedHosts:new Set(['newapi.opensosen.com']),manifest:{version:'1',permissions:{hosts:['newapi.opensosen.com']},runtime:{}},driver};
 const task={request_json:JSON.stringify({mode:snapshot.mode,model:snapshot.model,fields:{prompt}}),input_snapshot_json:JSON.stringify(snapshot)};
 const readAsset=()=>{throw Error('NO_FILES_ALLOWED')};const normal=createPluginAdapter(plugin,{readAsset,validateCapability:validate});await assert.rejects(normal.preflight(task,snapshot,auth),{code:'CAPABILITY_UNVERIFIED'});
 const adapter=createPluginAdapter(plugin,{readAsset,validateCapability:validate,authorizeContext:(ctx,s,a)=>controlledVideoTextValidation.authorizeContext(ctx,s,a,validate(s,a))});
 assert.equal(validate(snapshot,auth),capability);await adapter.preflight(task,snapshot,auth);assert.equal(capability.evidence_level,'unverified');assert.equal(capability.parameters_json,'{}');
 const original=global.fetch;t.after(()=>{global.fetch=original});global.fetch=async(url,init)=>{assert.equal(url,auth.baseUrl+'/videos');assert.equal(init.method,'POST');assert.deepEqual([...init.body.entries()],[['model',snapshot.model],['prompt',prompt],['seconds','6'],['size','1280x720']]);assert.equal([...init.body.values()].every(x=>typeof x==='string'),true);posts++;return new Response('{"error":{"code":"fixture_refused"}}',{status:400,headers:{'content-type':'application/json'}})};
 await assert.rejects(adapter.submit(task,snapshot,auth),{code:'SUBMISSION_UNKNOWN',httpStatus:400});assert.equal(posts,1);
 await assert.rejects(adapter.submit(task,snapshot,auth),{code:'CAPABILITY_UNVERIFIED'});assert.equal(posts,1);assert.throws(()=>validate(snapshot,auth),{code:'CAPABILITY_UNVERIFIED'});
});
