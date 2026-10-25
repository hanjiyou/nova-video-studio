'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const Database=require('better-sqlite3'),{start}=require('./support/desktop-http-runtime.cjs');
test('actual HTTP JSON body, mid-stream reset, auth failure and expiry stay download_failed; retry/refresh never POSTs again',async t=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-b2-http-')),bytes=fs.readFileSync(path.join(__dirname,'fixtures/b2/valid-video.mp4')),key='synthetic-b2-http-key',calls=[];let mode='json',runtime;
    const server=http.createServer(async(req,res)=>{
        for await(const chunk of req)void chunk;calls.push({method:req.method,path:req.url,authorized:req.headers.authorization==='Bearer '+key});
        if(req.url.endsWith('/content')){
            if(mode==='disconnect'){res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.write(bytes.subarray(0,30));setTimeout(()=>res.destroy(),10);return;}
            if(mode==='auth'){res.writeHead(403);res.end('sensitive upstream body never propagated');return;}
            if(mode==='expired'){res.writeHead(410);res.end();return;}
            const body=mode==='json'?Buffer.from('{"error":"not an mp4"}'):bytes;res.writeHead(200,{'content-type':'video/mp4','content-length':body.length});res.end(body);return;
        }
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.method==='POST'?{id:'b2-http-original',status:'queued'}:{id:'b2-http-original',status:'completed',video_url:'https://cdn.invalid/private?signature=ephemeral'}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const opensosenOrigin='http://127.0.0.1:'+server.address().port;
    runtime=await start(directory,{opensosenOrigin});t.after(async()=>{await runtime.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:25});});
    const read=async id=>(await runtime.request('/api/nova/tasks/'+id)).json(),until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,15));}throw new Error('B2 HTTP timeout');};
    const connection=await runtime.saveConnection({baseUrl:'https://newapi.opensosen.com/v1',apiKey:key}),models=await(await runtime.request('/api/nova/connections/'+connection.connectionId+'/models')).json();
    const asset=(await(await runtime.request('/api/nova/assets/import',{method:'POST',headers:{'content-type':'image/png'},body:fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1/reference-a.png'))})).json()).asset;
    const payload={localRequestId:randomUUID(),connectionVersionId:connection.connectionVersionId,capabilityVersionId:models.capabilities.find(item=>item.model==='grok-imagine-video-1.5-6s'&&item.mode==='video.single_reference').capabilityVersionId,mode:'video.single_reference',model:'grok-imagine-video-1.5-6s',prompt:'合成媒体故障回归',parameters:{seconds:6,size:'1280x720'},inputAssets:[{assetId:asset.assetId,position:0,role:'reference'}]};
    const created=await runtime.request('/api/nova/workbench/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(created.status,202);const id=(await created.json()).taskId;await until(async()=>(await read(id)).status==='remote_queued');
    await runtime.crash();const db=new Database(path.join(directory,'tasks.sqlite'));db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);db.close();runtime=await start(directory,{opensosenOrigin});assert.equal((await read(id)).requiresContinue,true);assert.equal(calls.filter(item=>item.method==='GET').length,0);assert.equal((await runtime.request('/api/nova/tasks/'+id+'/resume-polling',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
    await until(async()=>(await read(id)).status==='download_failed');assert.equal((await read(id)).taskError.code,'MEDIA_INVALID');
    for(const [next,code]of[['disconnect','DOWNLOAD_INCOMPLETE'],['auth','AUTH_REJECTED'],['expired','DOWNLOAD_EXPIRED']]){
        mode=next;assert.equal((await runtime.request('/api/nova/tasks/'+id+'/retry-download',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);await until(async()=>(await read(id)).status==='download_failed');assert.equal((await read(id)).taskError.code,code);assert.equal((await read(id)).outputAssets.length,0);
    }
    mode='valid';await runtime.request('/api/nova/tasks/'+id+'/retry-download',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});await until(async()=>(await read(id)).status==='completed');const task=await read(id);assert.deepEqual(Buffer.from(await(await runtime.request(task.outputAssets[0].previewUrl)).arrayBuffer()),bytes);
    assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(calls.filter(item=>item.path==='/v1/videos/b2-http-original').length,2);assert.ok(calls.every(item=>item.authorized));
    const publicState=JSON.stringify({task,history:await(await runtime.request('/api/nova/storage/tasks')).json()});for(const value of[key,'signature=','cdn.invalid','sensitive upstream'])assert.equal(publicState.includes(value),false);assert.equal(runtime.output().includes(key),false);
    t.diagnostic(JSON.stringify({postCount:1,originalIdReadCount:2,contentAttempts:calls.filter(item=>item.path.endsWith('/content')).length,failures:['MEDIA_INVALID','DOWNLOAD_INCOMPLETE','AUTH_REJECTED','DOWNLOAD_EXPIRED'],finalState:'completed'}));
});
