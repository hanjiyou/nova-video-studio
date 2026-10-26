'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDownloadWorker}=require('../storage/download-worker');
const base='https://newapi.opensosen.com/v1',original=base+'/videos/original%2F%E4%B8%AD%E6%96%87/content',mapped=original.replace('.com/','.cn/');
function fixture(t,{baseUrl=base,redirects=[],status=200,route='cn'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nova-cn-policy-')),calls=[],checked=[];
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const worker=createDownloadWorker({store:{downloadDirectory:()=>dir,publishVerifiedFile:()=>({assetId:'verified'})},connections:{getAuth:()=>({provider:'opensosen',baseUrl,apiKey:'synthetic-cn-key'}),getTransportRoute:()=>({route,revision:1})},checkUrl:async url=>checked.push(url.href),validate:async()=>({kind:'video'}),fetchImpl:async(url,init)=>{calls.push({url,authorization:init.headers.Authorization});const next=redirects[calls.length-1];return next?new Response(null,{status:302,headers:{location:next}}):new Response(status===200?Buffer.from('synthetic-media'):null,{status});}});
 const source={kind:'url',url:original,authScope:'connection',mediaKind:'video'};
 return {calls,checked,source,run:(value=source)=>worker({connection_version_id:'original-version'},[value])};
}
test('selected cn maps only transport, accepts encoded ID segment and keeps source unchanged across retry',async t=>{
 const f=fixture(t),snapshot=JSON.stringify(f.source);await f.run();await f.run();assert.deepEqual(f.calls.map(x=>x.url),[mapped,mapped]);assert.deepEqual(f.checked,[mapped,mapped]);assert.ok(f.calls.every(x=>x.authorization==='Bearer synthetic-cn-key'));assert.equal(JSON.stringify(f.source),snapshot);
});
for(const redirect of ['https://cdn.invalid/video', 'https://newapi.opensosen.cn/v1/models','https://newapi.opensosen.cn/v1/videos/another/content',base+'/videos/original%2F%E4%B8%AD%E6%96%87/content',mapped+'?x=1'])test('mapped authorization is stripped on redirect to '+redirect,async t=>{
 const f=fixture(t,{redirects:[redirect,mapped]});await f.run();assert.deepEqual(f.calls.map(x=>x.authorization),['Bearer synthetic-cn-key',undefined,undefined]);
});
test('foreign or direct cn connection-auth source is still forbidden',async t=>{
 const f=fixture(t);for(const url of [mapped,'https://newapi.opensosen.cn/v1/models','https://cdn.invalid/video'])await assert.rejects(f.run({...f.source,url}),{code:'DOWNLOAD_FORBIDDEN'});assert.equal(f.calls.length,0);
});
test('no mapping for other service, media kind, scope or non-exact content URL',async t=>{
 const cases=[{baseUrl:'https://other.invalid/v1',url:'https://other.invalid/v1/videos/a/content'}, {mediaKind:'image'}, {authScope:'none'}, {url:base+'/videos/a/extra/content'}, {url:base+'/videos/a'}, {url:original+'?download=1'}, {baseUrl:base+'/other',url:base+'/other/videos/a/content'}];
 for(const item of cases){const f=fixture(t,{baseUrl:item.baseUrl}),source={...f.source,...item};await f.run(source);assert.equal(f.calls[0].url,source.url);}
});
test('mapped failure never falls back to com or resubmits generation',async t=>{
 const f=fixture(t,{status:401});await assert.rejects(f.run(),{code:'AUTH_REJECTED'});assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,mapped);
});

test('selected com keeps old com content on com and maps approved cn identity back to com',async t=>{
 const f=fixture(t,{route:'com'});await f.run();assert.equal(f.calls[0].url,original);
 const other=fixture(t,{baseUrl:'https://newapi.opensosen.cn/v1',route:'com'});await other.run({...other.source,url:mapped});assert.equal(other.calls[0].url,original);assert.equal(other.calls[0].authorization,'Bearer synthetic-cn-key');
});
test('one worker attempt freezes route across several files; next invocation reads new selection',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-routes-')),calls=[];t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let route='cn';
 const worker=createDownloadWorker({store:{downloadDirectory:()=>directory,publishVerifiedFile:()=>({assetId:'verified'})},connections:{getAuth:()=>({provider:'opensosen',baseUrl:base,apiKey:'synthetic-key'}),getTransportRoute:()=>({route,revision:route==='cn'?1:2})},checkUrl:async()=>{},validate:async()=>({kind:'video'}),fetchImpl:async(url)=>{calls.push(url);route='com';return new Response('synthetic-media');}});
 const source={kind:'url',url:original,authScope:'connection',mediaKind:'video'};await worker({connection_version_id:'v'},[source,source]);await worker({connection_version_id:'v'},[source]);assert.deepEqual(calls,[mapped,mapped,original]);
});
