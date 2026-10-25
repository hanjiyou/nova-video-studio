'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {createUpdateDiagnostics,LIMIT}=require('./update-diagnostics.cjs');
const {attachInstallerLaunchProof}=require('./update-launcher.cjs');
const {classifyError}=require('../backend/tasks/diagnostic-error');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nova-update-journal-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,currentVersion:'3.6.2',networkMode:'direct'};}
test('bounded persisted journal survives restart, projects secrets twice and observes target once without asserting install success',t=>{
 const options=fixture(t),journal=createUpdateDiagnostics(options);journal.begin();
 const secret='PRIVATE bearer key https://private.invalid C:/Users/private';
 for(let n=0;n<450;n++)journal.record('download_progress',{percent:n,raw:secret,code:secret,errorCategory:secret,targetVersion:secret});
 journal.record('install_requested',{targetVersion:'3.6.3'});journal.record('installer_spawned');journal.record('parent_quit_requested');
 const next=createUpdateDiagnostics({...options,currentVersion:'3.6.3'});assert.equal(next.snapshot().events.length,LIMIT);assert.ok(next.snapshot().omitted>0);assert.equal(next.snapshot().events.filter(e=>e.event==='target_version_started').length,1);
 const third=createUpdateDiagnostics({...options,currentVersion:'3.6.3'});assert.equal(third.snapshot().events.filter(e=>e.event==='target_version_started').length,1);
 const text=JSON.stringify(third.snapshot());assert.ok(!text.includes(secret));assert.ok(!text.includes('install_succeeded'));assert.equal(third.snapshot().health.persistenceHealthy,true);
 const file=path.join(options.directory,'update-diagnostics.json'),saved=JSON.parse(fs.readFileSync(file));saved.events.push({event:'downloaded',raw:secret,sessionId:secret});fs.writeFileSync(file,JSON.stringify(saved));assert.ok(!JSON.stringify(createUpdateDiagnostics(options).snapshot()).includes(secret));
});
test('journal failure degrades observability without throwing, reports health; corrupt/oversize data never exported',t=>{
 const options=fixture(t),io={...fs,openSync(){throw Object.assign(Error('PRIVATE'),{code:'EACCES'});}},journal=createUpdateDiagnostics({...options,io});assert.doesNotThrow(()=>journal.record('install_requested',{targetVersion:'3.6.3'}));assert.equal(journal.snapshot().health.writeFailures,2);assert.equal(journal.snapshot().health.persistenceHealthy,false);
 fs.writeFileSync(path.join(options.directory,'update-diagnostics.json'),'PRIVATE'.repeat(100000));const next=createUpdateDiagnostics(options);assert.equal(next.snapshot().health.readState,'unreadable');assert.ok(!JSON.stringify(next.snapshot()).includes('PRIVATE'));
});
test('journal uses exclusive own temporary file and refuses symbolic destination without touching its target',t=>{
 const options=fixture(t);let flags;const io={...fs,openSync(file,mode,...rest){flags=mode;return fs.openSync(file,mode,...rest);}};createUpdateDiagnostics({...options,io});assert.equal(flags,'wx');
 const rejecting={...fs,lstatSync(){return {isFile:()=>true,isSymbolicLink:()=>true,size:1};},openSync(){assert.fail('must not open');}};assert.equal(createUpdateDiagnostics({...options,io:rejecting}).snapshot().health.persistenceHealthy,false);
});
for(const silent of [false,true])test('installer window policy is explicit for '+(silent?'silent':'interactive')+' and records only spawn evidence',async t=>{
 const journal=createUpdateDiagnostics(fixture(t)),child=new EventEmitter(),updater={};child.unref=()=>{};let options;
 const proof=attachInstallerLaunchProof(updater,(_file,_args,opts)=>{options=opts;return child;},journal);
 const pending=updater.spawnLog('PRIVATE path',silent?['/S']:['--updated']);assert.equal(options.windowsHide,silent);child.emit('spawn');await pending;assert.equal(await proof.confirm(),true);child.emit('exit',0);
 const events=journal.snapshot().events;assert.ok(events.some(e=>e.event==='installer_exit_observed'&&e.exitCode===0));assert.ok(!JSON.stringify(events).includes('PRIVATE'));assert.ok(!events.some(e=>e.event==='install_succeeded'));
});
test('network classification uses nested codes only, never message heuristics',()=>{
 for(const [code,expected]of [['ENOTFOUND','dns'],['ECONNREFUSED','connection_refused'],['ECONNRESET','connection_reset'],['CERT_HAS_EXPIRED','tls'],['UND_ERR_HEADERS_TIMEOUT','timeout']])assert.equal(classifyError({code:'SUBMISSION_UNKNOWN',cause:{code,message:'PRIVATE'}}),expected);
 assert.equal(classifyError({message:'ENOTFOUND key'}),'unknown');assert.equal(classifyError({name:'AbortError'}),'aborted');assert.equal(classifyError({httpStatus:503}),'http');
});


test('updater HTTP and storage/integrity categories preserve only fixed codes',()=>{
 assert.equal(classifyError({statusCode:403}),'http');for(const [code,category]of [['ENOSPC','disk_full'],['EPERM','file_permission'],['EBUSY','file_busy'],['ERR_CHECKSUM_MISMATCH','checksum'],['ERR_UPDATER_INVALID_SIGNATURE','signature']])assert.equal(classifyError({code,message:'PRIVATE'}),category);
});
