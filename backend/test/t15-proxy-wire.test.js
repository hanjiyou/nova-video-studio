'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createT15ProxyTransport}=require('../../scripts/lib/t15-proxy-transport.cjs');
const {createNetworkPolicy}=require('../../desktop/network.cjs');
const {buildRequestInit}=require('../plugin-runtime/request-body');
const driver=require('../plugins/opensosen-video');
async function rig(t){
 const records=[],sockets=new Set();let connects=0;
 const receiver=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);records.push({path:req.url,method:req.method,contentType:req.headers['content-type'],authorization:req.headers.authorization,bytes:Buffer.concat(chunks)});res.writeHead(200,{'content-type':'application/json'});res.end('{"received":true}')});
 receiver.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))});await new Promise(r=>receiver.listen(0,'127.0.0.1',r));const target='127.0.0.1:'+receiver.address().port;
 const proxy=http.createServer((_req,res)=>{res.writeHead(405);res.end()});proxy.on('connect',(req,client,head)=>{assert.equal(req.url,target);connects++;const upstream=net.connect(receiver.address().port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)});for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy()})}});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const transport=createT15ProxyTransport('http://127.0.0.1:'+proxy.address().port),network=createNetworkPolicy({backendOrigin:'http://127.0.0.1:1',mode:'system',directFetch:()=>{throw Error('DIRECT_PATH_FORBIDDEN')},proxyFetch:transport.fetch});
 t.after(async()=>{network.abortPending();await transport.close();sockets.forEach(s=>s.destroy());await Promise.all([new Promise(r=>receiver.close(r)),new Promise(r=>proxy.close(r))])});return {records,network,url:'http://'+target+'/v1/videos',connects:()=>connects};
}
for(const count of [1,2])test('actual ProxyAgent wire preserves '+count+' ordered PNG references and all scalar fields',async t=>{
 const env=await rig(t),refs=['reference-a.png','reference-b.png'].slice(0,count).map(name=>({bytes:fs.readFileSync(path.join(__dirname,'fixtures/workbench-v1',name)),asset:{assetId:randomUUID(),kind:'image',mimeType:'image/png'}}));
 const prompt='  实际传输 中文\n第二行 "test"  ',key='synthetic-wire-only-credential';
 const context={connectionVersionId:randomUUID(),baseUrl:'https://newapi.opensosen.com/v1',apiKey:key,mode:count===1?'video.single_reference':'video.dual_reference',model:'grok-imagine-video-1.5-6s',fields:{prompt},parameters:{seconds:6,size:'1280x720'},inputAssets:refs.map(({asset},position)=>({assetId:asset.assetId,role:'reference',position,mimeType:asset.mimeType}))};
 const descriptor=driver.buildSubmit(context),init=buildRequestInit(descriptor,context,id=>refs.find(x=>x.asset.assetId===id));
 const response=await env.network.fetch(env.url,init);await response.text();assert.equal(env.connects(),1);assert.equal(env.records.length,1);const record=env.records[0];
 assert.match(record.contentType,/^multipart\/form-data; boundary=[^;\s]+$/);assert.notEqual(record.bytes.toString(),'[object FormData]');assert.equal(record.authorization,'Bearer '+key);assert.equal(record.path,'/v1/videos');assert.equal(record.method,'POST');
 const received=await new Response(record.bytes,{headers:{'content-type':record.contentType}}).formData();assert.deepEqual([...received.entries()].slice(0,4),[['model',context.model],['prompt',prompt.replace(/\r?\n/g,'\r\n')],['seconds','6'],['size','1280x720']]);
 assert.deepEqual([...received.keys()].slice(4),Array(count).fill('input_reference'));assert.equal(received.has('input_reference[]'),false);const files=received.getAll('input_reference');for(let i=0;i<count;i++){assert.equal(files[i].name,'reference-'+(i+1)+'.png');assert.equal(files[i].type,'image/png');assert.deepEqual(Buffer.from(await files[i].arrayBuffer()),refs[i].bytes)}
 t.diagnostic(JSON.stringify({referenceCount:count,proxyConnects:env.connects(),postCount:env.records.length,multipart:true,rawBytesAndOrder:true,bodyLength:record.bytes.length}));
});
test('proxy transport leaves exact JSON bytes and GET methods intact',async t=>{const env=await rig(t),body='{"model":"fixture","prompt":"中文","n":1}';let response=await env.network.fetch(env.url,{method:'POST',headers:{'content-type':'application/json'},body});await response.text();assert.equal(env.records[0].bytes.toString(),body);assert.equal(env.records[0].contentType,'application/json');response=await env.network.fetch(env.url+'/original-id',{method:'GET'});await response.text();assert.equal(env.records[1].method,'GET');assert.equal(env.records[1].bytes.length,0);assert.equal(env.records[1].path,'/v1/videos/original-id')});
