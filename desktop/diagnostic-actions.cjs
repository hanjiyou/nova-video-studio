'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {fileFailure}=require('../backend/storage/download-errors');
async function snapshot(file) { try { const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Object.assign(new Error(),{code:'SAVE_TARGET_CHANGED'});return {ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs}; } catch(error) {if(error.code==='ENOENT')return null;throw error;} }
function createDiagnosticActions({getStore,dialog,getWindow,runtimeInfo}) {
    let busy=false;
    return {async export() {
        if(busy)return {ok:false,code:'DIAGNOSTIC_EXPORT_BUSY'};
        const store=getStore();if(!store)return {ok:false,code:'ASSET_SERVICE_NOT_READY'};
        busy=true;let temporary,handle;
        try {
            const result=await dialog.showSaveDialog(getWindow(),{title:'导出脱敏诊断',defaultPath:'Nova-diagnostics-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'脱敏诊断 JSON',extensions:['json']}],properties:['createDirectory','showOverwriteConfirmation']});
            if(result.canceled||!result.filePath)return {ok:true,cancelled:true};
            const parent=await fs.realpath(path.dirname(result.filePath)),destination=path.join(parent,path.basename(result.filePath));
            // Do not let an export overwrite the database or any managed output.
            if(!store.allowDiagnosticDestination(destination))return {ok:false,code:'DIAGNOSTIC_TARGET_PROTECTED'};
            const before=await snapshot(destination),report=store.createDiagnostics(runtimeInfo());
            temporary=path.join(parent,'.nova-diagnostic-'+randomUUID()+'.part');handle=await fs.open(temporary,'wx');
            await handle.writeFile(JSON.stringify(report,null,2)+'\n','utf8');await handle.sync();await handle.close();handle=null;
            if(JSON.stringify(before)!==JSON.stringify(await snapshot(destination)))throw Object.assign(new Error(),{code:'SAVE_TARGET_CHANGED'});
            await fs.rename(temporary,destination);temporary=null;
            return {ok:true,cancelled:false,exportedTasks:report.counts.exported,omittedTasks:report.counts.omitted};
        } catch(error) {return {ok:false,code:fileFailure(error).code};}
        finally {await handle?.close().catch(()=>{});if(temporary)await fs.unlink(temporary).catch(()=>{});busy=false;}
    }};
}
module.exports={createDiagnosticActions};
