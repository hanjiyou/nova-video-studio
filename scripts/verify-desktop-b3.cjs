'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),{resolveBackendPort}=require('../desktop/runtime.cjs');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'temp/b3-native-'+Date.now()));
assert.ok(!fs.existsSync(output),'Fresh isolated evidence/profile required');fs.mkdirSync(output,{recursive:true});
const calls=[];let phase=0,offlineOnce=false;
const server=http.createServer(async(req,res)=>{
  for await(const chunk of req)void chunk;
  const auth=String(req.headers.authorization||''),tag=auth==='Bearer synthetic-b3-native-good'?'good':auth==='Bearer synthetic-b3-native-slow'?'slow':auth==='Bearer synthetic-b3-native-unsupported'?'unsupported':'rejected';
  calls.push({phase,method:req.method,path:new URL(req.url,'http://fixture.invalid').pathname,credentialCase:tag});
  if(phase===2&&tag==='good'&&!offlineOnce){offlineOnce=true;req.socket.destroy();return;}
  const send=()=>{res.writeHead(tag==='rejected'?401:tag==='unsupported'?404:200,{'content-type':'application/json'});res.end(JSON.stringify(tag==='rejected'||tag==='unsupported'?{}:{data:[{id:'grok-imagine-video-1.5-6s'},{id:'fixture-no-text-model'}]}));};
  if(tag==='slow')setTimeout(send,650);else send();
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  for(const number of [1,2,3,4]){
    phase=number;const data=path.join(output,number<3?'skip-profile':'setup-profile');fs.mkdirSync(data,{recursive:true});
    const env={...process.env,NODE_ENV:'production',NOVA_DATA_DIR:data,NOVA_B3_EVIDENCE:output,NOVA_B3_PHASE:String(number),NOVA_B3_TEST_ORIGIN:'http://127.0.0.1:'+server.address().port,NOVA_BACKEND_PORT:String(await resolveBackendPort(0)),NOVA_NETWORK_MODE:'direct',NOVA_AGENT_ENABLED:'true',NOVA_CDP_ENABLED:'true',NOVA_CDP_LAUNCH_ENABLED:'true'};
    for(const name of ['ELECTRON_RUN_AS_NODE','PORTABLE_EXECUTABLE_DIR','NOVA_ELECTRON_CDP_ENABLED'])delete env[name];
    const child=spawn(require('electron'),[path.join(root,'scripts/electron-b3-test-entry.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>fs.appendFileSync(path.join(output,'phase-'+number+'-'+stream+'.log'),bytes));
    const timer=setTimeout(()=>child.kill(),65000),code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timer);
    assert.equal(code,0,'Electron phase exit');const report=JSON.parse(fs.readFileSync(path.join(output,'phase-'+number+'.json'),'utf8'));assert.equal(report.status,'passed',report.error);console.log(JSON.stringify({phase:number,status:report.status,checks:Object.keys(report.checks).length}));
  }
  assert.ok(calls.every(call=>call.method==='GET'&&call.path==='/v1/models'),'Only read-only model checks are permitted');
  assert.equal(calls.filter(call=>call.phase===4).length,0,'Resume/complete must not auto-check or generate');
  fs.writeFileSync(path.join(output,'requests.json'),JSON.stringify(calls,null,2)+'\n');
  const evidence=path.join(root,'docs/implementation/b3-evidence');fs.mkdirSync(evidence,{recursive:true});
  for(const file of fs.readdirSync(output).filter(file=>/^phase-\d\.json$/.test(file)||file.endsWith('.png')||file==='requests.json'))fs.copyFileSync(path.join(output,file),path.join(evidence,file));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{server.closeAllConnections();server.close();});
