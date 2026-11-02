'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const release = require('./release-windows-update.cjs');
const { makePlan, readPolicy, planForRecord, builderConfiguration } = require('./lib/windows-update.cjs');
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-release-api-test-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('nova-release-api-test-')); fs.rmSync(directory, { recursive: true }); });
  const policy = readPolicy(); policy.signing = { status: 'approved', publisherNames: ['Fixture only'] }; policy.runtimeReady = true;
  const plan = makePlan({ profile: 'release', version: '3.5.4' }, policy); plan.source = { commit: SHA, clean: true };
  const assets = [plan.artifactName, plan.artifactName + '.blockmap', 'latest.yml'].map((name, i) => {
    const bytes = Buffer.from(`INERT TEST ONLY ${i}`); fs.writeFileSync(path.join(directory, name), bytes);
    return { id: i + 1, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64'), state: 'uploaded' };
  });
  const gates = { schemaVersion: 1, repository: 'hanjiyou/nova-video-studio' };
  for (const key of ['sourceAndLicenseDelivery', 'ffmpegCorrespondingSource', 't15RemainingModes', 'm5ReleaseAcceptance', 'isolatedInstalledUpdate']) gates[key] = { status: 'complete', evidence: 'INERT API TEST ONLY' };
  const calls = [], state = { assets: [...assets], target: SHA, tag: null, published: false, releases: [] };
  const request = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('uploads.github.com')) {
      const name = new URL(url).searchParams.get('name'), asset = assets.find(a => a.name === name);
      assert.ok(asset); assert.equal(state.assets.some(a => a.name === name), false, 'Never overwrite existing asset');
      state.assets.push(asset); return asset;
    }
    if (url.includes('/git/ref/tags/')) return state.tag;
    if (url.includes('/git/tags/')) return { object: { type: 'commit', sha: state.tagCommit || SHA } };
    if (url.includes('/git/commits/')) return { sha: SHA };
    if (url.endsWith('/repos/hanjiyou/nova-video-studio')) return { full_name: 'hanjiyou/nova-video-studio', private: false };
    if (url.includes('/releases?')) return state.releases;
    if (url.endsWith('/releases') && options.method === 'POST') { state.target = options.body.target_commitish; return { id: 42 }; }
    if (url.includes('/assets?')) return state.assets;
    if (url.endsWith('/releases/42') && options.method === 'PATCH') { state.published = true; return { draft: false, tag_name: plan.tag }; }
    if (url.endsWith('/releases/42')) return { draft: true, prerelease: false, tag_name: plan.tag, target_commitish: state.target };
    throw new Error('Unexpected mock endpoint: ' + url);
  };
  const deps = { policy, gates, verifyDirectory: async () => ({ plan, summary: { signature: { mode: 'authenticode', results: [] } } }), remote: { token: 'INERT API TEST ONLY', request, hashAsset: async id => { const a = assets.find(a => a.id === id); return { size: a.size, sha512: a.sha512 }; } } };
  const options = { directory, phase: 'verify', execute: true, releaseId: '42', commit: SHA, confirmTag: plan.tag };
  return { directory, policy, plan, assets, state, calls, deps, options };
}
function serverDigests(f) {
  for (const asset of f.assets) { asset.digest = 'sha256:' + asset.sha256; asset.updated_at = '2026-11-02T00:00:00Z'; }
}
test('formal record requires source commit and builder binds it outside runtime metadata', t => {
  const f = fixture(t), record = { profile: 'release', version: f.plan.version, testFeedUrl: null, metadata: f.plan.metadata, source: f.plan.source };
  assert.deepEqual(planForRecord(record, f.policy).source, f.plan.source);
  assert.throws(() => planForRecord({ ...record, source: undefined }, f.policy), /clean source commit/);
  assert.throws(() => planForRecord({ ...record, source: { commit: SHA, clean: false } }, f.policy), /clean source commit/);
  assert.deepEqual(builderConfiguration(f.plan, 'inert').extraMetadata.novaBuild, f.plan.source);
  assert.equal('source' in f.plan.metadata, false);
});
test('prepare/publish without execute never invokes a remote API or needs token', async t => {
  const f = fixture(t); const report = await release.run({ ...f.options, phase: 'publish', execute: false }, f.deps);
  assert.equal(report.dryRun, true); assert.equal(f.calls.length, 0);
});
test('wrong supplied commit, draft target or tag commit is rejected before write', async t => {
  const f = fixture(t);
  await assert.rejects(release.run({ ...f.options, phase: 'publish', commit: OTHER }, f.deps), /signed package/);
  f.state.target = OTHER;
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /Draft target commit/);
  f.state.target = SHA; f.state.tag = { object: { type: 'commit', sha: OTHER } };
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /Existing tag/);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});
test('annotated tag is dereferenced to reviewed source and verify stays draft', async t => {
  const f = fixture(t); f.state.tag = { object: { type: 'tag', sha: OTHER } };
  const result = await release.run(f.options, f.deps);
  assert.equal(result.remoteVerified, true); assert.equal(result.published, false); assert.equal(f.state.published, false);
  assert.ok(f.calls.some(c => c.url.includes('/git/tags/')));
});
test('upload resumes a partial draft, checks existing bytes first and only adds missing assets', async t => {
  const f = fixture(t); f.state.assets = [f.assets[0]];
  const result = await release.run({ ...f.options, phase: 'upload' }, f.deps);
  assert.equal(result.published, false); assert.equal(f.state.assets.length, 3);
  const uploads = f.calls.filter(c => c.method === 'POST'); assert.equal(uploads.length, 2);
  assert.ok(uploads.every(c => c.url.includes('uploads.github.com'))); assert.equal(f.state.published, false);
});
test('existing wrong draft bytes block all uploads and are never cached or replaced', async t => {
  const f = fixture(t); f.state.assets = [f.assets[0]];
  serverDigests(f); f.options.verification = 'full-download';
  f.deps.verificationCache = new Map(); let hashes = 0;
  f.deps.remote.hashAsset = async () => { hashes++; return { size: f.assets[0].size, sha512: 'wrong' }; };
  await assert.rejects(release.run({ ...f.options, phase: 'upload' }, f.deps), /Remote asset bytes differ/);
  await assert.rejects(release.run({ ...f.options, phase: 'upload' }, f.deps), /Remote asset bytes differ/);
  assert.equal(hashes, 2); assert.equal(f.deps.verificationCache.size, 0);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});
test('same-version draft prevents new release creation even without tag', async t => {
  const f = fixture(t); f.state.releases = [{ tag_name: f.plan.tag, draft: true }];
  const notes = path.join(f.directory, 'notes.txt'); fs.writeFileSync(notes, 'INERT release notes');
  await assert.rejects(release.run({ ...f.options, phase: 'draft', notesFile: notes }, f.deps), /already exists/);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});
test('new draft uploads the complete asset set and verifies while remaining unpublished', async t => {
  const f = fixture(t); f.state.assets = [];
  const notes = path.join(f.directory, 'notes.txt'); fs.writeFileSync(notes, 'INERT release notes');
  const result = await release.run({ ...f.options, phase: 'draft', notesFile: notes }, f.deps);
  assert.equal(result.releaseId, 42); assert.equal(result.published, false); assert.equal(f.state.published, false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 4);
  assert.equal(f.state.assets.length, 3);
});
test('pending license gate rejects execute before API or token access', async t => {
  const f = fixture(t); f.deps.gates.ffmpegCorrespondingSource.status = 'pending';
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /ffmpegCorrespondingSource/);
  assert.equal(f.calls.length, 0);
});
test('publish requires explicit matching tag and complete remote assets', async t => {
  const f = fixture(t);
  await assert.rejects(release.run({ ...f.options, phase: 'publish', confirmTag: 'v0.0.0' }, f.deps), /confirm-tag/);
  f.state.assets = [f.assets[0]];
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /missing, extra/);
  assert.equal(f.state.published, false);
  f.state.assets = [...f.assets];
  const result = await release.run({ ...f.options, phase: 'publish' }, f.deps);
  assert.equal(result.published, true); assert.equal(f.state.published, true);
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('duplicate phase and arbitrary repository arguments are rejected', () => {
  assert.throws(() => release.args(['--directory', 'inert', '--phase', 'draft', '--phase', 'publish']), /repeated/);
  assert.throws(() => release.args(['--directory', 'inert', '--repo', 'different/repo']));
});


test('GitHub test publishing uses its own manifest and requires bound clean source without weakening formal gates',async t=>{
 const f=fixture(t);const plan=makePlan({profile:'github-test',version:'3.6.5'},f.policy);plan.source={commit:SHA,clean:true};
 const oldManifest=path.join(f.directory,'latest.yml');fs.renameSync(oldManifest,path.join(f.directory,'nova-test.yml'));
 for(const [i,name] of [plan.artifactName,plan.artifactName+'.blockmap'].entries())fs.renameSync(path.join(f.directory,f.assets[i].name),path.join(f.directory,name));
 f.deps.verifyDirectory=async()=>({plan,summary:{signature:plan.signature}});
 const report=await release.run({...f.options,execute:false},f.deps);assert.deepEqual(report.blockers,[]);assert.equal(report.assets[2].name,'nova-test.yml');assert.equal(f.calls.length,0);
 delete plan.source;assert.match(release.blockers(plan,f.deps.gates,f.policy).join(' '),/clean source/);
 assert.ok(release.blockers({...plan,profile:'local-test'},f.deps.gates,f.policy).length);
});
test('resume finds existing matching draft after lost creation response, uploads only missing assets',async t=>{
 const f=fixture(t);f.state.releases=[{id:42,tag_name:f.plan.tag}];f.state.assets=[f.assets[0]];
 const result=await release.run({...f.options,releaseId:undefined,phase:'draft',resume:true},f.deps);
 assert.equal(result.releaseId,42);assert.equal(f.calls.filter(c=>c.method==='POST'&&!c.url.includes('uploads.github.com')).length,0);assert.equal(f.state.assets.length,3);
});
test('resume confirms already published bytes without a second publication',async t=>{
 const f=fixture(t),original=f.deps.remote.request;
 f.deps.remote.request=async(url,opts)=>{const result=await original(url,opts);return url.endsWith('/releases/42')&&!opts?.method?{...result,draft:false}:result;};
 const result=await release.run({...f.options,phase:'publish',resume:true},f.deps);assert.equal(result.published,true);assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});


test('GitHub test source record round trips and binds package metadata while older local test records remain readable',t=>{
 const f=fixture(t),plan=makePlan({profile:'github-test',version:'3.6.5'},f.policy),source={commit:SHA,clean:true};
 const record={profile:plan.profile,version:plan.version,metadata:plan.metadata,source};
 assert.deepEqual(planForRecord(record,f.policy).source,source);
 assert.deepEqual(builderConfiguration({...plan,source},'inert').extraMetadata.novaBuild,source);
 assert.throws(()=>planForRecord({...record,source:{commit:SHA,clean:false}},f.policy));
 assert.equal(planForRecord({...record,source:undefined},f.policy).source,undefined);
});


test('GitHub transport accepts canonical repository root and refuses lookalike repository', async () => {
 const {github}=require('./release-windows-update.cjs');const root='https://api.github.com/repos/hanjiyou/nova-video-studio';let calls=0;
 const request=github('synthetic-token',async(url)=>{calls++;assert.equal(url,root);return {ok:true,status:200,json:async()=>({full_name:'hanjiyou/nova-video-studio'})};});
 assert.equal((await request(root)).full_name,'hanjiyou/nova-video-studio');
 await assert.rejects(request(root+'-other'),/Non-fixed/);assert.equal(calls,1);
});


test('incomplete upload is diagnosed before hashing or mutating anything', async t => {
 const f=fixture(t); f.state.assets=[{...f.assets[0],state:'starter',size:0}];
 f.deps.remote.hashAsset=async()=>{throw Error('must not download starter');};
 await assert.rejects(release.run({...f.options,phase:'upload'},f.deps),/Incomplete draft asset/);
 assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});
test('one delivery reuses numeric draft ID verification for string publish ID only with unchanged live metadata', async t => {
 const f=fixture(t); serverDigests(f); f.options.verification='full-download';
 f.state.assets=[];const notes=path.join(f.directory,'notes.txt');fs.writeFileSync(notes,'INERT release notes');
 f.deps.verificationCache=new Map(); let hashes=0;
 const original=f.deps.remote.hashAsset; f.deps.remote.hashAsset=async id=>{hashes++;return original(id);};
 const uploaded=await release.run({...f.options,phase:'draft',notesFile:notes},f.deps);
 assert.equal(uploaded.releaseId,42);assert.equal(hashes,3);assert.equal(f.state.published,false);
 const beforePublish=f.calls.length;
 const published=await release.run({...f.options,phase:'publish',releaseId:String(uploaded.releaseId)},f.deps);
 assert.equal(published.published,true);assert.equal(hashes,3);
 assert.ok(f.calls.slice(beforePublish).some(c=>c.method==='GET'&&c.url.endsWith('/releases/42')));
 assert.ok(f.calls.slice(beforePublish).some(c=>c.method==='GET'&&c.url.includes('/assets?')));
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
 f.assets[0].updated_at='2026-10-25T01:00:00Z';
 await release.run(f.options,f.deps); assert.equal(hashes,4);
 f.assets[0].digest=null;
 await release.run(f.options,f.deps); assert.equal(hashes,5);
 f.state.assets[0]={...f.assets[0],state:'starter'};
 await assert.rejects(release.run({...f.options,phase:'publish'},f.deps),/name\/state\/size/);
 assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('cache does not bypass source identity or carry across separate invocations', async t=>{
 const f=fixture(t); serverDigests(f); f.options.verification='full-download';
 let hashes=0;const original=f.deps.remote.hashAsset;f.deps.remote.hashAsset=async id=>{hashes++;return original(id);};
 await release.run(f.options,f.deps);await release.run(f.options,f.deps);assert.equal(hashes,6);
 f.deps.verificationCache=new Map();await release.run(f.options,f.deps);assert.equal(hashes,9);f.state.target=OTHER;
 await assert.rejects(release.run({...f.options,phase:'publish'},f.deps),/target commit/);
 f.state.target=SHA;f.state.tag={object:{type:'commit',sha:OTHER}};
 await assert.rejects(release.run({...f.options,phase:'publish'},f.deps),/Existing tag/);
 assert.equal(hashes,9);assert.equal(f.state.published,false);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});

test('default publication compares all server SHA-256 digests without downloading any asset', async t => {
  const f = fixture(t); serverDigests(f);
  f.deps.remote.hashAsset = async () => { throw Error('No full download expected'); };
  const result = await release.run({ ...f.options, phase: 'publish' }, f.deps);
  assert.equal(result.verificationMode, 'auto'); assert.equal(result.published, true);
  assert.equal(result.remoteVerification.length, 3);
  for (const receipt of result.remoteVerification) {
    assert.equal(receipt.method, 'github-server-sha256');
    assert.equal(receipt.sha256, f.assets.find(asset => String(asset.id) === receipt.assetId).sha256);
    assert.equal(receipt.sha512, undefined, 'Do not claim to have downloaded remote SHA-512');
  }
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('mismatching server digest blocks upload and publication without a download fallback', async t => {
  for (const phase of ['upload', 'publish']) {
    const f = fixture(t); serverDigests(f); f.state.assets = phase === 'upload' ? [f.assets[0]] : [...f.assets];
    f.assets[0].digest = 'sha256:' + 'f'.repeat(64);
    f.deps.remote.hashAsset = async () => { throw Error('Must not hide digest mismatch with fallback'); };
    await assert.rejects(release.run({ ...f.options, phase }, f.deps), /server SHA-256 differs/);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false); assert.equal(f.state.published, false);
  }
});

test('only assets missing a digest fall back to full size and SHA-512 verification', async t => {
  const f = fixture(t); serverDigests(f); delete f.assets[1].digest;
  const downloaded = [], original = f.deps.remote.hashAsset;
  f.deps.remote.hashAsset = async id => { downloaded.push(id); return original(id); };
  const result = await release.run(f.options, f.deps);
  assert.deepEqual(downloaded, [2]);
  assert.deepEqual(result.remoteVerification.map(item => item.method), ['github-server-sha256', 'full-download-sha512', 'github-server-sha256']);
  assert.equal(result.remoteVerification[1].reason, 'server-digest-missing');
  assert.equal(result.published, false);
});

test('null, absent and empty digests all require complete download verification', async t => {
  const f = fixture(t); f.assets[0].digest = null; f.assets[1].digest = ''; delete f.assets[2].digest;
  const original = f.deps.remote.hashAsset; let downloads = 0;
  f.deps.remote.hashAsset = async id => { downloads++; return original(id); };
  const result = await release.run(f.options, f.deps);
  assert.equal(downloads, 3); assert.ok(result.remoteVerification.every(item => item.method === 'full-download-sha512'));
  f.deps.remote.hashAsset = async () => ({ size: 0, sha512: 'wrong' });
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /Remote asset bytes differ/);
  assert.equal(f.state.published, false);
});

test('malformed or unsupported digest metadata is rejected rather than downgraded', async t => {
  for (const digest of ['sha256:short', 'sha256:' + 'g'.repeat(64), 'sha512:' + 'a'.repeat(64), 42, {}, ' sha256:' + 'a'.repeat(64)]) {
    const f = fixture(t); serverDigests(f); f.assets[0].digest = digest;
    f.deps.remote.hashAsset = async () => { throw Error('No fallback for invalid digest'); };
    await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /Invalid or unsupported/);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});

test('explicit full-download verifies actual bytes even when all server digests match', async t => {
  const f = fixture(t); serverDigests(f);
  let downloads = 0; const original = f.deps.remote.hashAsset;
  f.deps.remote.hashAsset = async id => { downloads++; return original(id); };
  const result = await release.run({ ...f.options, verification: 'full-download' }, f.deps);
  assert.equal(downloads, 3); assert.ok(result.remoteVerification.every(item => item.reason === 'explicit-full-download'));
  f.deps.remote.hashAsset = async id => ({ size: f.assets.find(asset => asset.id === id).size, sha512: 'wrong' });
  await assert.rejects(release.run({ ...f.options, phase: 'publish', verification: 'full-download' }, f.deps), /Remote asset bytes differ/);
  assert.equal(f.state.published, false);
});

test('server verification cache cannot satisfy full-download or mask a changed digest', async t => {
  const f = fixture(t); serverDigests(f); f.deps.verificationCache = new Map();
  let downloads = 0; const original = f.deps.remote.hashAsset;
  f.deps.remote.hashAsset = async id => { downloads++; return original(id); };
  await release.run(f.options, f.deps); assert.equal(downloads, 0);
  await release.run({ ...f.options, verification: 'full-download' }, f.deps); assert.equal(downloads, 3);
  const cached = await release.run(f.options, f.deps); assert.ok(cached.remoteVerification.every(item => item.reused));
  f.assets[0].digest = 'sha256:' + 'f'.repeat(64);
  await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /server SHA-256 differs/);
  assert.equal(downloads, 3); assert.equal(f.state.published, false);
});

test('resume of an already published release uses current server metadata without another write or download', async t => {
  const f = fixture(t); serverDigests(f); const original = f.deps.remote.request;
  f.deps.remote.request = async (url, opts) => { const result = await original(url, opts); return url.endsWith('/releases/42') && !opts?.method ? { ...result, draft: false } : result; };
  f.deps.remote.hashAsset = async () => { throw Error('No download needed'); };
  const result = await release.run({ ...f.options, phase: 'publish', resume: true }, f.deps);
  assert.equal(result.published, true); assert.equal(result.remoteVerification.length, 3);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('server digests never bypass asset name, count, state, size or clean-source gates', async t => {
  const changes = [
    f => { f.assets[0].size++; },
    f => { f.assets[0].name = 'unexpected.exe'; },
    f => { f.assets[0].state = 'starter'; },
    f => { f.state.assets = [f.assets[0], f.assets[0], f.assets[2]]; },
    f => { f.state.target = OTHER; },
    f => { f.plan.source.clean = false; }
  ];
  for (const change of changes) {
    const f = fixture(t); serverDigests(f); change(f);
    f.deps.remote.hashAsset = async () => { throw Error('Unexpected download'); };
    await assert.rejects(release.run({ ...f.options, phase: 'publish' }, f.deps), /name\/state\/size|target commit|clean source/);
    assert.equal(f.calls.some(call => call.method !== 'GET'), false);
  }
});

test('verification options reject invalid or repeated modes and dry runs remain offline', async t => {
  assert.equal(release.verificationMode(), 'auto');
  assert.equal(release.args(['--directory', 'inert', '--verification', 'full-download']).verification, 'full-download');
  assert.throws(() => release.args(['--directory', 'inert', '--verification', 'skip']), /verification/);
  assert.throws(() => release.args(['--directory', 'inert', '--verification', 'auto', '--verification', 'full-download']), /repeated/);
  const f = fixture(t);
  const report = await release.run({ ...f.options, execute: false }, f.deps);
  assert.equal(report.verificationMode, 'auto'); assert.match(report.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(release.run({ ...f.options, verification: 'skip' }, f.deps), /verification/);
  assert.equal(f.calls.length, 0);
});
