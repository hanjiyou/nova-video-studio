'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),Database=require('better-sqlite3'),{resolveBackendPort}=require('../desktop/runtime.cjs');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'temp/b2-native-'+Date.now())),data=path.join(output,'data');
assert.ok(!fs.existsSync(output),'Fresh isolated profile required');fs.mkdirSync(data,{recursive:true});
const calls=[],key='synthetic-b2-native-protected',bytes=fs.readFileSync(path.join(root,'backend/test/fixtures/b2/valid-video.mp4'));let phase=1;
const server=http.createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    const url=new URL(req.url,'http://fixture.invalid');calls.push({phase,method:req.method,path:url.pathname,hasQuery:Boolean(url.search),authorized:req.headers.authorization==='Bearer '+key,hasAnyAuthorization:Boolean(req.headers.authorization)});
    if(url.pathname.endsWith('/content')){res.writeHead(302,{location:'https://cdn.b2.invalid/file.mp4?signature=synthetic-ephemeral'});res.end();return;}
    if(url.pathname==='/file.mp4'){assert.equal(req.headers.authorization,undefined);res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});if(phase===1)res.write(bytes.subarray(0,32));else res.end(bytes);return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.method==='POST'?{id:'b2-original',status:'queued'}:{id:'b2-original',status:'completed',video_url:'https://cdn.b2.invalid/unused?signature=synthetic'}));
});
async function run(number){
    phase=number;const env={...process.env,NODE_ENV:'production',NOVA_DATA_DIR:data,NOVA_B2_EVIDENCE:output,NOVA_B2_PHASE:String(number),NOVA_B2_TEST_ORIGIN:'http://127.0.0.1:'+server.address().port,NOVA_BACKEND_PORT:String(await resolveBackendPort(0))};
    for(const name of['ELECTRON_RUN_AS_NODE','PORTABLE_EXECUTABLE_DIR','NOVA_ELECTRON_CDP_ENABLED','NOVA_AGENT_ENABLED','NOVA_CDP_ENABLED','NOVA_CDP_LAUNCH_ENABLED'])delete env[name];
    const child=spawn(require('electron'),[path.join(root,'scripts/electron-b2-test-entry.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of['stdout','stderr'])child[stream].on('data',data=>fs.appendFileSync(path.join(output,'phase-'+number+'-'+stream+'.log'),data));
    const timer=setTimeout(()=>child.kill(),50000),code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timer);assert.equal(code,0);
    const report=JSON.parse(fs.readFileSync(path.join(output,'phase-'+number+'.json'),'utf8'));assert.equal(report.status,'passed',report.error);console.log(JSON.stringify(report));
    const db=new Database(path.join(data,'nova-tasks.sqlite'));assert.equal(db.pragma('quick_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await run(1);await run(2);assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(calls.filter(item=>item.path==='/v1/videos/b2-original').length,1);assert.equal(calls.filter(item=>item.path.endsWith('/content')).length,2);assert.equal(calls.filter(item=>item.path==='/file.mp4').length,2);assert.ok(calls.filter(item=>item.path.startsWith('/v1/')).every(item=>item.authorized));assert.ok(calls.filter(item=>item.path==='/file.mp4').every(item=>!item.hasAnyAuthorization));fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(calls,null,2)+'\n');})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
