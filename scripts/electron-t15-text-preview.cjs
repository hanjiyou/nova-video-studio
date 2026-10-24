'use strict';
// Actual sandboxed Electron UI verification of already-created local results. External requests are denied.
const {app,BrowserWindow,session,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),RUN=path.join(ROOT,'temp','t15-video-text-no-size-2026-10-24'),OUT=path.join(RUN,'preview');
fs.mkdirSync(OUT,{recursive:true});app.setPath('userData',path.join(RUN,'electron-preview-profile'));
const origin='http://127.0.0.1:31319',token=randomBytes(32).toString('hex');
Object.assign(process.env,{PORT:'31319',HOSTNAME:'127.0.0.1',NODE_ENV:'production',NOVA_TASK_DB:path.join(RUN,'nova-tasks.sqlite'),NOVA_STORAGE_DIR:path.join(RUN,'storage'),NOVA_IMAGE_DIR:path.join(RUN,'nova-images'),NOVA_PLUGIN_MEDIA_DIR:path.join(RUN,'plugin-media'),NOVA_CDP_ENABLED:'false',NOVA_AGENT_ENABLED:'false'});
require('../backend/desktop-session').configureDesktopSession({origin,token});
const direct=global.fetch;global.fetch=(input,init)=>{if(new URL(typeof input==='string'||input instanceof URL?input:input.url).origin!==origin)throw Error('T15_PREVIEW_EXTERNAL_NETWORK_DENIED');return direct(input,init)};
let win,backend,detach,ipc;
const report={scope:'actual sandboxed Electron production workbench, one real generated text video, no credential loaded, all external requests denied',checks:{},electron:process.versions.electron};
const mark=stage=>{report.stage=stage;fs.writeFileSync(path.join(OUT,'preview-progress.json'),JSON.stringify(report,null,2))};
const check=(key,value)=>{if(!value)throw Error('T15_PREVIEW_CHECK_FAILED_'+key);report.checks[key]=true};
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50))}throw Error('T15_PREVIEW_TIMEOUT')}
async function run(){
 mark('loading_backend');backend=require('../backend/server');await backend.ready;mark('backend_ready');
 if(backend.tasks.stats().processingCount)throw Error('T15_PREVIEW_REFUSE_ACTIVE_GENERATION');
 mark('creating_window');win=new BrowserWindow({show:false,width:1440,height:1000,title:'T15 text video playback verification',webPreferences:{preload:path.join(ROOT,'desktop','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true}});
 const {createSessionPolicy,constrainNavigation}=require('../desktop/session-policy.cjs');
 const policy=createSessionPolicy({origin,token,getWebContents:()=>win.webContents});detach=policy.attach(session.defaultSession);constrainNavigation(win.webContents,origin);
 ipc=require('../desktop/ipc.cjs').registerDesktopIpc({ipcMain,dialog,shell,getWindow:()=>win,policy,getAssetService:()=>backend.storage,getConnectionService:()=>backend.connections,runtimeInfo:()=>({version:require('../package.json').version,storageMode:'isolated_t15',features:{agent:false,browserAutomation:false,serviceWorker:false}})});
 mark('window_created');win.webContents.setBackgroundThrottling(false);await win.loadURL(origin);mark('document_loaded');
 const evaluate=expression=>win.webContents.executeJavaScript(expression,true);
 const click=label=>evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+'||e.getAttribute("aria-label")==='+JSON.stringify(label)+');if(!b||b.disabled)throw Error("CONTROL_UNAVAILABLE");b.click()})()');
 await until(()=>evaluate('!!document.querySelector(".wb-shell")'));mark('workbench_ready');await click('视频生成');
 const videos=backend.storage.listTasks({kind:'video',limit:20}).items;
 check('oneVerifiedLocalTextVideo',videos.length===1&&videos.every(t=>t.mode==='video.text'&&t.status==='completed'&&t.outputAssets[0]?.validationState==='verified'));
 report.videos=[];
 for(const task of videos){
  await until(()=>evaluate('[...document.querySelectorAll(".wb-card-open")].some(e=>e.getAttribute("aria-label")==='+JSON.stringify('预览任务：'+task.prompt)+')'));
  await click('预览任务：'+task.prompt);
  await until(()=>evaluate('(()=>{const v=document.querySelector(".wb-media-preview video");return !!v&&v.readyState>=2&&v.videoWidth>0&&new URL(v.currentSrc).pathname==='+JSON.stringify(task.outputAssets[0].previewUrl)+'})()'));
  await evaluate('(async()=>{const v=document.querySelector(".wb-media-preview video");v.muted=true;v.currentTime=0;await v.play()})()');
  await until(()=>evaluate('document.querySelector(".wb-media-preview video").currentTime>=0.75'));
  const playback=await evaluate('(()=>{const v=document.querySelector(".wb-media-preview video"),q=v.getVideoPlaybackQuality();v.pause();return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,currentTime:v.currentTime,totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,error:v.error?.code||null}})()');
  check(task.mode+'PlayedActualFrames',playback.totalVideoFrames>0&&playback.currentTime>=0.75&&!playback.error);
  report.videos.push({mode:task.mode,assetId:task.outputAssets[0].assetId,...playback});
 }
 await click('作品库');await until(()=>evaluate('document.querySelectorAll(".wb-library-grid article").length===1'));
 check('textRecordVisibleInLibrary',true);
 check('textCapabilityStillUnverified',backend.connections.models(backend.connections.current().connectionId).capabilities.filter(c=>c.mode==='video.text').every(c=>c.evidenceLevel==='unverified'));
 report.status='passed';mark('complete');
}
app.whenReady().then(run).catch(error=>{report.status='failed';report.error=error.message}).finally(async()=>{fs.writeFileSync(path.join(OUT,'preview-report.json'),JSON.stringify(report,null,2)+'\n');ipc?.dispose();detach?.();win?.destroy();await backend?.shutdown({drain:false,timeoutMs:2000});app.exit(report.status==='passed'?0:1)});
setTimeout(()=>app.exit(3),90000).unref();
