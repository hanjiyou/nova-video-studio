'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyRuntime, builderConfiguration, IDENTITY } = require('./build-openchatcut-preview.cjs');
const { hashFile } = require('./openchatcut-runtime.cjs');

test('preview staging includes production runtime but excludes developer settings, uploaded media and other-platform binaries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-preview-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'runtime');
  const write = (relative, value) => { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const config = { engineCommit: 'a'.repeat(40), distDirectory: 'dist', serviceEntry: 'desktop-dist/service.mjs', buildReceipt: 'desktop-dist/build.json', packagedRequiredPackages: ['react'] };
  for (const file of ['LICENSE', 'package.json', config.serviceEntry, config.buildReceipt, 'dist/index.html', 'dist/assets/app.js', 'node_modules/react/package.json', 'node_modules/dev-only/package.json', 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/binary.so', 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/binary.dll', 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/binary.dll', 'settings.env', '.env.local', 'dist/media/uploads/private.mp4']) write(file, 'fixture');
  write('package-lock.json', JSON.stringify({ packages: { 'node_modules/react': {}, 'node_modules/dev-only': { dev: true }, 'node_modules/onnxruntime-node': {} } }));
  const receipt = copyRuntime(source, destination, config);
  for (const relative of ['dist/index.html', 'node_modules/react/package.json', 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/binary.dll']) assert.equal(fs.existsSync(path.join(destination, relative)), true, relative);
  for (const relative of ['settings.env', '.env.local', 'dist/media/uploads/private.mp4', 'node_modules/dev-only', 'node_modules/onnxruntime-node/bin/napi-v6/linux', 'node_modules/onnxruntime-node/bin/napi-v6/win32/arm64']) assert.equal(fs.existsSync(path.join(destination, relative)), false, relative);
  assert.equal(receipt.receiptSha256, hashFile(path.join(destination, config.buildReceipt)));
  assert.equal(receipt.productionPackages, 2);
  assert.throws(() => copyRuntime(source, destination, config), /already exists/);
});

test('local preview configuration has isolated identity and no updater or publication capability', () => {
  const root = path.resolve(__dirname, '..');
  const config = builderConfiguration(root, path.join(root, 'release-fixture'), path.join(root, 'release-fixture/runtime'), '3.6.11-local.1');
  assert.equal(config.appId, IDENTITY.appId);
  assert.equal(config.extraMetadata.name, IDENTITY.name);
  assert.equal(config.extraMetadata.productName, IDENTITY.productName);
  assert.equal(config.publish, null);
  assert.equal(config.extraMetadata.novaUpdate, undefined);
  assert.equal(config.extraMetadata.novaBuild, undefined);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.ok(config.files.includes('scripts/openchatcut-runtime.cjs'));
  assert.ok(config.files.includes('config/openchatcut-runtime.json'));
  assert.ok(config.extraResources.some(resource => resource.to === 'openchatcut'));
});

test('actual builder resource copier preserves the isolated runtime node_modules', async t => {
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-preview-builder-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const runtime = path.join(temporary, 'runtime'), resources = path.join(temporary, 'resources');
  fs.mkdirSync(path.join(runtime, 'node_modules', 'react'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node_modules/react/package.json'), '{}');
  fs.writeFileSync(path.join(runtime, 'nova-runtime.json'), '{}');
  const config = builderConfiguration(path.resolve(__dirname, '..'), path.join(temporary, 'output'), runtime, '3.6.11-local.1');
  const entries = config.extraResources.filter(entry => entry.from === runtime || entry.from === path.join(runtime, 'node_modules'));
  await copyFiles(entries.map(entry => new FileMatcher(entry.from, path.join(resources, entry.to), value => value, entry.filter)), undefined, false);
  assert.ok(fs.existsSync(path.join(resources, 'openchatcut/node_modules/react/package.json')));
  assert.ok(fs.existsSync(path.join(resources, 'openchatcut/nova-runtime.json')));
});

test('local preview versions map safely to Windows versions and reject release or path inputs', () => {
  const { localPreviewPlan, argumentsFrom } = require('./build-openchatcut-preview.cjs');
  assert.equal(localPreviewPlan('3.6.11-local.2').windowsVersion, '3.6.11.2');
  for (const version of ['3.6.11', '../3.6.11-local.2', '3.6.11-local.02', '65536.0.0-local.1']) assert.throws(() => localPreviewPlan(version));
  assert.equal(argumentsFrom(['--version', '3.6.11-local.2', '--check-only']).checkOnly, true);
  assert.throws(() => argumentsFrom(['--publish']));
});

test('FFmpeg dedup removes only identical executable bytes and retains package loader and notices', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-preview-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const config = { engineCommit: 'a'.repeat(40), distDirectory: 'dist', serviceEntry: 'desktop-dist/service.mjs', buildReceipt: 'desktop-dist/build.json', packagedRequiredPackages: ['ffmpeg-static'] };
  for (const relative of ['LICENSE', 'package.json', config.serviceEntry, config.buildReceipt, 'dist/index.html', 'node_modules/ffmpeg-static/package.json', 'node_modules/ffmpeg-static/index.js', 'node_modules/ffmpeg-static/ffmpeg.exe', 'node_modules/ffmpeg-static/ffmpeg.exe.LICENSE', 'node_modules/ffmpeg-static/ffmpeg.exe.README']) {
    const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/ffmpeg-static': {} } }));
  const binary = path.join(source, 'node_modules/ffmpeg-static/ffmpeg.exe');
  const sharedFfmpeg = { sha256: hashFile(binary), bytes: fs.statSync(binary).size };
  const destination = path.join(root, 'runtime');
  const result = copyRuntime(source, destination, config, { sharedFfmpeg });
  assert.equal(fs.existsSync(path.join(destination, 'node_modules/ffmpeg-static/ffmpeg.exe')), false);
  for (const name of ['package.json', 'index.js', 'ffmpeg.exe.LICENSE', 'ffmpeg.exe.README']) assert.ok(fs.existsSync(path.join(destination, 'node_modules/ffmpeg-static', name)), name);
  assert.deepEqual(result.sharedFfmpeg, sharedFfmpeg);
  fs.writeFileSync(binary, 'different-binary');
  assert.throws(() => copyRuntime(source, path.join(root, 'mismatched'), config, { sharedFfmpeg }), /must be identical/);
  assert.equal(fs.existsSync(path.join(root, 'mismatched')), false);
});
