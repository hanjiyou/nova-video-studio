'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createEditorDiagnostics,project,LIMIT,MAX_BYTES}=require('../../desktop/openchatcut/diagnostics.cjs');
const {classifyText,errorFields}=require('../../desktop/openchatcut/diagnostic-fields.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-editor-log-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true,maxRetries:4}));return directory;}

test('attempts persist bounded stage timing and safe error fields, never raw user or process content',t=>{
  const directory=fixture(t);let clock=1000;const logger=createEditorDiagnostics({directory,currentVersion:'3.6.11',clock:()=>clock});const first=logger.begin();
  first('open_requested',{stage:'preflight',deadlineMs:30000});clock+=4500;
  first('service_phase',{stage:'service-start',servicePhase:'imports',serviceElapsedMs:4200,prompt:'PRIVATE PROMPT',url:'https://private.invalid/key=SECRET',path:'C:/PRIVATE',apiKey:'SECRET'});
  const second=logger.begin();clock+=500;
  first('service_exit',{exitCode:1});second('console_error',{...classifyText('UnknownError: Internal error. SECRET'),message:'PRIVATE PROMPT'});
  const bytes=fs.readFileSync(path.join(directory,'editor-diagnostics.json'),'utf8'),data=JSON.parse(bytes);
  assert.equal(data.format,'nova-editor-diagnostics-v1');assert.equal(/PRIVATE|SECRET|private.invalid/.test(bytes),false);
  const opens=data.events.find(item=>item.event==='open_requested'),phase=data.events.find(item=>item.event==='service_phase'),exit=data.events.find(item=>item.event==='service_exit'),consoleError=data.events.find(item=>item.event==='console_error');
  assert.equal(phase.attemptId,opens.attemptId);assert.equal(exit.attemptId,opens.attemptId);assert.notEqual(consoleError.attemptId,opens.attemptId);
  assert.equal(phase.elapsedMs,4500);assert.equal(consoleError.elapsedMs,500);assert.equal(consoleError.errorName,'UnknownError');assert.equal(consoleError.category,'browser-error');
});

test('console floods are bounded and persisted history is re-projected before reuse',t=>{
  const directory=fixture(t),file=path.join(directory,'editor-diagnostics.json');
  fs.writeFileSync(file,JSON.stringify({events:[{event:'page_loaded',url:'https://PRIVATE',prompt:'PRIVATE'},{event:'bad-event',message:'PRIVATE'}]}));
  const logger=createEditorDiagnostics({directory,currentVersion:'3.6.11'}),record=logger.begin();
  for(let i=0;i<100;i++)record('console_error',{category:'javascript',message:'SECRET'});
  assert.equal(logger.snapshot().events.filter(item=>item.event==='console_error').length,8);
  for(let i=0;i<LIMIT+20;i++)record('open_reused');
  assert.equal(logger.snapshot().events.length,LIMIT);assert.ok(logger.snapshot().omitted>0);assert.ok(fs.statSync(file).size<MAX_BYTES);
  assert.equal(/SECRET|PRIVATE|https:/.test(fs.readFileSync(file,'utf8')),false);
});

test('write failures cannot stop editing and atomic temporary files are cleaned up',t=>{
  const directory=fixture(t);const logger=createEditorDiagnostics({directory,currentVersion:'3.6.11',io:{...fs,renameSync(){throw Object.assign(Error('SECRET PATH'),{code:'EACCES'});}}});
  assert.doesNotThrow(()=>logger.begin()('startup_failed',{code:'EDITOR_LOAD_FAILED'}));assert.ok(logger.snapshot().writeFailures>=2);
  assert.deepEqual(fs.readdirSync(directory),[]);
});

test('diagnostic classification is categorical, schema rejects paths, URLs, unknown codes and unbounded error text',()=>{
  assert.deepEqual(errorFields({name:'Error',code:'ERR_MODULE_NOT_FOUND',message:'PRIVATE',stack:'PRIVATE'}),{errorName:'Error',systemCode:'ERR_MODULE_NOT_FOUND'});
  assert.equal(classifyText('Error [ERR_MODULE_NOT_FOUND]: Cannot find package SECRET').category,'module-load');
  assert.equal(classifyText('IndexedDB: QuotaExceededError: SECRET').category,'browser-storage');assert.equal(classifyText('WebGL shader SECRET').category,'graphics');
  assert.deepEqual(project({event:'startup_failed',code:'EDITOR_SECRET',errorName:'SECRET',reason:'SECRET',systemCode:'SECRET',stage:'SECRET',url:'SECRET'}),{event:'startup_failed'});
  assert.equal(project({event:'SECRET'}),null);
});
