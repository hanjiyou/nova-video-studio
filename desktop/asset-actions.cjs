'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { failure, fileFailure } = require('../backend/storage/download-errors');
async function snapshot(file) {
    try { const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw failure('SAVE_TARGET_CHANGED');return {ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs}; }
    catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function createAssetActions({getStore,dialog,shell,getWindow}) {
    function source(id) {
        const store=getStore();if(!store)throw Object.assign(new Error(),{code:'ASSET_SERVICE_NOT_READY'});
        const checked=store.readAsset(id);return {...checked,file:store.resolveAssetPath(id)};
    }
    return {
        async save(id) {
            const original=source(id),extension=path.extname(original.file).slice(1);
            const result=await dialog.showSaveDialog(getWindow(),{title:'另存副本',defaultPath:'Nova-'+id.slice(0,8)+'.'+extension,
                filters:[{name:original.asset.kind==='video'?'视频':'图片',extensions:[extension]}],properties:['createDirectory','showOverwriteConfirmation']});
            if(result.canceled||!result.filePath)return {ok:true,cancelled:true};
            let temporary,handle;
            try {
                const parent=await fs.realpath(path.dirname(result.filePath)),destination=path.join(parent,path.basename(result.filePath));
                if(destination.toLowerCase()===original.file.toLowerCase())throw failure('SAVE_TARGET_CHANGED');
                const before=await snapshot(destination);
                temporary=path.join(parent,'.nova-save-'+randomUUID()+'.part');
                handle=await fs.open(temporary,'wx');
                await handle.writeFile(source(id).bytes);await handle.sync();await handle.close();handle=null;
                if(JSON.stringify(before)!==JSON.stringify(await snapshot(destination)))throw failure('SAVE_TARGET_CHANGED');
                // Atomic replacement on the selected filesystem; never truncate/delete the old target.
                // A lock, full disk, or failed rename preserves the existing destination.
                await fs.rename(temporary,destination);temporary=null;
                return {ok:true,cancelled:false,assetId:id};
            } catch(error){throw fileFailure(error);}
            finally {await handle?.close();if(temporary)await fs.unlink(temporary).catch(()=>{});}
        },
        async reveal(id) {const original=source(id);shell.showItemInFolder(original.file);return {ok:true,assetId:id};},
    };
}
module.exports={createAssetActions};
