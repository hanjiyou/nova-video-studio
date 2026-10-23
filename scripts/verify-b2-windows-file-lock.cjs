'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3'),{migrateDatabase}=require('../backend/storage/migrations'),{createWorkbenchStore}=require('../backend/storage/store'),{createAssetActions}=require('../desktop/asset-actions.cjs');
const output=path.resolve(process.argv[2]);assert.equal(process.platform,'win32');assert.ok(process.argv[2]&&!fs.existsSync(output));fs.mkdirSync(output,{recursive:true});
let child;const evidence={scope:'Actual Windows FileShare.None target lock; OS dialog target is a controlled test double. No GUI automation.',checks:{}};
(async()=>{
    const dbPath=path.join(output,'tasks.sqlite'),db=new Database(dbPath);try{await migrateDatabase({db,dbPath});const store=createWorkbenchStore({db,rootDirectory:path.join(output,'storage')}),bytes=fs.readFileSync(path.join(__dirname,'../backend/test/fixtures/workbench-v1/reference-a.png')),asset=store.importBuffer(bytes,{mimeType:'image/png'}),target=path.join(output,'中文 被占用.png');fs.writeFileSync(target,'original');
        const actions=createAssetActions({getStore:()=>store,dialog:{showSaveDialog:async()=>({canceled:false,filePath:target})},shell:{},getWindow:()=>null});
        child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$lockedFile=[IO.File]::Open($env:NOVA_B2_LOCK_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $lockedFile.Dispose()"],{env:{...process.env,NOVA_B2_LOCK_TARGET:target},windowsHide:true,stdio:['pipe','pipe','pipe']});
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Lock timeout')),5000);child.once('error',reject);child.stdout.once('data',bytes=>{clearTimeout(timer);assert.ok(bytes.toString().includes('locked'));resolve();});});
        await assert.rejects(actions.save(asset.assetId),{code:'FILE_BUSY'});evidence.checks.lockedTargetRejected=true;
        const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end('\n');assert.equal(await exited,0);child=null;
        assert.equal(fs.readFileSync(target,'utf8'),'original');evidence.checks.oldTargetPreserved=true;assert.equal((await actions.save(asset.assetId)).ok,true);assert.deepEqual(fs.readFileSync(target),bytes);evidence.checks.retryAfterUnlockSucceeds=true;
        evidence.checks.noPartialExportLeft=!fs.readdirSync(output).some(file=>file.startsWith('.nova-save-'));evidence.status='passed';evidence.reference=randomUUID();
    }finally{db.close();}
})().catch(error=>{evidence.status='failed';evidence.error=error.stack;process.exitCode=1;}).finally(()=>{child?.kill();fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));});
