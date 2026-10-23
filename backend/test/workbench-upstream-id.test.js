'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isQueryableUpstreamTaskId,encodeUpstreamTaskId}=require('../plugin-runtime/upstream-id');
const registry=require('../plugin-runtime/registry'),executor=require('../plugin-runtime/executor');
const {createPluginAdapter}=require('../tasks/plugin-adapter');
const video=registry.getPlugin('opensosen-video'),legacy=registry.getPlugin('ccode-h3');
const auth={connectionVersionId:'synthetic-version',baseUrl:'https://newapi.opensosen.com/v1',apiKey:'synthetic-review-private'};
const legacyAuth={...auth,baseUrl:'https://pro.ccode.vip/v1'};
const task=id=>({upstream_task_id:id,request_json:JSON.stringify({model:'grok-imagine-video-1.5-6s',fields:{prompt:'中文原文'},facets:{}})});
const context=id=>({...auth,model:'grok-imagine-video-1.5-6s',upstreamTaskId:id});
test('WHATWG normalizes literal and percent-encoded dot segments, so percent-encoding dots is not a safe workaround',()=>{
    for(const segment of ['.','%2E','%2e'])assert.equal(new URL('https://upstream.invalid/v1/videos/'+segment).pathname,'/v1/videos/');
    for(const segment of ['..','%2E%2E','.%2e','%2e.'])assert.equal(new URL('https://upstream.invalid/v1/videos/'+segment).pathname,'/v1/');
});
for(const id of ['.','..'])test('pure dot ID '+id+' is rejected at helper, driver query/content, declarative query and shared executor before fetch',async t=>{
    let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({status:'completed'});});
    assert.equal(isQueryableUpstreamTaskId(id),false);assert.throws(()=>encodeUpstreamTaskId(id),{code:'INVALID_UPSTREAM_ID'});
    assert.throws(()=>video.driver.buildQuery(id,context(id)),{code:'INVALID_UPSTREAM_ID'});
    assert.throws(()=>video.driver.parseTaskResult({status:'completed'},context(id)),{code:'INVALID_UPSTREAM_ID'});
    assert.throws(()=>video.driver.parseSubmitResponse({id,task_id:id}),{code:'SUBMISSION_UNKNOWN'});
    await assert.rejects(createPluginAdapter(video).poll(task(id),{},auth),{code:'INVALID_UPSTREAM_ID'});
    await assert.rejects(createPluginAdapter(legacy).poll(task(id),{},legacyAuth),{code:'INVALID_UPSTREAM_ID'});
    await assert.rejects(executor.pollTask(video,executor.buildContext({...context(id),plugin:video})),{code:'INVALID_UPSTREAM_ID'});
    const declarative=executor.buildContext({...legacyAuth,plugin:legacy,upstreamTaskId:id});
    await assert.rejects(executor.pollTask(legacy,declarative),{code:'INVALID_UPSTREAM_ID'});
    assert.throws(()=>executor.normalizePollResponse(legacy,{status:'completed'},declarative),{code:'INVALID_UPSTREAM_ID'});
    assert.equal(calls,0);
});
test('ordinary dotted, slash, percent and Chinese opaque IDs keep one exact query/content segment in script and declarative paths',async t=>{
    const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url,init});return Response.json({status:'completed',progress:100});});
    for(const id of ['a.b','.hidden','version..1','...',' . ','opaque/A?B#C','百分号%中文/版本.1','%2e','%2E%2E']){
        const encoded=encodeURIComponent(id),queryPath='/v1/videos/'+encoded,contentPath=queryPath+'/content';
        assert.equal(isQueryableUpstreamTaskId(id),true);assert.equal(encodeUpstreamTaskId(id),encoded);
        assert.equal(new URL(video.driver.buildQuery(id,context(id)).url).pathname,queryPath);
        assert.equal(new URL(video.driver.parseTaskResult({status:'completed'},context(id)).assets[0].url).pathname,contentPath);
        const script=await createPluginAdapter(video).poll(task(id),{},auth);
        assert.equal(new URL(calls.at(-1).url).pathname,queryPath);assert.equal(new URL(script.resultSources[0].url).pathname,contentPath);
        const declarative=await createPluginAdapter(legacy).poll(task(id),{},legacyAuth);
        assert.equal(new URL(calls.at(-1).url).pathname,queryPath);assert.equal(new URL(declarative.resultSources[0].url).pathname,contentPath);
        const shared=await executor.pollTask(legacy,executor.buildContext({...legacyAuth,plugin:legacy,upstreamTaskId:id}));
        assert.equal(new URL(calls.at(-1).url).pathname,queryPath);assert.equal(new URL(shared.assets[0].url).pathname,contentPath);
        assert.equal(decodeURIComponent(new URL(calls.at(-1).url).pathname.slice('/v1/videos/'.length)),id);
    }
    assert.ok(calls.every(call=>call.init.method==='GET'));
});
for(const id of ['.','..'])test('declarative accepted dot ID '+id+' never escapes to onAccepted or immediate content normalization',async t=>{
    let calls=0,accepted=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({id,status:'completed',video_url:'https://cdn.invalid/synthetic.mp4'});});
    await assert.rejects(createPluginAdapter(legacy).submit(task(id),{}, {...legacyAuth,onAccepted:()=>{accepted++;}}),{code:'SUBMISSION_UNKNOWN'});
    assert.equal(calls,1);assert.equal(accepted,0);
});
