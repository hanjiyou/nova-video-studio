'use strict';
// Actual Electron main/preload/IPC. The only provider destination is the parent loopback fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {app,safeStorage}=require('electron');
const output=process.env.NOVA_B1_EVIDENCE,phase=Number(process.env.NOVA_B1_PHASE),key='synthetic-b1-native-protected';
assert.ok(output&&process.env.NOVA_DATA_DIR&&process.env.NOVA_B1_TEST_ORIGIN&&[1,2].includes(phase));
const originalFetch=global.fetch,destination=new URL(process.env.NOVA_B1_TEST_ORIGIN);assert.equal(destination.hostname,'127.0.0.1');
global.fetch=(url,init)=>{const target=new URL(url);if(target.origin==='http://127.0.0.1:'+process.env.NOVA_BACKEND_PORT&&target.pathname==='/api/nova/config')return originalFetch(url,init);assert.equal(target.origin,'https://newapi.opensosen.com');return originalFetch(new URL(target.pathname+target.search,destination),init);};
const evidence={phase,platform:process.platform,checks:{},scope:'Actual Windows Electron main/preload/IPC; loopback synthetic OpenSosen protocol only; no real generation or complete UI acceptance'};
const check=(name,value)=>{assert.ok(value,name);evidence.checks[name]=true;};
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('B1 native readiness timeout');}
let primary;
async function run(window){
    const evaluate=expression=>window.webContents.executeJavaScript(expression,true);
    await until(()=>evaluate('document.readyState==="complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop?.saveConnection'));
    const request=(route,options={})=>evaluate('fetch('+JSON.stringify(route)+','+JSON.stringify(options)+').then(async r=>({status:r.status,body:await r.json()}))');
    const post=(route,body)=>request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const stateFile=path.join(output,'state.json');let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
    const backend=require('../backend/server');
    check('real Windows credential encryption available',process.platform==='win32'&&safeStorage.isEncryptionAvailable());
    check('durable task service available',Boolean(backend.tasks));
    if(phase===1){
        const saved=await evaluate('window.novaDesktop.saveConnection('+JSON.stringify({baseUrl:'https://newapi.opensosen.com/v1',apiKey:key})+')');
        check('narrow IPC saves real safeStorage protected synthetic credential',saved.ok&&saved.connection.credentialState==='ready');state.connection=saved.connection;
        const models=(await request('/api/nova/connections/'+state.connection.connectionId+'/models')).body;
        check('visibility and mode capability stay independent',models.capabilities.filter(item=>item.evidenceLevel==='historically_verified').length===2&&models.models.every(item=>item.visibility==='unknown'));
        const inputs=[];
        for(const name of['reference-a.png','reference-single.jpg']){
            const bytes=[...fs.readFileSync(path.join(__dirname,'../backend/test/fixtures/workbench-v1',name))];
            const imported=await evaluate('fetch("/api/nova/assets/import",{method:"POST",headers:{"content-type":'+JSON.stringify(name.endsWith('png')?'image/png':'image/jpeg')+'},body:new Uint8Array('+JSON.stringify(bytes)+')}).then(r=>r.json())');
            inputs.push({assetId:imported.asset.assetId,position:inputs.length,role:'reference'});
        }
        check('renderer imports two original managed files',inputs.length===2&&inputs.every(item=>item.assetId));
        state.payload={localRequestId:randomUUID(),connectionVersionId:state.connection.connectionVersionId,capabilityVersionId:models.capabilities.find(item=>item.mode==='video.dual_reference'&&item.model==='grok-imagine-video-1.5-6s').capabilityVersionId,
            mode:'video.dual_reference',model:'grok-imagine-video-1.5-6s',prompt:'  原生中文\n“完整台词”\r\n第二行  ',parameters:{seconds:6,size:'1280x720'},inputAssets:inputs};
        const image={...state.payload,localRequestId:randomUUID(),mode:'image.text',model:'gpt-image-2.5-flare',parameters:{},inputAssets:[],
            capabilityVersionId:models.capabilities.find(item=>item.mode==='image.text').capabilityVersionId};
        const blocked=await post('/api/nova/workbench/tasks',image);check('unverified flare never dispatches',blocked.status===400&&blocked.body.code==='CAPABILITY_UNVERIFIED');
        const created=await post('/api/nova/workbench/tasks',state.payload);state.id=created.body.taskId;check('canonical renderer API queues B1 intent',created.status===202);
        const accepted=await until(async()=>{const task=(await request('/api/nova/tasks/'+state.id)).body;return task.status==='remote_queued'?task:null;});
        check('driver ID reaches durable task column',accepted.upstreamTaskId==='task_native_b1');
        check('dispatch and ID are committed before quitting',backend.storage.events(state.id).some(item=>item.type==='dispatch_started')&&backend.storage.events(state.id).some(item=>item.type==='upstream_accepted'));
        check('same canonical intent returns original task', (await post('/api/nova/workbench/tasks',state.payload)).body.taskId===state.id);
        state.origin=new URL(window.webContents.getURL()).origin;
    }else{
        check('restart uses a new backend port',new URL(window.webContents.getURL()).origin!==state.origin);
        const task=await until(async()=>{const result=(await request('/api/nova/tasks/'+state.id)).body;return result.status==='remote_completed'?result:null;});
        check('restart only queries original persisted ID',task.upstreamTaskId==='task_native_b1'&&task.connectionVersionId===state.connection.connectionVersionId);
        check('remote completion remains pending local download verification',task.completedAt===null&&task.outputAssets.length===0);
        check('original version decrypts after restart',backend.connections.getAuth(state.connection.connectionVersionId).apiKey===key);
        const history=await request('/api/nova/storage/tasks');
        check('renderer history/task hide key and raw remote URLs',![key,'opensosen.com','cdn.invalid'].some(value=>JSON.stringify({task,history}).includes(value)));
        check('replay after restart stays deduplicated',(await post('/api/nova/workbench/tasks',state.payload)).body.taskId===state.id);
    }
    fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
}
app.on('browser-window-created',(_event,window)=>{if(primary)return;primary=window;window.webContents.once('did-finish-load',()=>run(window).then(()=>{evidence.status='passed';}).catch(error=>{evidence.status='failed';evidence.error=error.stack;}).finally(()=>{evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'phase-'+phase+'.json'),JSON.stringify(evidence,null,2)+'\n');app.quit();}));});
require('../desktop/main.cjs');
