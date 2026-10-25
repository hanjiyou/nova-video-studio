'use strict';
const {createDownloadProgress}=require('./download-progress');
const {classifyError}=require('../tasks/diagnostic-error');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { containsCredential } = require('../connections/redaction');
const { MAX_ASSET_BYTES } = require('./store');
const { failure, fileFailure } = require('./download-errors');
const { validateMedia } = require('./media-validator');
function privateAddress(value) {
    const host=value.toLowerCase().replace(/^\[|\]$/g,'');
    if(host.includes(':'))return host==='::'||host==='::1'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe8')||host.startsWith('fe9')||host.startsWith('fea')||host.startsWith('feb')||host.startsWith('::ffff:');
    const parts=host.split('.').map(Number);
    return parts.length!==4||parts.some(value=>!Number.isInteger(value)||value<0||value>255)||parts[0]===0||parts[0]===10||parts[0]===127||parts[0]>=224||parts[0]===169&&parts[1]===254||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===192&&parts[1]===168||parts[0]===100&&parts[1]>=64&&parts[1]<=127;
}
async function assertPublicUrl(url) {
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw failure('DOWNLOAD_FORBIDDEN');
    if(url.hostname==='localhost'||url.hostname.endsWith('.localhost'))throw failure('DOWNLOAD_FORBIDDEN');
    const addresses=net.isIP(url.hostname.replace(/^\[|\]$/g,''))?[{address:url.hostname}]:await dns.lookup(url.hostname,{all:true});
    if(!addresses.length||addresses.some(item=>privateAddress(item.address)))throw failure('DOWNLOAD_FORBIDDEN');
}
function createDownloadWorker({ store, connections, fetchImpl=(...args)=>fetch(...args), validate=validateMedia, checkUrl=assertPublicUrl, timeoutMs=180000 }) {
    async function download(source, task, file, signal, checkpoint, diagnostic, progress) {
        const initial=new URL(source.url);
        // The original immutable connection is the only possible authorization source.
        const original=connections.getAuth(task.connection_version_id), service=new URL(original.baseUrl);
        if(source.authScope==='connection'&&(initial.origin!==service.origin||!initial.pathname.startsWith(service.pathname.replace(/\/$/,'')+'/')))throw failure('DOWNLOAD_FORBIDDEN');
        let url=initial, leftService=false;
        for(let hop=0;hop<=5;hop++) {
            checkpoint(); if(signal.aborted)throw failure('DOWNLOAD_FAILED');
            try{await checkUrl(url);}catch(error){diagnostic('request_failed',{operation:'download',errorCategory:classifyError(error)});throw error.code==='DOWNLOAD_FORBIDDEN'?error:failure('DOWNLOAD_CONNECTION_FAILED');}
            checkpoint(); if(signal.aborted)throw failure('DOWNLOAD_FAILED');
            if(containsCredential(url.href,original.apiKey))throw failure('DOWNLOAD_FORBIDDEN');
            const sameService=url.origin===service.origin&&url.pathname.startsWith(service.pathname.replace(/\/$/,'')+'/');
            // Once redirected away, a redirect back cannot regain the connection credential.
            if(!sameService)leftService=true;
            const headers={Accept:source.mediaKind==='video'?'video/*':'image/*','Accept-Encoding':'identity'};
            if(source.authScope==='connection'&&sameService&&!leftService)headers.Authorization='Bearer '+connections.getAuth(task.connection_version_id).apiKey;
            let response; const started=performance.now();
            diagnostic('download_started',{operation:'download',redirectHop:hop});
            try{response=await fetchImpl(url.href,{method:'GET',headers,redirect:'manual',signal});}catch(error){diagnostic('request_failed',{operation:'download',errorCategory:classifyError(error),durationMs:Math.round(performance.now()-started)});throw failure('DOWNLOAD_CONNECTION_FAILED');}
            diagnostic('download_headers',{operation:'download',httpStatus:response.status,durationMs:Math.round(performance.now()-started)});
            if([301,302,303,307,308].includes(response.status)) {
                const location=response.headers.get('location');await response.body?.cancel();
                if(hop===5||!location)throw failure('DOWNLOAD_FORBIDDEN');
                let next;try{next=new URL(location,url);}catch{throw failure('DOWNLOAD_FORBIDDEN');}
                if(url.protocol==='https:'&&next.protocol!=='https:')throw failure('DOWNLOAD_FORBIDDEN');
                diagnostic('download_redirect',{operation:'download',redirectHop:hop+1,httpStatus:response.status});
                url=next;continue;
            }
            if(!response.ok) {
                await response.body?.cancel();
                if([401,403].includes(response.status)&&headers.Authorization)throw Object.assign(failure('DOWNLOAD_FAILED'),{code:'AUTH_REJECTED',phase:'credential'});
                throw Object.assign(failure([401,403].includes(response.status)?'DOWNLOAD_ACCESS_DENIED':[404,410].includes(response.status)?'DOWNLOAD_EXPIRED':'DOWNLOAD_FAILED'),{httpStatus:response.status});
            }
            if(response.status!==200||!response.body)throw failure('DOWNLOAD_INCOMPLETE');
            const rawLength=response.headers.get('content-length'), encoded=response.headers.get('content-encoding');
            if(rawLength!==null&&!/^[0-9]+$/.test(rawLength)){await response.body.cancel();throw failure('DOWNLOAD_INCOMPLETE');}
            const declared=rawLength===null?null:Number(rawLength), expected=encoded&&encoded.toLowerCase()!=='identity'?null:declared;
            if(expected!==null&&(!Number.isSafeInteger(expected)||expected<1||expected>MAX_ASSET_BYTES)){await response.body.cancel();throw failure('DOWNLOAD_TOO_LARGE');}
            progress.total(expected);
            let fd,size=0,lastProgress=performance.now();
            try {
                fd=fs.openSync(file,'wx');
                for await(const chunk of response.body){checkpoint();if(signal.aborted)throw failure('DOWNLOAD_FAILED');size+=chunk.length;if(size>MAX_ASSET_BYTES)throw failure('DOWNLOAD_TOO_LARGE');progress.receive(chunk.length);fs.writeFileSync(fd,chunk);if(performance.now()-lastProgress>=5000){diagnostic('download_progress',{operation:'download',byteLength:size,durationMs:Math.round(performance.now()-started)});lastProgress=performance.now();}}
                if(!size||expected!==null&&size!==expected)throw failure('DOWNLOAD_INCOMPLETE');
                fs.fsyncSync(fd);
            } catch(error){diagnostic('request_failed',{operation:'download',errorCategory:classifyError(error),byteLength:size,durationMs:Math.round(performance.now()-started)});await response.body.cancel().catch(()=>{});if(error.code==='UND_ERR_SOCKET'||error.name==='TypeError')throw failure('DOWNLOAD_INCOMPLETE');throw error;}
            finally{if(fd!==undefined)fs.closeSync(fd);}
            diagnostic('download_received',{byteLength:size}); return;
        }
    }
    return async function worker(task,sources,{signal,checkpoint=()=>{},phase=()=>{},diagnostic=()=>{},remainingMs=()=>timeoutMs,onProgress=()=>{},progressTracker,progressOptions,readCheckpoint=()=>null,saveCheckpoint=()=>{},legacyDownloadLimit=false}={}) {
        let timedOut=false;const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(()=>{timedOut=true;abort();},legacyDownloadLimit?Math.min(120000,remainingMs()):remainingMs());
        const progress=progressTracker || createDownloadProgress({...progressOptions,onProgress:progressOptions?.onProgress || onProgress,checkpoint,fileCount:sources.length});
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        const assetIds=[];let observedPhase='downloading';
        try {
            progress.configure(sources.length);
            for(const [index,source] of sources.entries()) {
                progress.begin(index,source.kind);
                checkpoint(); const reused=readCheckpoint(source);if(reused){assetIds.push(reused.assetId);progress.reuse(reused.byteLength);continue;} observedPhase=source.kind==='asset'?'validating':'downloading'; phase(observedPhase);
                const directory=store.downloadDirectory(task.output_root_ref),file=path.join(directory,randomUUID()+'.part');
                try {
                    let expectedKind=source.mediaKind;
                    if(source.kind==='asset') {
                        const original=store.readAsset(source.assetId);expectedKind=original.asset.kind;
                        diagnostic('download_received',{byteLength:original.bytes.length,sourceKind:'asset'});progress.total(original.bytes.length);progress.receive(original.bytes.length,false);
                        const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,original.bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
                    } else if(source.kind==='url')await download(source,task,file,controller.signal,checkpoint,diagnostic,progress);
                    else throw failure('RESULT_NOT_RECOVERABLE');
                    if(controller.signal.aborted)throw failure(timedOut?'DOWNLOAD_TIMEOUT':'DOWNLOAD_FAILED');
                    checkpoint(); observedPhase='validating'; phase('validating');progress.phase('validating');
                    const metadata=await validate(file,{expectedKind,signal:controller.signal,timeoutMs:Math.min(90000,remainingMs())});
                    checkpoint();
                    if(controller.signal.aborted)throw failure(timedOut?'DOWNLOAD_TIMEOUT':'DOWNLOAD_FAILED');
                    diagnostic('media_validated');
                    observedPhase='saving'; phase('saving');progress.phase('saving'); checkpoint();
                    const assetId=store.publishVerifiedFile(file,metadata,task.output_root_ref).assetId; checkpoint();saveCheckpoint(source,index,assetId);assetIds.push(assetId); checkpoint(); diagnostic('file_saved');progress.saved();
                } finally {try{fs.unlinkSync(file);}catch { /* A locked orphan part is never reused or bound as output. */ }}
            }
            return {assetIds};
        } catch(error){if(error.code!=='TASK_EXECUTION_ENDED')diagnostic('operation_failed',{operation:'download',phase:observedPhase,reason:error.code,errorCategory:classifyError(error),httpStatus:error.httpStatus});if(error.code==='TASK_EXECUTION_ENDED')throw error;if(controller.signal.aborted)throw failure(timedOut?'DOWNLOAD_TIMEOUT':'DOWNLOAD_FAILED');throw fileFailure(error.cause?.code?error.cause:error);}
        finally{if(!progressTracker)progress.close();clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    };
}
module.exports = { createDownloadWorker, assertPublicUrl, privateAddress };
