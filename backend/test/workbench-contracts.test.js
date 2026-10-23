'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..', '..');
const dir = path.join(__dirname, 'fixtures', 'workbench-v1');
const json = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

test('acceptance ledger covers exactly the 61 baseline IDs with owners and separate evidence channels', () => {
  const baseline = fs.readFileSync(path.join(root, 'docs', '视频工作台功能规划-拆解-方案.md'), 'utf8');
  const expected = [...baseline.matchAll(/^\| ((?:G|I|V|L|S|O)\d{2}) \|/gm)].map(match => match[1]);
  assert.equal(expected.length, 61);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'acceptance', 'workbench-61.json'), 'utf8'));
  const markdown = fs.readFileSync(path.join(root, 'docs', 'acceptance', 'workbench-61.md'), 'utf8');
  assert.deepEqual(ledger.entries.map(entry => entry.id), expected);
  assert.equal(new Set(ledger.entries.map(entry => entry.id)).size, 61);
  for (const entry of ledger.entries) {
    assert.ok(entry.implementationTasks.length > 0, entry.id);
    assert.ok(entry.implementationTasks.every(task => /^T(?:0[2-9]|1[0-6])$/.test(task)), entry.id);
    assert.ok(Object.hasOwn(ledger.statusLabels, entry.status), entry.id);
    assert.deepEqual(Object.keys(entry.evidence).sort(), ['desktop', 'offline', 'realService']);
    assert.ok(entry.requirement && entry.acceptanceCriteria, entry.id);
    assert.ok(markdown.includes(`| ${entry.id} |`), entry.id);
  }
});

test('historical fixtures have provenance and synthetic replacements, not private raw media or live URLs', () => {
  const evidence = json('evidence-index.json');
  const sources = new Set(evidence.sources.map(source => source.id));
  for (const source of evidence.sources) assert.match(source.sha256, /^[a-f0-9]{64}$/);
  const fixtures = fs.readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'evidence-index.json');
  for (const name of fixtures) {
    const value = json(name);
    assert.ok(sources.has(value.sourceId), name);
    const text = JSON.stringify(value);
    assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{8,}|newapi\.opensosen\.com|grok2\.yuanai\.uk|C:\\\\Users/);
    for (const match of text.matchAll(/"(?:task_id|id)":"([^"]+)"/g)) assert.match(match[1], /^task_fixture_/);
  }
  assert.equal(evidence.referenceEvidence.single.requestFileCount, 1);
  assert.deepEqual(evidence.referenceEvidence.dual.map(ref => ref.order), [1, 2]);
  assert.deepEqual(evidence.referenceEvidence.dual.map(ref => ref.multipartName), ['input_reference', 'input_reference']);
});

test('observed provider response types/envelopes stay distinct from a successful local asset', () => {
  const created = json('video-created.json').response;
  assert.equal(created.status, 200);
  assert.equal(created.body.status, 'queued');
  assert.equal(created.body.body, undefined); // status/body belongs to the recording harness.
  assert.equal(created.body.task_id, created.body.id);
  assert.equal(json('video-single-created.json').response.status, null); // Not preserved in this source.
  const generating = json('video-generating.json').response.body;
  assert.equal(generating.status, 'in_progress');
  assert.equal(generating.progress, 1);
  assert.equal(generating.seconds, '6');
  const completed = json('video-completed.json').response.body;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.size, '16:9');
  assert.equal(completed.duration, 6);
  assert.equal(completed.localState, undefined);
  assert.equal(completed.localPath, undefined);
  assert.equal(completed.assetId, undefined);
});

test('known rejected formats preserve the original error nesting without broad capability claims', () => {
  const array = json('rejected-input-array.json').response;
  assert.equal(array.status, 400);
  assert.match(array.body.message, /cannot unmarshal array/);
  const images = json('rejected-images.json').response;
  assert.equal(images.status, 400);
  const second = JSON.parse(images.body.message);
  const third = JSON.parse(second.message);
  assert.match(third.error.message, /unknown field "images"/);
});

test('text protocols and unobserved provider guarantees remain explicitly unverified', () => {
  const evidence = json('evidence-index.json');
  const text = evidence.unverified.filter(entry => entry.mode === 'video.text');
  assert.deepEqual(text.map(entry => entry.model).sort(), ['grok-imagine-video-1.5-6s', 'grok-imagine-video-6s']);
  assert.ok(evidence.unverified.some(entry => entry.model === 'gpt-image-2.5-flare' && entry.mode === 'image.reference'));
  assert.ok(evidence.unknownProviderRules.includes('idempotency'));
  assert.ok(evidence.unknownProviderRules.includes('remote cancellation'));
  const verified = evidence.verifiedHistorically;
  assert.equal(verified.length, 1);
  assert.deepEqual(verified[0].modes, ['video.single_reference', 'video.dual_reference']);
  assert.equal(verified[0].seconds, '6');
  assert.equal(verified[0].size, '1280x720');
  assert.ok(evidence.syntheticScenarios.includes('fake MP4 JSON'));
});
