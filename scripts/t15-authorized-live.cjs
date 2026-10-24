'use strict';
// Authorized T15 runner. Credentials stay in this host process; never persisted or sent to the renderer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),RUN=path.join(ROOT,'temp','t15-live-authorized-2026-10-24'),BASE='https://newapi.opensosen.com/v1';
const MODES=['image.text','video.text','video.single_reference','video.dual_reference'];
const ACTIVE=['image.text','video.single_reference','video.dual_reference'];
const {createT15ProxyTransport}=require('./lib/t15-proxy-transport.cjs');
const {safeResponseError}=require('./lib/t15-safe-response.cjs');
const proxy=createT15ProxyTransport('http://127.0.0.1:7898'),transport=proxy.fetch;
fs.mkdirSync(RUN,{recursive:true});
const lock=path.join(RUN,'host.lock');let lockFd;
try{lockFd=fs.openSync(lock,'wx')}catch{throw Error('T15_HOST_LOCKED_CHECK_EXISTING_PROCESS')}
const ledgerPath=path.join(RUN,'dispatch-ledger.json');
function durable(file,value){const tmp=file+'.next';const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
let ledger;
if(fs.existsSync(ledgerPath))ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));
else{if(fs.existsSync(path.join(RUN,'nova-tasks.sqlite')))throw Error('T15_LEDGER_MISSING_REFUSE_NEW_BUDGET');ledger={authorization:'2026-10-24 explicit four modes, at most one create per mode, no retries',maxTotal:4,modes:Object.fromEntries(MODES.map(mode=>[mode,{localRequestId:crypto.randomUUID(),posts:0,state:'not_dispatched'}]))};durable(ledgerPath,ledger)}
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
let secret,backend,network,currentMode=null;
const origin='http://127.0.0.1:31315',token=crypto.randomBytes(32).toString('hex');
const {configureDesktopSession}=require('../backend/desktop-session');
const {configureConnectionHost}=require('../backend/connections/host');
function parseCredential(){const raw=fs.readFileSync('F:/Work/WorkData/JiaSenZhongZhuan/JiaSen.txt','utf8');const values=[...new Set(raw.match(/sk-[A-Za-z0-9_-]{16,}/g)||[])];if(values.length!==1)throw Error('T15_CREDENTIAL_PARSE_AMBIGUOUS');secret=values[0]}
configureConnectionHost(db=>{const refs=new Set(db.prepare('SELECT credential_ref FROM connection_versions WHERE credential_ref IS NOT NULL').all().map(x=>x.credential_ref));return {store(value){if(value!==secret)throw Error('CREDENTIAL_REQUIRED');const ref=crypto.randomUUID();refs.add(ref);return ref},read(ref){if(!secret||!refs.has(ref))throw Object.assign(Error('CREDENTIAL_REQUIRED'),{code:'CREDENTIAL_REQUIRED'});return secret},state(ref){return secret&&refs.has(ref)?'ready':'missing'},revokeConnection(){throw Error('T15_REVOKE_DISABLED')}}});
configureDesktopSession({origin,token});
Object.assign(process.env,{PORT:'31315',HOSTNAME:'127.0.0.1',NODE_ENV:'production',NOVA_TASK_DB:path.join(RUN,'nova-tasks.sqlite'),NOVA_STORAGE_DIR:path.join(RUN,'storage'),NOVA_IMAGE_DIR:path.join(RUN,'nova-images'),NOVA_PLUGIN_MEDIA_DIR:path.join(RUN,'plugin-media'),NOVA_CDP_DIR:path.join(RUN,'cdp'),NOVA_CDP_ENABLED:'false',NOVA_AGENT_ENABLED:'false'});
const directFetch=global.fetch;
network=require('../desktop/network.cjs').installNetworkPolicy(globalThis,{backendOrigin:origin,mode:'system',proxyFetch:async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=String(init?.method||'GET').toUpperCase();
 const headers=new Headers(init?.headers);if(headers.has('x-nova-session'))throw Error('T15_SESSION_LEAK_BLOCKED');
 if(method!=='GET'&&method!=='HEAD'){
  if(method!=='POST'||!ACTIVE.includes(currentMode)||url.href!==BASE+(currentMode==='image.text'?'/images/generations':'/videos'))throw Error('T15_CREATE_NOT_AUTHORIZED');
  const entry=ledger.modes[currentMode];if(entry.posts!==0||Object.values(ledger.modes).reduce((n,x)=>n+x.posts,0)>=4)throw Error('T15_CREATE_BUDGET_EXHAUSTED');
  if(currentMode==='image.text'){const body=JSON.parse(init.body);if(Object.keys(body).sort().join(',')!=='model,n,prompt'||body.model!=='gpt-image-2.5-flare'||body.n!==1||typeof body.prompt!=='string')throw Error('T15_IMAGE_PROTOCOL_MISMATCH')}else{
  const form=init.body;if(!(form instanceof FormData)||form.get('model')!=='grok-imagine-video-1.5-6s'||form.get('seconds')!=='6'||form.get('size')!=='1280x720')throw Error('T15_PROTOCOL_MISMATCH');
  const refs=form.getAll('input_reference');const names=currentMode==='video.single_reference'?['guanggao.png']:['3_1.png','3_2.png'];if(refs.length!==names.length||form.has('input_reference[]'))throw Error('T15_REFERENCE_COUNT_MISMATCH');
  for(let i=0;i<refs.length;i++){const hash=crypto.createHash('sha256').update(Buffer.from(await refs[i].arrayBuffer())).digest('hex');if(hash!==ledger.inputs.find(x=>x.name===names[i]).sha256)throw Error('T15_REFERENCE_BYTES_OR_ORDER_MISMATCH')}
  }
  entry.posts=1;entry.state='dispatch_reserved';entry.dispatchReservedAt=new Date().toISOString();durable(ledgerPath,ledger);emit({event:'provider_create_reserved',mode:currentMode,posts:entry.posts});
 }
 const response=await transport(input,init);
 if(currentMode){const entry=ledger.modes[currentMode];if(method==='POST')entry.httpStatus=response.status;if(!response.ok)entry.lastProviderError=await safeResponseError(response,secret);durable(ledgerPath,ledger)}
 return response;
}});
function safeTask(t){return {mode:t.mode,localTaskId:t.id,status:t.status,remoteState:t.remoteState,progress:t.progress,generationReserved:t.generationReserved,errorCode:t.taskError?.code||null,httpStatus:t.taskError?.httpStatus||null,upstreamIdSha256:t.upstreamTaskId?crypto.createHash('sha256').update(t.upstreamTaskId).digest('hex'):null,outputs:t.outputAssets.map(a=>({assetId:a.assetId,sha256:a.sha256,byteLength:a.byteLength,width:a.width,height:a.height,durationSeconds:a.durationSeconds,validationState:a.validationState,mimeType:a.mimeType}))}}
async function run(){
 parseCredential();backend=require('../backend/server');await backend.ready;
 let connection=backend.connections.current();if(!connection)connection=backend.connections.save({displayName:'T15 authorized ephemeral connection',provider:'opensosen',baseUrl:BASE,apiKey:secret,defaultImageModel:'gpt-image-2.5-flare',defaultVideoModel:'grok-imagine-video-1.5-6s'});
 const names=['guanggao.png','3_1.png','3_2.png'];const assets=names.map(name=>backend.storage.importFile(path.join('C:/Users/Administrator/Desktop',name)));
 const inputs=assets.map((a,i)=>({name:names[i],assetId:a.assetId,sha256:a.sha256,byteLength:a.byteLength,mimeType:a.mimeType}));
 if(ledger.inputs&&JSON.stringify(ledger.inputs)!==JSON.stringify(inputs))throw Error('T15_INPUT_CHANGED_REFUSE');ledger.inputs=inputs;durable(ledgerPath,ledger);
 emit({event:'prepared',inputs:inputs.map(({name,sha256,byteLength,mimeType})=>({name,sha256,byteLength,mimeType})),confirmedModes:ACTIVE,gatedModes:['video.text'],controlledAttemptModes:['image.text'],credentialStorage:'process_memory_only',productionCapabilityGate:true});
 const prompts={
 'image.text':'一张清晰的写实商业摄影：白色陶瓷杯中盛满热咖啡，放在浅色木桌上，旁边有一枚青苹果，窗外柔和晨光照进来，杯口有细微蒸汽，背景简洁，无人物、无文字、无水印。',
 'video.single_reference':'基于参考图片制作六秒写实产品广告。保留 VELORA GREEN APPLE 绿色玻璃饮料瓶、白色标签、青苹果、冰块、凝结水珠和明亮窗边桌面的视觉特征。镜头缓慢推进，瓶身水珠轻轻滑落，冰块和苹果保持自然稳定，阳光柔和闪耀，清凉高级的商业摄影。',
 'video.dual_reference':'参考图片按顺序为走廊门外与公寓门内。创作连贯的六秒写实悬疑电影片段：先呈现第一张图的灰色公寓走廊、圆形猫眼暗边和手提箱黑衣男子，再切换到第二张图的门内女子，她手握手机、谨慎贴近黑色入户门倾听。保持两张图的人物外观、衣着、冷暖光线和室内外场景细节。不添加字幕。两张图为有序参考，不要求首尾帧锁定。'};
 const report={run:'t15-live-authorized-2026-10-24',startedAt:new Date().toISOString(),productionRoute:'/api/nova/workbench/tasks',credentialStorage:'process_memory_only',gatedModes:['video.text'],controlledAttemptModes:['image.text'],tasks:[]};
 for(const mode of ACTIVE){currentMode=mode;const entry=ledger.modes[mode];let task=entry.taskId?backend.tasks.get(entry.taskId):null;
  if(!task&&entry.posts)throw Error('T15_RESERVED_WITHOUT_LOCAL_TASK_REFUSE_RECREATE');
  if(!task){const capability=backend.connections.models(connection.connectionId).capabilities.find(c=>c.model===(mode==='image.text'?'gpt-image-2.5-flare':'grok-imagine-video-1.5-6s')&&c.mode===mode&&c.evidenceLevel===(mode==='image.text'?'unverified':'historically_verified'));if(!capability)throw Error('CAPABILITY_UNVERIFIED');
   if(mode==='image.text')require('../backend/tasks/controlled-image-validation').controlledImageValidation.configure({localRequestId:entry.localRequestId,connectionVersionId:connection.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,promptSha256:crypto.createHash('sha256').update(prompts[mode]).digest('hex'),dispatchPermitted:()=>currentMode==='image.text'&&entry.posts===0});
   const indices=mode==='image.text'?[]:mode==='video.single_reference'?[0]:[1,2];const body={localRequestId:entry.localRequestId,connectionVersionId:connection.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,mode,model:mode==='image.text'?'gpt-image-2.5-flare':'grok-imagine-video-1.5-6s',prompt:prompts[mode],parameters:mode==='image.text'?{}:{seconds:6,size:'1280x720'},inputAssets:indices.map((i,position)=>({assetId:assets[i].assetId,position,role:'reference'}))};
   const response=await directFetch(origin+'/api/nova/workbench/tasks',{method:'POST',headers:{'content-type':'application/json','x-nova-session':token,origin},body:JSON.stringify(body)});const result=await response.json();if(response.status!==202)throw Object.assign(Error('T15_ROUTE_REJECTED'),{code:result.code||'T15_ROUTE_REJECTED'});entry.taskId=result.taskId;entry.state='admitted';durable(ledgerPath,ledger);task=backend.tasks.get(entry.taskId);
  }
  let last='',deadline=Date.now()+11*60*1000;
  while(Date.now()<deadline){task=backend.tasks.get(entry.taskId);const summary=safeTask(task),line=JSON.stringify(summary);if(line!==last){emit({event:'task',...summary});last=line;entry.state=task.status;report.tasks=report.tasks.filter(x=>x.mode!==mode).concat(summary);durable(ledgerPath,ledger);durable(path.join(RUN,'report.json'),report)}
   if(['completed','failed','remote_cancelled','local_cancelled','submission_unknown','polling_paused','download_failed'].includes(task.status))break;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(task.generationReserved){emit({event:'reservation_preserved_stop',mode,state:task.status});break}
  if(!['completed','failed','remote_cancelled','local_cancelled','download_failed'].includes(task.status)){emit({event:'bounded_wait_end',mode,state:task.status});break}
 }
 currentMode=null;emit({event:'run_finished',ledger:Object.fromEntries(MODES.map(m=>[m,{posts:ledger.modes[m].posts,state:ledger.modes[m].state}]))});
}
run().catch(e=>{emit({event:'runner_error',code:/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'T15_RUNNER_FAILED',type:e.name});process.exitCode=1}).finally(async()=>{await backend?.shutdown({drain:false,timeoutMs:2000}).catch(()=>{});network.dispose();await proxy.close();secret=null;fs.closeSync(lockFd);fs.unlinkSync(lock)});
