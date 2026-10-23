'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),Database=require('better-sqlite3'),{resolveBackendPort}=require('../desktop/runtime.cjs');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'temp/b1-native-'+Date.now())),data=path.join(output,'data');
assert.ok(!fs.existsSync(output),'Fresh isolated profile required');fs.mkdirSync(data,{recursive:true});
const calls=[],key='synthetic-b1-native-protected';
const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const call={method:req.method,path:req.url,authorized:req.headers.authorization==='Bearer '+key};
    calls.push(call);
    if(req.method==='POST'){
        const db=new Database(path.join(data,'nova-tasks.sqlite'),{readonly:true});const task=db.prepare("SELECT dispatch_started_at,input_snapshot_json FROM tasks WHERE status='submitting'").get();db.close();
        assert.ok(task.dispatch_started_at);const snapshot=JSON.parse(task.input_snapshot_json);
        const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();
        const entries=[...form.entries()];assert.deepEqual(entries.slice(0,4),[['model',snapshot.model],['prompt',snapshot.prompt.replace(/\r?\n/g,'\r\n')],['seconds','6'],['size','1280x720']]);
        const files=entries.slice(4);assert.equal(files.length,2);
        for(let index=0;index<2;index++){assert.equal(files[index][0],'input_reference');assert.deepEqual(Buffer.from(await files[index][1].arrayBuffer()),fs.readFileSync(path.join(root,'backend/test/fixtures/workbench-v1',index?'reference-single.jpg':'reference-a.png')));}
        call.originalOrderedBytes=true;call.dispatchCommitted=true;
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.method==='POST'?{id:'task_native_b1',task_id:'task_native_b1',status:'queued'}:{id:'task_native_b1',status:'completed',progress:100,video_url:'https://cdn.invalid/video.mp4?signature=synthetic'}));
});
async function phase(number){
    const env={...process.env,NODE_ENV:'production',NOVA_DATA_DIR:data,NOVA_B1_EVIDENCE:output,NOVA_B1_PHASE:String(number),NOVA_B1_TEST_ORIGIN:'http://127.0.0.1:'+server.address().port,NOVA_BACKEND_PORT:String(await resolveBackendPort(0))};
    for(const name of['ELECTRON_RUN_AS_NODE','PORTABLE_EXECUTABLE_DIR','NOVA_ELECTRON_CDP_ENABLED','NOVA_AGENT_ENABLED','NOVA_CDP_ENABLED','NOVA_CDP_LAUNCH_ENABLED'])delete env[name];
    const child=spawn(require('electron'),[path.join(root,'scripts/electron-b1-test-entry.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of['stdout','stderr'])child[stream].on('data',bytes=>fs.appendFileSync(path.join(output,'phase-'+number+'-'+stream+'.log'),bytes));
    const timer=setTimeout(()=>child.kill(),30000);const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timer);assert.equal(code,0);
    const report=JSON.parse(fs.readFileSync(path.join(output,'phase-'+number+'.json'),'utf8'));assert.equal(report.status,'passed',report.error);console.log(JSON.stringify(report));
    const db=new Database(path.join(data,'nova-tasks.sqlite'));assert.equal(db.pragma('quick_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
    if(number===1)db.prepare("UPDATE tasks SET next_poll_at='2000-01-01T00:00:00Z' WHERE status='remote_queued'").run();db.close();
    for(const stream of['stdout','stderr']){const file=path.join(output,'phase-'+number+'-'+stream+'.log');if(fs.existsSync(file))assert.equal(fs.readFileSync(file,'utf8').includes(key),false);}
}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await phase(1);assert.equal(calls.length,1);await phase(2);assert.equal(calls.length,2);assert.equal(calls[0].method,'POST');assert.equal(calls[1].method,'GET');assert.equal(calls[1].path,'/v1/videos/task_native_b1');assert.ok(calls.every(call=>call.authorized));fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(calls,null,2)+'\n');})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
