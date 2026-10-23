'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { start } = require('./support/desktop-http-runtime.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs=1500) { const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await fn();if(value)return value;await wait(10);}throw new Error('Image boundary did not settle inside the local test budget'); }
async function fixture(t, {desktop=false,status=400,imageStream=false,hangBody=false,echoKey=false}={}) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-t05-image-boundary-')), calls=[], key='synthetic-t05-image-boundary-key';
    const server=http.createServer(async(req,res)=>{
        for await(const chunk of req) void chunk;
        calls.push({method:req.method,path:req.url,headersSentAt:Date.now()});
        res.writeHead(status,{'content-type':imageStream?'text/event-stream':'application/json'});
        if(hangBody){res.flushHeaders();res.write(imageStream?'data: {"type":"image.partial","index":0}\n\n':'{"data":[');return;}
        const detail=echoKey?encodeURIComponent(encodeURIComponent(key)):'Synthetic Gemini refusal '+status;
        res.end(JSON.stringify({error:{message:detail}}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const baseUrl='http://127.0.0.1:'+server.address().port;
    const runtime=await start(directory,{desktop,imageStream,trackResponseReads:true,...(hangBody?{imageRequestTimeoutMs:180}:{})});
    t.after(async()=>{server.closeAllConnections();await runtime.stop();await new Promise(resolve=>server.close(resolve));const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
    const saved=desktop?await runtime.saveConnection({baseUrl,apiKey:key}):null;
    const input=()=>({localRequestId:randomUUID(),...(desktop?{connectionVersionId:saved.connectionVersionId}:{apiKey:key,baseUrl,protocol:'google'}),mode:'text-to-image',model:desktop?'gpt-image-2':'gemini-3.1-flash-image-preview',prompt:'本地合成响应边界\n"原句"',parallelCount:1,outputSize:'auto',aspectRatio:'auto',images:[]});
    const create=async()=>{const response=await runtime.request('/api/nova/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input())});assert.equal(response.status,202);return(await response.json()).taskId;};
    const task=async id=>(await runtime.request('/api/nova/tasks/'+id)).json();
    return {runtime,calls,key,create,task};
}
for(const status of [400,401,403,429]) test('actual Web Gemini '+status+' preserves its upstream error and consumes the response body exactly once',async t=>{
    const f=await fixture(t,{status}),id=await f.create();const task=await until(async()=>{const value=await f.task(id);return value.status==='failed'?value:null;});
    assert.match(task.error,new RegExp('API 请求失败: '+status+' Synthetic Gemini refusal '+status));
    assert.doesNotMatch(task.error,/ReferenceError|Cannot access|before initialization|responseText/);
    const reads=await f.runtime.responseReads();assert.equal(reads.length,1);assert.equal(reads[0].textReads,1);assert.equal(reads[0].status,status);assert.match(reads[0].path,/^\/v1beta\/models\/.+:generateContent$/);assert.equal(f.calls.length,1);
});
for(const status of [400,401,403,429]) test('actual desktop image '+status+' reads once, retains safe rejection/auth classification and never repeats POST',async t=>{
    const f=await fixture(t,{desktop:true,status,echoKey:true}),id=await f.create();const task=await until(async()=>{const value=await f.task(id);return value.status==='failed'?value:null;});
    assert.equal(task.taskError.code,[401,403].includes(status)?'AUTH_REJECTED':'REMOTE_REJECTED');assert.equal(task.taskError.transmission,'response_received');assert.match(task.error,/连接凭据/);
    assert.equal(JSON.stringify(task).includes(f.key),false);assert.doesNotMatch(JSON.stringify(task),/ReferenceError|Cannot access|before initialization/);
    const reads=await f.runtime.responseReads();assert.equal(reads.length,1);assert.equal(reads[0].textReads,1);assert.equal(reads[0].status,status);await wait(30);assert.equal(f.calls.length,1);
});
for(const imageStream of [false,true]) test('actual desktop '+(imageStream?'SSE':'JSON')+' headers followed by a hanging body time out as submission_unknown without a second POST',async t=>{
    const f=await fixture(t,{desktop:true,status:200,hangBody:true,imageStream}),id=await f.create();
    await until(()=>f.calls.length===1);const queued=await f.create();const unknown=await until(async()=>{const value=await f.task(id);return value.status==='submission_unknown'?value:null;},1200);
    assert.equal(unknown.taskError.code,'SUBMISSION_UNKNOWN');assert.equal(unknown.taskError.transmission,'may_have_reached_upstream');assert.equal(unknown.generationReserved,true);assert.equal((await f.task(queued)).status,'local_queued');
    const reads=await f.runtime.responseReads();assert.equal(reads.length,1);assert.equal(reads[0].textReads,1);assert.ok(reads[0].readSettledAt);const elapsed=reads[0].readSettledAt-reads[0].headersReceivedAt;assert.ok(elapsed>=80 && elapsed<1000,'body deadline elapsed '+elapsed+'ms');
    await wait(50);assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');t.diagnostic(JSON.stringify({headersToBodyAbortMs:elapsed,compressedRequestDeadlineMs:180,upstreamPosts:f.calls.length,localState:unknown.status}));
});
test('actual Web Gemini headers followed by a hanging body retain the request deadline through parsing',async t=>{
    const f=await fixture(t,{status:200,hangBody:true}),id=await f.create();
    const failed=await until(async()=>{const value=await f.task(id);return value.status==='failed'?value:null;},1200);
    assert.match(failed.error,/请求超时/);assert.doesNotMatch(failed.error,/ReferenceError|Cannot access|before initialization/);
    const reads=await f.runtime.responseReads();assert.equal(reads.length,1);assert.equal(reads[0].textReads,1);assert.ok(reads[0].readSettledAt-reads[0].headersReceivedAt<1000);assert.equal(f.calls.length,1);
});
