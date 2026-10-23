'use strict';
// Real Electron main/preload/renderer/decoder; only provider traffic is loopback synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {app,dialog,shell,safeStorage}=require('electron'),Database=require('better-sqlite3');
const output=process.env.NOVA_B2_EVIDENCE,phase=Number(process.env.NOVA_B2_PHASE),key='synthetic-b2-native-protected';
assert.ok(output&&process.env.NOVA_DATA_DIR&&process.env.NOVA_B2_TEST_ORIGIN&&[1,2].includes(phase));
const destination=new URL(process.env.NOVA_B2_TEST_ORIGIN);assert.equal(destination.hostname,'127.0.0.1');
const originalFetch=global.fetch;
global.fetch=(url,init)=>{const target=new URL(url);if(target.origin==='http://127.0.0.1:'+process.env.NOVA_BACKEND_PORT)return originalFetch(url,init);assert.ok(['https://newapi.opensosen.com','https://cdn.b2.invalid'].includes(target.origin));return originalFetch(new URL(target.pathname+target.search,destination),init);};
const worker=require('../backend/storage/download-worker'),production=worker.createDownloadWorker;
worker.createDownloadWorker=options=>production({...options,checkUrl:async url=>{assert.ok(['https://newapi.opensosen.com','https://cdn.b2.invalid'].includes(url.origin));}});
const evidence={phase,platform:process.platform,checks:{},scope:'Actual Electron main/preload/renderer, native FFmpeg, HTTP Range and crash recovery. Synthetic provider. Dialog target and shell adapter are controlled test doubles; no manual GUI acceptance.'};
const check=(name,value)=>{assert.ok(value,name);evidence.checks[name]=true;};
async function until(fn){const end=Date.now()+30000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('B2 native readiness timeout');}
let primary;
async function run(window){
    const evaluate=expression=>window.webContents.executeJavaScript(expression,true);
    await until(()=>evaluate('document.readyState==="complete" && !document.getElementById("app-boot-loader") && !!window.novaDesktop?.getOutputDirectory'));
    const request=(route,options={})=>evaluate('fetch('+JSON.stringify(route)+','+JSON.stringify(options)+').then(async r=>({status:r.status,body:await r.json()}))');
    const post=(route,body)=>request(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
    const stateFile=path.join(output,'state.json'),backend=require('../backend/server');let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
    check('real Windows safeStorage available',process.platform==='win32'&&safeStorage.isEncryptionAvailable());
    if(phase===1){
        const saved=await evaluate('window.novaDesktop.saveConnection('+JSON.stringify({baseUrl:'https://newapi.opensosen.com/v1',apiKey:key})+')');check('real encrypted original connection',saved.ok);state.connection=saved.connection;
        const selected=path.join(output,'中文 输出 a');fs.mkdirSync(selected);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});
        const root=await evaluate('window.novaDesktop.chooseOutputDirectory()');check('directory choice persists opaque version',root.ok&&root.outputDirectoryVersionId&&root.outputRootRef);state.root=root;
        const models=(await request('/api/nova/connections/'+state.connection.connectionId+'/models')).body,bytes=[...fs.readFileSync(path.join(__dirname,'../backend/test/fixtures/workbench-v1/reference-a.png'))];
        const imported=await evaluate('fetch("/api/nova/assets/import",{method:"POST",headers:{"content-type":"image/png"},body:new Uint8Array('+JSON.stringify(bytes)+')}).then(r=>r.json())');
        state.payload={localRequestId:randomUUID(),connectionVersionId:state.connection.connectionVersionId,capabilityVersionId:models.capabilities.find(item=>item.mode==='video.single_reference'&&item.model==='grok-imagine-video-1.5-6s').capabilityVersionId,
            mode:'video.single_reference',model:'grok-imagine-video-1.5-6s',prompt:'B2 本地合成下载与恢复',parameters:{seconds:6,size:'1280x720'},inputAssets:[{assetId:imported.asset.assetId,position:0,role:'reference'}]};
        const created=await post('/api/nova/workbench/tasks',state.payload);check('canonical task dispatched once',created.status===202);state.id=created.body.taskId;
        await until(async()=>(await request('/api/nova/tasks/'+state.id)).body.status==='remote_queued');
        const db=new Database(path.join(process.env.NOVA_DATA_DIR,'nova-tasks.sqlite'));db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE id=?").run(state.id);db.close();await backend.tasks.poll(state.id);
        const task=await until(async()=>{const value=(await request('/api/nova/tasks/'+state.id)).body;return value.status==='downloading'?value:null;});
        await until(()=>fs.readdirSync(path.join(selected,'.nova-parts')).some(file=>fs.statSync(path.join(selected,'.nova-parts',file)).size>0));
        check('partial file is not output or completed',task.outputAssets.length===0&&task.completedAt===null);state.origin=new URL(window.webContents.getURL()).origin;
        fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');evidence.status='passed';evidence.forcedExitWithoutCleanup=true;
        fs.writeFileSync(path.join(output,'phase-1.json'),JSON.stringify(evidence,null,2)+'\n');app.exit(0);return;
    }
    check('restarted backend port differs',new URL(window.webContents.getURL()).origin!==state.origin);
    const task=await until(async()=>{const value=(await request('/api/nova/tasks/'+state.id)).body;return value.status==='completed'?value:null;});
    check('only decoded managed asset completes after restart',task.outputAssets.length===1&&task.outputAssets[0].validationState==='verified');state.asset=task.outputAssets[0];
    check('old output root is frozen',task.outputRootRef===state.root.outputRootRef&&backend.storage.resolveAssetPath(state.asset.assetId).startsWith(fs.realpathSync.native(path.join(output,'中文 输出 a'))+path.sep));
    check('original intent deduplicates after restart',(await post('/api/nova/workbench/tasks',state.payload)).body.taskId===state.id);
    const range=await evaluate('fetch('+JSON.stringify(state.asset.previewUrl)+',{headers:{Range:"bytes=12-99"}}).then(async r=>({status:r.status,range:r.headers.get("content-range"),length:(await r.arrayBuffer()).byteLength}))');
    check('actual renderer Range returns exact 206 bytes',range.status===206&&range.length===88&&range.range.startsWith('bytes 12-99/'));
    const playback=await evaluate('(async()=>{const v=document.createElement("video");v.muted=true;v.src='+JSON.stringify(state.asset.previewUrl)+';document.body.append(v);await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(Error("decode failed"))});await v.play();await new Promise(resolve=>setTimeout(resolve,150));v.pause();await new Promise((resolve,reject)=>{v.onseeked=resolve;v.onerror=reject;v.currentTime=1.2});const result={width:v.videoWidth,height:v.videoHeight,time:v.currentTime,readyState:v.readyState,duration:v.duration};v.remove();return result})()');
    check('Chromium decodes plays and seeks actual local H264/AAC',playback.width===160&&playback.height===96&&playback.time>=1.19&&playback.readyState>=2);evidence.playback=playback;
    const copy=path.join(output,'中文 副本.mp4');fs.writeFileSync(copy,'old target');dialog.showSaveDialog=async()=>({canceled:false,filePath:copy});
    const saved=await evaluate('window.novaDesktop.saveAssetCopy('+JSON.stringify(state.asset.assetId)+')');check('real trusted IPC atomically saves selected target',saved.ok&&fs.readFileSync(copy).equals(backend.storage.readAsset(state.asset.assetId).bytes));
    dialog.showSaveDialog=async()=>({canceled:true});check('save cancellation is successful',(await evaluate('window.novaDesktop.saveAssetCopy('+JSON.stringify(state.asset.assetId)+')')).cancelled===true);
    let revealed;shell.showItemInFolder=file=>{revealed=file;};check('reveal resolves real managed file',(await evaluate('window.novaDesktop.revealAsset('+JSON.stringify(state.asset.assetId)+')')).ok&&revealed===backend.storage.resolveAssetPath(state.asset.assetId));
    check('renderer cannot pass arbitrary path',(await evaluate('window.novaDesktop.saveAssetCopy("C:\\\\arbitrary.txt")')).code==='INVALID_ASSET_ID');
    const selected=path.join(output,'目录 b');fs.mkdirSync(selected);dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});await evaluate('window.novaDesktop.chooseOutputDirectory()');
    check('default change preserves old task root',backend.tasks.get(state.id).outputRootRef===state.root.outputRootRef);
    const text=JSON.stringify({task,history:(await request('/api/nova/storage/tasks')).body});check('public state excludes key CDN signature and paths',![key,'cdn.b2.invalid','signature=',output].some(value=>text.includes(value)));
    fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
}
app.on('browser-window-created',(_event,window)=>{if(primary)return;primary=window;window.webContents.once('did-finish-load',()=>run(window).then(()=>{evidence.status='passed';}).catch(error=>{evidence.status='failed';evidence.error=error.stack;}).finally(()=>{if(phase===1&&evidence.status==='passed')return;fs.writeFileSync(path.join(output,'phase-'+phase+'.json'),JSON.stringify(evidence,null,2)+'\n');app.quit();}));});
require('../desktop/main.cjs');
