'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createDownloadProgress}=require('../storage/download-progress');
const {createDownloadWorker}=require('../storage/download-worker');
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-d03-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const events=[],published=[];
 const worker=createDownloadWorker({store:{downloadDirectory:()=>dir,publishVerifiedFile(file){published.push(fs.readFileSync(file));return {assetId:'synthetic'};}},connections:{getAuth:()=>({apiKey:'synthetic-only',baseUrl:'https://fixture.invalid/v1'})},checkUrl:async()=>{},validate:async file=>{assert.ok(fs.readFileSync(file).length);return {};},...options});
 return {worker,events,published,task:{connection_version_id:'synthetic',output_root_ref:'synthetic'},source:{kind:'url',url:'https://fixture.invalid/result',mediaKind:'image'},onProgress:value=>events.push(value)};
}
test('D03 real byte sliding window, throttling, stall zero, file semantics and no stale timer',()=>{
 let time=0,tick,cleared=false;const events=[];const tracker=createDownloadProgress({fileCount:2,monotonic:()=>time,now:()=>Date.parse('2026-10-25T00:00:00Z')+time,setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{cleared=true;},onProgress:value=>events.push(value)});
 tracker.begin(0,'url');tracker.total(1000);time=1000;tracker.receive(500);assert.equal(events.at(-1).bytesPerSecond,500);assert.equal(events.at(-1).percent,50);const count=events.length;time=1100;tracker.receive(100);assert.equal(events.length,count);time=4100;tick();assert.equal(events.at(-1).bytesPerSecond,0);time=6100;tick();assert.equal(events.at(-1).stalled,true);assert.equal(events.at(-1).stallCount,1);tick();assert.equal(events.at(-1).stallCount,1);
 tracker.receive(400);tracker.phase('validating');assert.equal(events.at(-1).percent,100);assert.equal(events.at(-1).phase,'validating');tracker.phase('saving');tracker.saved();tracker.begin(1,'url');tracker.receive(200);assert.equal(events.at(-1).totalBytes,null);assert.equal(events.at(-1).percent,null);assert.equal(events.at(-1).fileIndex,2);assert.equal(events.at(-1).savedFileCount,1);assert.equal(events.at(-1).overallTotalBytes,null);assert.equal(events.at(-1).overallReceivedBytes,1200);tracker.close();const end=events.length;tick();assert.equal(events.length,end);assert.ok(cleared);
});
for(const headers of [{'content-length':'4'},{},{'content-length':'2','content-encoding':'gzip'}])test('D03 trusted size only for matching payload encoding '+JSON.stringify(headers),async t=>{
 const f=fixture(t,{fetchImpl:async()=>new Response('data',{headers})});await f.worker(f.task,[f.source],{onProgress:f.onProgress});const validation=f.events.find(e=>e.phase==='validating');assert.equal(validation.receivedBytes,4);assert.equal(validation.totalBytes,headers['content-length']==='4'?4:null);assert.equal(validation.percent,headers['content-length']==='4'?100:null);assert.equal(f.published.length,1);assert.ok(!f.events.some(e=>e.phase==='completed'));assert.equal(JSON.stringify(f.events).includes('fixture.invalid'),false);
});
for(const length of ['nonsense','-4','4.5','5'])test('D03 invalid or incomplete declared length '+length+' cannot publish',async t=>{
 const f=fixture(t,{fetchImpl:async()=>new Response('data',{headers:{'content-length':length}})});await assert.rejects(f.worker(f.task,[f.source],{onProgress:f.onProgress}),{code:'DOWNLOAD_INCOMPLETE'});assert.equal(f.published.length,0);
});
test('D03 loopback two files share absolute budget; injected budget replaces old worker cap',async t=>{
 const server=http.createServer((_req,res)=>{setTimeout(()=>{res.writeHead(200,{'content-length':'4'});res.end('data');},200);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const f=fixture(t,{timeoutMs:10}),source={...f.source,url:'http://127.0.0.1:'+server.address().port+'/result'};let start=performance.now();await f.worker(f.task,[source],{remainingMs:()=>600-(performance.now()-start),onProgress:f.onProgress});assert.equal(f.published.length,1);
 start=performance.now();await assert.rejects(f.worker(f.task,[source,source],{remainingMs:()=>300-(performance.now()-start),onProgress:f.onProgress}),{code:'DOWNLOAD_TIMEOUT'});assert.equal(f.published.length,2);
});
test('D03 inline payload has no fabricated network speed or downloaded bytes',async t=>{
 const f=fixture(t,{store:{downloadDirectory:()=>os.tmpdir(),readAsset:()=>({bytes:Buffer.from('data'),asset:{kind:'image'}}),publishVerifiedFile:()=>({assetId:'synthetic'})}});await f.worker(f.task,[{kind:'asset',assetId:'synthetic'}],{onProgress:f.onProgress});assert.ok(f.events.every(e=>e.bytesPerSecond===0&&e.overallReceivedBytes===0));assert.ok(f.events.every(e=>e.phase!=='downloading'));
});

test('D03 disk write failure still counts the received block and never publishes',async t=>{
 const f=fixture(t,{fetchImpl:async()=>new Response('data',{headers:{'content-length':'4'}})}),write=fs.writeFileSync;fs.writeFileSync=(target,...args)=>{if(typeof target==='number')throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});return write(target,...args);};
 try{await assert.rejects(f.worker(f.task,[f.source],{onProgress:f.onProgress}),{code:'DISK_FULL'});assert.equal(f.events.at(-1).receivedBytes,4);assert.equal(f.events.at(-1).overallReceivedBytes,4);assert.equal(f.published.length,0);}finally{fs.writeFileSync=write;}
});

test('D09 refreshed list resets effective totals/reuse but keeps actual transferred network bytes',()=>{
 const p=createDownloadProgress({fileCount:2});p.begin(0,'url');p.total(10);p.receive(10);p.saved();p.begin(1,'url');p.total(20);p.receive(5);p.configure(2);p.begin(0,'url');p.reuse(10);assert.equal(p.snapshot().reusedBytes,10);assert.equal(p.snapshot().overallReceivedBytes,15);assert.equal(p.snapshot().overallTotalBytes,null);p.configure(2);p.begin(0,'url');p.receive(4);assert.equal(p.snapshot().reusedBytes,0);assert.equal(p.snapshot().savedFileCount,0);assert.equal(p.snapshot().completedBytes,4);p.close();
});
test('D09 unauthenticated CDN forbidden does not assert link expiry',async t=>{const f=fixture(t,{fetchImpl:async()=>new Response(null,{status:403})});await assert.rejects(f.worker(f.task,[f.source]),{code:'DOWNLOAD_ACCESS_DENIED'});});
