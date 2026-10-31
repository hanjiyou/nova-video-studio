'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), Database = require('better-sqlite3');
const { migrateDatabase } = require('../storage/migrations');
const { createConnectionService } = require('../connections/service');
const { createWorkbenchStore } = require('../storage/store');
const { PRICING_GROUPS, parseImagePricing, createImagePricing } = require('../connections/image-pricing');
const { start } = require('./support/desktop-http-runtime.cjs');
const BASE = 'https://newapi.opensosen.com/v1', FLARE = 'gpt-image-2.5-flare', SUN = 'gpt-image-2.5-sunburst';
const SIX = 'grok-imagine-video-1.5-6s', PREVIEW = 'grok-imagine-video-1.5-preview', NEW = 'gpt-image-future';
const names = [FLARE, SUN, SIX, PREVIEW, NEW];
const pricePayload = () => ({ success:true, data:[FLARE,SUN].map((model_name,index)=>({model_name,quota_type:1,model_price:index+1,enable_groups:[...PRICING_GROUPS]})), group_ratio:{[PRICING_GROUPS[0]]:0.2,[PRICING_GROUPS[1]]:0.4} });
const cleanup = directory => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory,{recursive:true,force:true,maxRetries:5}); };
async function setup(t, overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'nova-model-display-')), filename = path.join(directory,'tasks.sqlite');
    let db = new Database(filename); await migrateDatabase({db,dbPath:filename});
    const keys = new Map(), vault = { store(value){const ref=randomUUID();keys.set(ref,value);return ref;},read:ref=>keys.get(ref),state:()=> 'ready' };
    let list = names, fail = false, calls = 0;
    const fetchImpl = async url => { if(new URL(url).pathname === '/api/pricing') return Response.json(pricePayload()); calls++; if(fail)throw Error('synthetic');return Response.json({data:list.map(id=>({id}))}); };
    const make = () => createConnectionService({db,vault,fetchImpl,...overrides});
    let service=make(); const connection=service.save({baseUrl:BASE,apiKey:'synthetic-display-key'});
    t.after(()=>{if(db.open)db.close();cleanup(directory);});
    return {directory,get db(){return db;},get service(){return service;},connection,get calls(){return calls;},setList:value=>{list=value;},setFail:value=>{fail=value;},
        restart(){db.close();db=new Database(filename);service=make();},
        async check(){const c=service.summary(connection.connectionId);return service.check(c.connectionId,{connectionVersionId:c.connectionVersionId,expectedRouteRevision:c.routeRevision ?? undefined,force:true});}};
}
function saveDisplay(service,id,changes={}) { const current=service.models(id),{revision,...settings}=current.displaySettings;return service.updateModelDisplay(id,{connectionVersionId:current.connectionVersionId,expectedRouteRevision:current.routeRevision,expectedRevision:revision,...settings,...changes}); }
test('first choices are frozen, protocol gates are projected, refresh additions/removals/failures preserve choices, and restart persists them',async t=>{
    const f=await setup(t),id=f.connection.connectionId;
    const initial=f.service.models(id);assert.deepEqual(initial.displaySettings,{revision:0,imageModels:[FLARE,SUN],videoModels:[SIX],defaultImageModel:FLARE,defaultVideoModel:SIX,pricingGroup:null});
    let current=await f.check();assert.equal(current.models.find(m=>m.model===SUN).submissionEnabled,true);assert.equal(current.models.find(m=>m.model===PREVIEW).submissionEnabled,false);assert.equal(current.models.find(m=>m.model===NEW).submissionEnabled,false);
    assert.equal(current.displaySettings.imageModels.includes(NEW),false);
    const chosen=saveDisplay(f.service,id,{imageModels:[SUN,NEW],defaultImageModel:SUN,pricingGroup:PRICING_GROUPS[1]}).displaySettings;
    assert.equal(chosen.revision,1);assert.throws(()=>f.service.assertModelDisplay(f.connection.connectionVersionId,FLARE,'image'),{code:'MODEL_HIDDEN'});
    assert.equal(f.service.assertModelDisplay(f.connection.connectionVersionId,SUN,'image'),true);
    f.setList([SIX,PREVIEW,'gpt-image-newer']);current=await f.check();assert.deepEqual(current.displaySettings,chosen);assert.equal(current.models.find(m=>m.model===SUN).visibility,'absent');assert.equal(current.displaySettings.imageModels.includes('gpt-image-newer'),false);
    f.setFail(true);current=await f.check();assert.equal(current.refreshError,'CONNECTION_OFFLINE');assert.deepEqual(current.displaySettings,chosen);
    const calls=f.calls;f.restart();assert.equal(f.calls,calls);assert.deepEqual(f.service.models(id).displaySettings,chosen);
    assert.equal(f.service.models(id).models.find(m=>m.model===SUN).visibility,'absent');
});
test('display writes are atomic CAS, reject stale routes/versions, invalid defaults and unsupported categories without partial changes',async t=>{
    const f=await setup(t),id=f.connection.connectionId;await f.check();const before=f.service.models(id),{revision,...settings}=before.displaySettings;
    const input={connectionVersionId:before.connectionVersionId,expectedRouteRevision:before.routeRevision,expectedRevision:revision,...settings,pricingGroup:PRICING_GROUPS[0]};
    const saved=f.service.updateModelDisplay(id,input);assert.equal(saved.displaySettings.revision,1);
    assert.throws(()=>f.service.updateModelDisplay(id,{...input,pricingGroup:PRICING_GROUPS[1]}),{code:'MODEL_DISPLAY_CONFLICT'});
    for(const patch of [{defaultImageModel:NEW,imageModels:[NEW]},{defaultVideoModel:PREVIEW,videoModels:[PREVIEW]},{imageModels:[SIX],defaultImageModel:SIX},{imageModels:[FLARE,FLARE]},{imageModels:[],defaultImageModel:FLARE},{defaultImageModel:null},{pricingGroup:'【生图分组】Image2原生-中质量'}]) {
        assert.throws(()=>saveDisplay(f.service,id,patch),{code:'MODEL_DISPLAY_INVALID'});assert.deepEqual(f.service.models(id).displaySettings,saved.displaySettings);
    }
    f.service.updateModelSettings(id,{connectionVersionId:before.connectionVersionId,model:FLARE,categories:['video']});assert.equal(f.service.models(id).models.find(item=>item.model===FLARE).submissionEnabled,false);
    assert.throws(()=>saveDisplay(f.service,id,{imageModels:[],defaultImageModel:null,videoModels:[FLARE],defaultVideoModel:FLARE}),{code:'MODEL_DISPLAY_INVALID'});
    f.service.updateModelSettings(id,{connectionVersionId:before.connectionVersionId,model:FLARE,categories:['image']});
    f.setList([SIX,SUN]);await f.check();assert.throws(()=>saveDisplay(f.service,id),{code:'MODEL_DISPLAY_INVALID'});
    const old=f.service.summary(id),route=f.service.save({connectionId:id,expectedVersionId:old.connectionVersionId,route:'com',expectedRouteRevision:old.routeRevision});
    assert.throws(()=>f.service.updateModelDisplay(id,{...input,expectedRevision:1}),{code:'CONNECTION_ROUTE_CONFLICT'});
    const changed=f.service.save({connectionId:id,expectedVersionId:route.connectionVersionId,apiKey:'synthetic-second-key'});
    assert.throws(()=>f.service.updateModelDisplay(id,{...input,expectedRouteRevision:route.routeRevision,expectedRevision:1}),{code:'CONNECTION_VERSION_CONFLICT'});
    assert.equal(f.service.models(changed.connectionId).displaySettings.pricingGroup,null);
});
test('same credential defaults-only changes retain display choices; new credentials, origins and separate connections isolate them',async t=>{
    const f=await setup(t),id=f.connection.connectionId;await f.check();const chosen=saveDisplay(f.service,id,{imageModels:[SUN],defaultImageModel:SUN,pricingGroup:PRICING_GROUPS[0]}).displaySettings;
    let current=f.service.save({connectionId:id,expectedVersionId:f.connection.connectionVersionId,defaultImageModel:SUN});assert.deepEqual(f.service.models(id).displaySettings,chosen);
    const other=f.service.save({baseUrl:BASE,apiKey:'synthetic-display-key'});assert.equal(f.service.models(other.connectionId).displaySettings.revision,0);
    current=f.service.save({connectionId:id,expectedVersionId:current.connectionVersionId,apiKey:'synthetic-third-key'});assert.equal(f.service.models(id).displaySettings.revision,0);assert.equal(f.service.models(id).displaySettings.pricingGroup,null);
    current=f.service.save({connectionId:id,expectedVersionId:current.connectionVersionId,baseUrl:'https://custom.invalid/v1',apiKey:'synthetic-custom-key'});assert.deepEqual(f.service.models(id).displaySettings.imageModels,[]);
});
test('onboarding synchronizes an explicit initial default atomically, rejects missing defaults and preserves newer display policy with a conflict',async t=>{
    const f=await setup(t),id=f.connection.connectionId;await f.check();const store=createWorkbenchStore({db:f.db,rootDirectory:path.join(f.directory,'storage')});
    const fields={connectionId:id,expectedVersionId:f.connection.connectionVersionId,defaultImageModel:SUN,defaultVideoModel:SIX};
    store.putSetting('onboarding',{value:{step:'defaults',dismissed:false}});
    assert.throws(()=>f.service.completeSetup({...fields,expectedOnboardingRevision:0},store),{code:'SETTING_REVISION_CONFLICT'});assert.equal(f.service.current().connectionVersionId,fields.expectedVersionId);assert.equal(f.service.models(id).displaySettings.defaultImageModel,FLARE);
    const result=f.service.completeSetup({...fields,expectedOnboardingRevision:1},store);assert.equal(result.connection.defaultImageModel,SUN);assert.equal(result.displaySettings.defaultImageModel,SUN);assert.equal(result.onboarding.value.dismissed,true);
    assert.throws(()=>f.service.completeSetup({...fields,expectedVersionId:result.connection.connectionVersionId,defaultImageModel:FLARE},store),{code:'MODEL_DISPLAY_CONFLICT'});
    const fresh=await setup(t);await fresh.check();fresh.setList([SIX]);await fresh.check();const freshStore=createWorkbenchStore({db:fresh.db,rootDirectory:path.join(fresh.directory,'storage')});
    assert.throws(()=>fresh.service.completeSetup({connectionId:fresh.connection.connectionId,expectedVersionId:fresh.connection.connectionVersionId,defaultImageModel:FLARE,defaultVideoModel:SIX},freshStore),{code:'MODEL_DISPLAY_INVALID'});
});
test('trusted setup IPC accepts nullable missing media defaults for image-only and custom compatible connections',async t=>{
    const { registerDesktopIpc } = require('../../desktop/ipc.cjs');
    for (const custom of [false,true]) {
        const f=await setup(t),id=f.connection.connectionId;
        let current=f.connection;
        if(custom)current=f.service.save({connectionId:id,expectedVersionId:current.connectionVersionId,baseUrl:'https://custom.invalid/v1',apiKey:'synthetic-custom-setup'});
        f.setList([FLARE,SUN]);await f.check();
        const store=createWorkbenchStore({db:f.db,rootDirectory:path.join(f.directory,'storage')}),handlers=new Map();
        registerDesktopIpc({ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:()=>{}},dialog:{},shell:{},getWindow:()=>null,policy:{isTrustedSender:()=>true},runtimeInfo:()=>({}),getAssetService:()=>store,getConnectionService:()=>f.service});
        const result=await handlers.get('nova:complete-workbench-setup')({}, {connectionId:id,expectedVersionId:current.connectionVersionId,defaultImageModel:custom?null:SUN,defaultVideoModel:null,expectedOnboardingRevision:0});
        assert.equal(result.ok,true);assert.equal(result.displaySettings.defaultImageModel,custom?null:SUN);assert.equal(result.displaySettings.defaultVideoModel,null);assert.deepEqual(result.displaySettings.videoModels,[]);assert.equal(result.onboarding.value.dismissed,true);
    }
});
test('price selection is explicit, old groups migrate to null, requested compatible model uses selected ratio, changes reuse an anonymous snapshot',async t=>{
    let calls=0;const f=await setup(t,{fetchImpl:async url=>{if(new URL(url).pathname==='/v1/models')return Response.json({data:names.map(id=>({id}))});calls++;return Response.json(pricePayload());}}),id=f.connection.connectionId;
    assert.equal((await f.service.pricing(id)).reason,'PRICING_GROUP_REQUIRED');assert.equal(calls,1);await f.check();assert.equal(calls,2);
    saveDisplay(f.service,id,{pricingGroup:PRICING_GROUPS[0]});assert.deepEqual((await f.service.pricing(id,{model:SUN})).estimate,{perImage:0.4});assert.equal(calls,2);
    saveDisplay(f.service,id,{pricingGroup:PRICING_GROUPS[1]});assert.deepEqual((await f.service.pricing(id,{model:SUN})).estimate,{perImage:0.8});assert.equal(calls,2);
    const row=f.db.prepare("SELECT * FROM app_settings WHERE key LIKE '%:display'").get(),legacy={...JSON.parse(row.value_json),pricingGroup:'【生图分组】Image2原生-中质量'};f.db.prepare('UPDATE app_settings SET value_json=? WHERE key=?').run(JSON.stringify(legacy),row.key);
    assert.equal(f.service.models(id).displaySettings.pricingGroup,null);assert.equal(JSON.parse(f.db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(row.key).value_json).pricingGroup,null);assert.equal((await f.service.pricing(id)).reason,'PRICING_GROUP_REQUIRED');assert.equal(calls,2);
    assert.equal((await f.service.pricing(id,{model:NEW})).reason,'PRICING_UNSUPPORTED');assert.equal(calls,2);
    assert.equal(parseImagePricing(pricePayload()).reason,'PRICING_GROUP_REQUIRED');assert.equal(parseImagePricing(pricePayload(),{group:'【生图分组】Image2原生-中质量'}).estimate,null);
    assert.equal((await createImagePricing({fetchImpl:async()=>new Response('null')})('cn',{group:PRICING_GROUPS[0]})).reason,'PRICING_INVALID');
});
test('late price completion cannot overwrite a changed display revision and current group recalculates without another request',async t=>{
    let release,calls=0;const f=await setup(t,{fetchImpl:async url=>new URL(url).pathname==='/v1/models'?Response.json({data:names.map(id=>({id}))}):new Promise(resolve=>{calls++;release=()=>resolve(Response.json(pricePayload()));})}),id=f.connection.connectionId;
    const check=f.check();release();await check;saveDisplay(f.service,id,{pricingGroup:PRICING_GROUPS[0]});
    const pending=f.service.pricing(id,{force:true,model:SUN});saveDisplay(f.service,id,{pricingGroup:PRICING_GROUPS[1]});release();const stale=await pending;
    assert.equal(stale.stale,true);assert.equal(stale.estimate,null);assert.deepEqual((await f.service.pricing(id,{model:SUN})).estimate,{perImage:0.8});assert.equal(calls,2);
});
test('protected HTTP display API persists atomically, validates defaults, and only empty drafts receive current visible defaults',async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-display-http-'));let list=names;
    const upstream=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url==='/api/pricing'?pricePayload():{data:list.map(id=>({id}))}));});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const options={opensosenOrigin:'http://127.0.0.1:'+upstream.address().port};let runtime=await start(directory,options);
    t.after(async()=>{await runtime.stop();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));cleanup(directory);});
    const c=await runtime.saveConnection({baseUrl:BASE,apiKey:'synthetic-display-http-key'}),url='/api/nova/connections/'+c.connectionId;
    const post=(route,body,method='POST')=>runtime.request(route,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await fetch(runtime.origin+url+'/model-display')).status,403);await post(url+'/check',{connectionVersionId:c.connectionVersionId,force:true});
    let catalog=await (await runtime.request(url+'/model-display')).json(),{revision,...settings}=catalog.displaySettings;
    const input={connectionVersionId:c.connectionVersionId,expectedRouteRevision:catalog.routeRevision,expectedRevision:revision,...settings,imageModels:[SUN],defaultImageModel:SUN,pricingGroup:PRICING_GROUPS[0]};
    const races=await Promise.all([post(url+'/model-display',input,'PUT'),post(url+'/model-display',{...input,pricingGroup:PRICING_GROUPS[1]},'PUT')]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
    let response=races.find(r=>r.status===200);catalog=await response.json();assert.equal(catalog.displaySettings.defaultImageModel,SUN);
    const quote=await(await runtime.request(url+'/pricing?model='+SUN)).json();assert.deepEqual(quote.estimate,{perImage:catalog.displaySettings.pricingGroup===PRICING_GROUPS[0]?0.4:0.8});assert.equal(quote.model,SUN);
    assert.equal((await runtime.request(url+'/pricing?model=invalid%20name')).status,400);
    assert.equal((await post(url+'/model-display',{...input,expectedRevision:1,expectedRouteRevision:999},'PUT')).status,409);
    assert.equal((await post(url+'/model-display',{...input,expectedRevision:1,connectionVersionId:randomUUID()},'PUT')).status,409);
    assert.equal((await post(url+'/model-display',input,'PUT')).status,409);
    assert.equal((await post(url+'/model-display',{...input,expectedRevision:1,imageModels:[NEW],defaultImageModel:NEW},'PUT')).status,400);
    assert.equal((await (await runtime.request('/api/nova/storage/drafts/image.text')).json()).draft.model,SUN);
    const group=await(await post('/api/nova/storage/groups',{name:'默认模型分组'})).json();assert.equal((await(await runtime.request('/api/nova/storage/groups/'+group.group.groupId+'/drafts/image.text')).json()).draft.model,SUN);
    await post('/api/nova/storage/drafts/image.text',{prompt:'saved hidden draft',model:SUN,parameters:{},inputAssets:[],expectedRevision:0},'PUT');
    response=await post(url+'/model-display',{...input,expectedRevision:1,imageModels:[],defaultImageModel:null},'PUT');assert.equal(response.status,200);
    assert.equal((await (await runtime.request('/api/nova/storage/drafts/image.text')).json()).draft.model,SUN);assert.equal((await (await runtime.request('/api/nova/storage/drafts/image.reference')).json()).draft.model,'');
    const before=await response.json();await runtime.stop();runtime=await start(directory,options);assert.deepEqual((await (await runtime.request(url+'/models')).json()).displaySettings,before.displaySettings);
    list=[];await post(url+'/check',{connectionVersionId:c.connectionVersionId,force:true});assert.equal((await (await runtime.request('/api/nova/storage/drafts/video.text')).json()).draft.model,'');
    assert.equal((await runtime.request(url+'/model-display',{method:'DELETE'})).status,405);
});

test('dual classification exposes submission state per media kind without granting an image model a video protocol',async t=>{
    const f=await setup(t),id=f.connection.connectionId;await f.check();
    f.service.updateModelSettings(id,{connectionVersionId:f.connection.connectionVersionId,model:SUN,categories:['image','video']});
    const item=f.service.models(id).models.find(item=>item.model===SUN);
    assert.equal(item.submissionEnabled,true);assert.deepEqual(item.submissionEnabledByKind,{image:true,video:false});
    assert.throws(()=>saveDisplay(f.service,id,{videoModels:[SUN],defaultVideoModel:SUN}),{code:'MODEL_DISPLAY_INVALID'});
});
