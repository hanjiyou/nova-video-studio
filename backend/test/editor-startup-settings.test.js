'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {start}=require('./support/desktop-http-runtime.cjs');
const {validEditorSettings,normalizeEditorSettings}=require('../storage/editor-settings');

test('editor timeout validates a single bounded integer and defaults old profiles to 90 seconds',()=>{
  assert.deepEqual(normalizeEditorSettings(null),{startupTimeoutSeconds:90});
  for(const seconds of [30,90,300])assert.equal(validEditorSettings({startupTimeoutSeconds:seconds}),true);
  for(const seconds of [undefined,null,'90','',29,301,1.5,NaN,Infinity,true])assert.equal(validEditorSettings({startupTimeoutSeconds:seconds}),false);
  assert.equal(validEditorSettings({startupTimeoutSeconds:90,path:'arbitrary'}),false);
});

test('authenticated settings HTTP persists across restart, rejects invalid edits and stale revisions without overwriting',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-editor-setting-'));
  let runtime=await start(directory);
  t.after(async()=>{await runtime.stop();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const route='/api/nova/storage/settings/editor',put=(value,expectedRevision)=>runtime.request(route,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value,expectedRevision})});
  assert.deepEqual((await(await runtime.request(route)).json()).setting.value,{startupTimeoutSeconds:90});
  const response=await put({startupTimeoutSeconds:120},0);assert.equal(response.status,200);const saved=(await response.json()).setting;
  for(const value of [null,{},[],{startupTimeoutSeconds:'90'},{startupTimeoutSeconds:29},{startupTimeoutSeconds:301},{startupTimeoutSeconds:60.5},{startupTimeoutSeconds:90,command:'arbitrary'}]){
    const rejected=await put(value,saved.revision);assert.equal(rejected.status,400);assert.equal((await rejected.json()).code,'INVALID_SETTING_VALUE');
  }
  assert.equal((await put({startupTimeoutSeconds:180},0)).status,409);
  assert.deepEqual((await(await runtime.request(route)).json()).setting,saved);
  assert.equal((await fetch(runtime.origin+route)).status,403);
  await runtime.stop();runtime=await start(directory);
  assert.deepEqual((await(await runtime.request(route)).json()).setting,saved);
});
