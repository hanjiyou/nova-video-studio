'use strict';
// One candidate multipart text-video request, using the original unused video.text allowance.
// Technical approval is checked before reading credentials. Never retry an uncertain or refused POST.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),RUN=path.join(ROOT,'temp','t15-video-text-experiment-2026-10-24'),BASE='https://newapi.opensosen.com/v1';
const AUTHORIZATION='2026-10-24-original-video-text-once-candidate';
const review=JSON.parse(fs.readFileSync(path.join(ROOT,'docs/implementation/t15-text-experiment-evidence/technical-review.json'),'utf8'));
if(review.status!=='approved'||review.authorizationId!==AUTHORIZATION||review.reviewer!=='/root')throw Error('T15_TEXT_TECHNICAL_REVIEW_REQUIRED');
const prior=[['temp/t15-live-authorized-2026-10-24/dispatch-ledger.json','07ca16716bf75d6f065ba91d3c735048d3e6ad489d997fee2353a3d0f9b72280'],['temp/t15-reference-retest-authorized-2026-10-24/dispatch-ledger.json','e18bcc477fdf165cdc20de775af994de362c5aa0763177d81c6bc61084df07fa']];
for(const [file,hash] of prior)if(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex')!==hash)throw Error('T15_PREVIOUS_LEDGER_CHANGED');
const ledgerPath=path.join(RUN,'dispatch-ledger.json'),ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));
if(ledger.authorization!==AUTHORIZATION||ledger.maxTotal!==1||ledger.mode!=='video.text'||ledger.localRequestId!==review.localRequestId||ledger.promptSha256!==review.promptSha256||![0,1].includes(ledger.posts))throw Error('T15_TEXT_LEDGER_INVALID');
const prompt="六秒写实自然纪录片镜头：清晨的高山湖泊被薄雾笼罩，远处雪山倒映在平静湖面。一只白色水鸟缓缓掠过水面，留下细微涟漪。镜头平稳地缓慢前进，自然柔和的金色晨光，真实水面反射与空气透视，不添加文字、标志或字幕。";
if(crypto.createHash('sha256').update(prompt).digest('hex')!==ledger.promptSha256)throw Error('T15_TEXT_PROMPT_CHANGED');
const lock=path.join(RUN,'host.lock');let lockFd;try{lockFd=fs.openSync(lock,'wx')}catch{throw Error('T15_HOST_LOCKED_CHECK_EXISTING_PROCESS')}
function durable(file,value){const next=file+'.next',fd=fs.openSync(next,'w');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(next,file)}
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const {createT15ProxyTransport}=require('./lib/t15-proxy-transport.cjs'),{safeResponseError}=require('./lib/t15-safe-response.cjs');
const proxy=createT15ProxyTransport('http://127.0.0.1:7898'),transport=proxy.fetch;
let secret,backend,network;
const origin='http://127.0.0.1:31317',token=crypto.randomBytes(32).toString('hex'),directFetch=global.fetch;
const {configureDesktopSession}=require('../backend/desktop-session'),{configureConnectionHost}=require('../backend/connections/host');
const {controlledVideoTextValidation:permit}=require('../backend/tasks/controlled-video-text-validation');
configureConnectionHost(db=>{const refs=new Set(db.prepare('SELECT credential_ref FROM connection_versions WHERE credential_ref IS NOT NULL').all().map(x=>x.credential_ref));return {store(value){if(value!==secret)throw Error('CREDENTIAL_REQUIRED');const ref=crypto.randomUUID();refs.add(ref);return ref},read(ref){if(!secret||!refs.has(ref))throw Object.assign(Error('CREDENTIAL_REQUIRED'),{code:'CREDENTIAL_REQUIRED'});return secret},state(ref){return secret&&refs.has(ref)?'ready':'missing'},revokeConnection(){throw Error('T15_REVOKE_DISABLED')}}});
configureDesktopSession({origin,token});
Object.assign(process.env,{PORT:'31317',HOSTNAME:'127.0.0.1',NODE_ENV:'production',NOVA_TASK_DB:path.join(RUN,'nova-tasks.sqlite'),NOVA_STORAGE_DIR:path.join(RUN,'storage'),NOVA_IMAGE_DIR:path.join(RUN,'nova-images'),NOVA_PLUGIN_MEDIA_DIR:path.join(RUN,'plugin-media'),NOVA_CDP_DIR:path.join(RUN,'cdp'),NOVA_CDP_ENABLED:'false',NOVA_AGENT_ENABLED:'false'});
network=require('../desktop/network.cjs').installNetworkPolicy(globalThis,{backendOrigin:origin,mode:'system',proxyFetch:async(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=String(init?.method||'GET').toUpperCase(),headers=new Headers(init?.headers);
 if(headers.has('x-nova-session'))throw Error('T15_SESSION_LEAK_BLOCKED');
 if(method==='POST'){
  if(url.href!==BASE+'/videos'||ledger.posts!==0)throw Error('T15_TEXT_CREATE_BUDGET_EXHAUSTED');
  const expected=[['model','grok-imagine-video-1.5-6s'],['prompt',prompt],['seconds','6'],['size','1280x720']],form=init?.body;
  if(!(form instanceof FormData)||JSON.stringify([...form.entries()])!==JSON.stringify(expected)||[...form.values()].some(x=>typeof x!=='string'))throw Error('T15_TEXT_PROTOCOL_MISMATCH');
  ledger.posts=1;ledger.state='dispatch_reserved';ledger.dispatchReservedAt=new Date().toISOString();durable(ledgerPath,ledger);emit({event:'provider_create_reserved',mode:'video.text',posts:1,files:0});
 }else if(method!=='GET'||url.origin!==new URL(BASE).origin||!url.pathname.startsWith('/v1/videos/'))throw Error('T15_TEXT_EXTERNAL_REQUEST_DENIED');
 const response=await transport(input,init);if(method==='POST')ledger.httpStatus=response.status;if(!response.ok)ledger.lastProviderError=await safeResponseError(response,secret);durable(ledgerPath,ledger);return response;
}});
function safeTask(t){return {mode:t.mode,localTaskId:t.id,status:t.status,remoteState:t.remoteState,progress:t.progress,generationReserved:t.generationReserved,errorCode:t.taskError?.code||null,httpStatus:t.taskError?.httpStatus||null,providerError:ledger.lastProviderError||null,upstreamIdSha256:t.upstreamTaskId?crypto.createHash('sha256').update(t.upstreamTaskId).digest('hex'):null,outputs:t.outputAssets.map(a=>({assetId:a.assetId,sha256:a.sha256,byteLength:a.byteLength,width:a.width,height:a.height,durationSeconds:a.durationSeconds,validationState:a.validationState,mimeType:a.mimeType}))}}
async function run(){
 const raw=fs.readFileSync('F:/Work/WorkData/JiaSenZhongZhuan/JiaSen.txt','utf8'),values=[...new Set(raw.match(/sk-[A-Za-z0-9_-]{16,}/g)||[])];if(values.length!==1)throw Error('T15_CREDENTIAL_PARSE_AMBIGUOUS');secret=values[0];
 backend=require('../backend/server');await backend.ready;
 let connection=backend.connections.current();if(!connection)connection=backend.connections.save({displayName:'T15 one text candidate',provider:'opensosen',baseUrl:BASE,apiKey:secret,defaultImageModel:'gpt-image-2.5-flare',defaultVideoModel:'grok-imagine-video-1.5-6s'});
 let task=ledger.taskId?backend.tasks.get(ledger.taskId):null;
 if(!task&&ledger.posts)throw Error('T15_RESERVED_WITHOUT_LOCAL_TASK_REFUSE_RECREATE');
 if(!task){
  const capability=backend.connections.models(connection.connectionId).capabilities.find(c=>c.model==='grok-imagine-video-1.5-6s'&&c.mode==='video.text'&&c.evidenceLevel==='unverified');if(!capability)throw Error('CAPABILITY_UNVERIFIED');
  permit.configure({localRequestId:ledger.localRequestId,connectionVersionId:connection.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,promptSha256:ledger.promptSha256,dispatchPermitted:()=>ledger.posts===0});
  const body={localRequestId:ledger.localRequestId,connectionVersionId:connection.connectionVersionId,capabilityVersionId:capability.capabilityVersionId,mode:'video.text',model:'grok-imagine-video-1.5-6s',prompt,parameters:{seconds:6,size:'1280x720'},inputAssets:[]};
  const response=await directFetch(origin+'/api/nova/workbench/tasks',{method:'POST',headers:{'content-type':'application/json','x-nova-session':token,origin},body:JSON.stringify(body)}),result=await response.json();
  if(response.status!==202)throw Object.assign(Error('T15_ROUTE_REJECTED'),{code:result.code||'T15_ROUTE_REJECTED'});
  ledger.taskId=result.taskId;ledger.state='admitted';durable(ledgerPath,ledger);
 }
 emit({event:'prepared',mode:'video.text',candidateProtocol:true,maxRequests:1,fileParts:0,credentialStorage:'process_memory_only',productionRoute:'/api/nova/workbench/tasks'});
 const report={run:'t15-video-text-experiment-2026-10-24',candidateProtocol:true,startedAt:new Date().toISOString()};let last='',deadline=Date.now()+11*60*1000;
 while(Date.now()<deadline){
  task=backend.tasks.get(ledger.taskId);const summary=safeTask(task),line=JSON.stringify(summary);
  if(line!==last){emit({event:'task',...summary});last=line;ledger.state=task.status;durable(ledgerPath,ledger);report.task=summary;durable(path.join(RUN,'report.json'),report)}
  if(['completed','failed','remote_cancelled','local_cancelled','submission_unknown','polling_paused','download_failed'].includes(task.status))break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 if(task.generationReserved)emit({event:'reservation_preserved_stop',state:task.status});
 emit({event:'run_finished',mode:'video.text',posts:ledger.posts,state:task.status});
}
run().catch(error=>{emit({event:'runner_error',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'T15_TEXT_RUNNER_FAILED',type:error.name});process.exitCode=1}).finally(async()=>{permit.revoke();await backend?.shutdown({drain:false,timeoutMs:2000}).catch(()=>{});network.dispose();await proxy.close();secret=null;fs.closeSync(lockFd);fs.unlinkSync(lock)});
