'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../plugin-runtime/registry');
const { createPluginAdapter } = require('../tasks/plugin-adapter');
const plugin = registry.getPlugin('ccode-h3');
const auth = { connectionVersionId: 'synthetic-version', baseUrl: 'https://pro.ccode.vip/v1', apiKey: 'synthetic-protected-key' };
const task = { upstream_task_id: 'opaque/A?B#C', request_json: JSON.stringify({ model: 'synthetic-model', facets: {}, fields: { prompt: '原文\n"对白"' }, media: {} }) };
function mock(t, response) { const previous = global.fetch, calls = []; global.fetch = async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(url, init) : response; }; t.after(() => { global.fetch = previous; }); return calls; }
for (const status of [400, 429, 503]) test('desktop plugin POST ' + status + ' is single-attempt, with explicit rejection only for complete 4xx', async t => {
    const calls = mock(t, Response.json({ error: { message: 'synthetic upstream rejection' } }, { status, headers: { 'retry-after': '30' } }));
    await assert.rejects(createPluginAdapter(plugin).submit(task, {}, auth), error => error.httpStatus === status && error.definiteRejection === (status < 500));
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'manual');
});
test('usable task ID from an error HTTP response is retained rather than triggering another POST', async t => {
    mock(t, Response.json({ id: 'accepted-despite-503', status: 'queued' }, { status: 503 }));
    assert.equal((await createPluginAdapter(plugin).submit(task, {}, auth)).upstreamTaskId, 'accepted-despite-503');
});
test('poll only GETs an encoded opaque ID at the frozen origin and preserves raw unknown status without inventing failure', async t => {
    const calls = mock(t, Response.json({ status: 'A_NEW_STATUS', progress: 42 }));
    const output = await createPluginAdapter(plugin).poll(task, {}, auth); assert.equal(output.remoteState, 'unknown'); assert.equal(output.rawStatus, 'A_NEW_STATUS'); assert.equal(output.progress, 42);
    assert.equal(calls[0].url, 'https://pro.ccode.vip/v1/videos/opaque%2FA%3FB%23C'); assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-protected-key');
});
for (const body of ['{"error":"synthetic auth"}', '<html>synthetic auth</html>']) test('401 response metadata survives ' + (body.startsWith('<') ? 'HTML' : 'JSON') + ' and never becomes a remote task failure', async t => {
    mock(t, new Response(body, { status: 401 })); await assert.rejects(createPluginAdapter(plugin).poll(task, {}, auth), { httpStatus: 401 });
});
test('driver POST-style queries and attempts to leave the frozen origin are rejected before fetch', async t => {
    const calls = mock(t, Response.json({}));
    for (const request of [{ url: 'https://pro.ccode.vip/query', method: 'POST' }, { url: 'https://unlisted.invalid/query', method: 'GET' }]) {
        const driver = { ...plugin, driver: { buildQuery: async () => request } };
        await assert.rejects(createPluginAdapter(driver).poll(task, {}, auth));
    }
    assert.equal(calls.length, 0);
});
test('percent-encoded key echoes are rejected before IDs, unknown states or result URLs escape parsing', async t => {
    const encoded = [...Buffer.from(auth.apiKey)].map(value => '%' + value.toString(16)).join(''); mock(t, () => Response.json({ id: encoded, status: 'completed', video_url: 'https://cdn.invalid/result.mp4' }));
    await assert.rejects(createPluginAdapter(plugin).submit(task, {}, auth), { credentialRedacted: true }); await assert.rejects(createPluginAdapter(plugin).poll(task, {}, auth), { credentialRedacted: true });
});
test('remote completed without usable candidates remains remote completed for the download boundary, never local completed', async t => {
    mock(t, Response.json({ status: 'completed', progress: 100 })); const noFallback={...plugin,provider:{...plugin.provider,poll:{...plugin.provider.poll,result:{assets:[{kind:'video',url:['video_url']}]}}}}; const result = await createPluginAdapter(noFallback).poll(task, {}, auth); assert.equal(result.remoteState, 'completed'); assert.deepEqual(result.resultSources, []);
});

test('a safe accepted ID is persisted before a later credential-contaminated field is rejected',async t=>{
    mock(t,Response.json({id:'safe-accepted-id',status:'completed',video_url:'https://cdn.invalid/synthetic-protected-key'}));
    let observed;await assert.rejects(createPluginAdapter(plugin).submit(task,{}, {...auth,onAccepted:id=>{observed=id;}}),{credentialRedacted:true});
    assert.equal(observed,'safe-accepted-id');
});


test('poll response timing is observable without exporting IDs, credentials, response body or URL',async t=>{
 mock(t,Response.json({status:'queued',progress:42,private:'PRIVATE'}));const events=[];
 await createPluginAdapter(plugin).poll(task,{}, {...auth,diagnostic:(point,payload)=>events.push({point,...payload})});
 assert.deepEqual(events.map(e=>e.point),['request_started','query_response','query_body']);assert.equal(events[1].httpStatus,200);assert.ok(events[1].durationMs>=0);assert.ok(events[2].byteLength>0);
 for(const privateValue of ['PRIVATE',auth.apiKey,auth.baseUrl,task.upstream_task_id])assert.ok(!JSON.stringify(events).includes(privateValue));
});


for(const [body,parseOutcome]of [['not JSON','invalid_json'],['{}','missing_task_id'],['{"id":".."}','invalid_task_id']])test('malformed successful POST is distinguished as '+parseOutcome,async t=>{
 mock(t,new Response(body,{status:200}));await assert.rejects(createPluginAdapter(plugin).submit(task,{},auth),error=>error.code==='SUBMISSION_UNKNOWN'&&error.parseOutcome===parseOutcome);
});

for (const payload of [{code:'model_not_found'},{error:{code:'model_disabled'}}]) test('structured model rejection without message is definite and observable',async t=>{const calls=mock(t,Response.json(payload,{status:400}));await assert.rejects(createPluginAdapter(plugin).submit(task,{},auth),error=>error.modelUnavailable===true&&error.definiteRejection===true&&error.transmission==='response_received');assert.equal(calls.length,1);});
test('plugin usage error is not model disappearance and accepted IDs always win',async t=>{let accepted=false;mock(t,()=>Response.json(accepted?{id:'known-id',error:{code:'model_not_found'}}:{error:{code:'plugin_usage_invalid'}},{status:400}));await assert.rejects(createPluginAdapter(plugin).submit(task,{},auth),error=>!error.modelUnavailable&&error.definiteRejection);accepted=true;assert.equal((await createPluginAdapter(plugin).submit(task,{},auth)).upstreamTaskId,'known-id');});
