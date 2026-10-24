'use strict';
// Run with the locked Electron binary, never the Nova application entry point.
// This exercises the real NsisUpdater and Electron net executor, but never installs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { app } = require('electron');
// Treat archived build evidence as ordinary bytes; never execute its app.asar.
process.noAsar = true;
const yaml = require('js-yaml');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { verifyDirectory, hashFile, compareVersions } = require('./lib/windows-update.cjs');

const [oldDirectory, newDirectory, outputDirectory] = process.argv.slice(2).map(p => path.resolve(p));
if (!outputDirectory || !oldDirectory || !newDirectory || fs.existsSync(outputDirectory)) throw new Error('Supply old/new build directories and a NEW evidence directory.');
fs.mkdirSync(outputDirectory, { recursive: true });
for (const name of ['electron-user-data', 'electron-session-data', 'electron-crash-dumps']) fs.mkdirSync(path.join(outputDirectory, name));
app.setPath('userData', path.join(outputDirectory, 'electron-user-data'));
app.setPath('sessionData', path.join(outputDirectory, 'electron-session-data'));
app.setPath('crashDumps', path.join(outputDirectory, 'electron-crash-dumps'));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => { console.error('Harness exceeded bounded runtime. No installer was launched.'); app.exit(1); }, 240000);

async function scenario(name, old, target) {
  const root = path.join(outputDirectory, name); fs.mkdirSync(root);
  const requests = [], logs = [], events = [];
  const oldInstaller = path.join(oldDirectory, old.plan.artifactName), installer = path.join(newDirectory, target.plan.artifactName);
  const cacheName = target.plan.updaterCacheDirName, cache = path.join(root, 'cache', cacheName);
  fs.mkdirSync(cache, { recursive: true });
  if (['cached', 'corrupt-cache', 'redirect', 'range-unavailable', 'bad-blockmap'].includes(name)) {
    fs.copyFileSync(oldInstaller, path.join(cache, 'installer.exe'));
    fs.copyFileSync(oldInstaller + '.blockmap', path.join(cache, 'current.blockmap'));
    if (name === 'corrupt-cache') {
      // Every copied block is wrong, so the real final SHA512 forces native fallback.
      const fd = fs.openSync(path.join(cache, 'installer.exe'), 'r+');
      const block = Buffer.alloc(1024 * 1024, 0x5a);
      try { for (let pos = 0; pos < old.summary.size; pos += block.length) fs.writeSync(fd, block, 0, Math.min(block.length, old.summary.size - pos), pos); } finally { fs.closeSync(fd); }
    }
  }
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    const record = { path: route, range: req.headers.range || null, status: null, contentRange: null, bodyBytes: 0, finished: false };
    requests.push(record);
    res.setHeader('Connection', 'close');
    res.on('finish', () => { record.finished = true; });
    res.on('close', () => { record.wireBytes = req.socket.bytesWritten; });
    const end = (status, content) => { record.status = status; const body = Buffer.from(content); record.bodyBytes = body.length; res.writeHead(status, { 'Content-Length': body.length }); res.end(body); };
    if (route === '/latest.yml') {
      if (name === 'offline') { req.socket.destroy(); return; }
      if (name === 'rate-limit') { res.setHeader('Retry-After', '60'); end(429, 'Isolated rate limit fixture'); return; }
      if (name === 'http-timeout') { end(408, 'Isolated server request timeout'); return; }
      if (name === 'malformed-manifest') { end(200, 'files: [invalid: yaml'); return; }
      let manifest = fs.readFileSync(path.join(newDirectory, 'latest.yml'), 'utf8');
      if (name === 'hash-mismatch') { const value = yaml.load(manifest); value.sha512 = value.files[0].sha512 = Buffer.alloc(64, 0x44).toString('base64'); manifest = yaml.dump(value); }
      end(200, manifest); return;
    }
    if (name === 'redirect' && route === '/' + target.plan.artifactName) {
      record.status = 302; res.writeHead(302, { Location: '/redirected/' + target.plan.artifactName, 'Content-Length': 0 }); res.end(); return;
    }
    let file;
    if (route === '/' + target.plan.artifactName || route === '/redirected/' + target.plan.artifactName) file = installer;
    else if (route === '/' + target.plan.artifactName + '.blockmap') file = installer + '.blockmap';
    else if (route === '/' + old.plan.artifactName + '.blockmap') file = oldInstaller + '.blockmap';
    else { end(404, 'Not found'); return; }
    if (name === 'bad-blockmap' && file.endsWith('.blockmap')) { end(200, 'not a gzip blockmap'); return; }
    if (name === 'range-unavailable' && req.headers.range) { end(416, 'Range unavailable'); return; }
    const size = fs.statSync(file).size;
    let start = 0, finish = size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) >= size) { end(416, 'Invalid single range'); return; }
      start = Number(match[1]); finish = Number(match[2]);
      record.contentRange = `bytes ${start}-${finish}/${size}`;
      res.setHeader('Content-Range', record.contentRange);
    }
    record.status = req.headers.range ? 206 : 200;
    res.writeHead(record.status, { 'Content-Length': finish - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
    if (name === 'disconnect' && file === installer) {
      const chunk = Buffer.alloc(Math.min(65536, size)); const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, chunk, 0, chunk.length, 0); } finally { fs.closeSync(fd); }
      record.bodyBytes += chunk.length; res.write(chunk); setTimeout(() => res.destroy(), 30); return;
    }
    const stream = fs.createReadStream(file, { start, end: finish });
    stream.on('data', chunk => { record.bodyBytes += chunk.length; });
    res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = path.join(root, 'app-update.yml');
  fs.writeFileSync(config, yaml.dump({ provider: 'generic', url, channel: 'latest', useMultipleRangeRequest: false, updaterCacheDirName: cacheName }));
  const adapter = { version: old.plan.version, name: 'Nova isolated updater transfer harness', isPackaged: true, appUpdateConfigPath: config, userDataPath: path.join(root, 'user-data'), baseCachePath: path.join(root, 'cache'), whenReady: () => app.whenReady(), onQuit: () => {}, quit: () => { throw new Error('Harness must never quit-and-install.'); } };
  fs.mkdirSync(adapter.userDataPath);
  const updater = new NsisUpdater(undefined, adapter);
  updater.httpExecutor = new ElectronHttpExecutor();
  updater.autoDownload = false; updater.autoInstallOnAppQuit = false; updater.disableWebInstaller = true;
  // These are the real default diff/fallback paths, not _testOnlyOptions.
  updater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => logs.push({ level, message: String(message) })]));
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error']) updater.on(event, value => events.push({ event, code: value?.code || null }));
  let success = false, resultHash = null, errorCode = null, downloaded = [];
  try {
    const checkA = updater.checkForUpdates(), checkB = updater.checkForUpdates();
    assert.equal(checkA, checkB, 'Real updater merges concurrent checks.');
    await checkA;
    const a = updater.downloadUpdate(), b = updater.downloadUpdate();
    const [downloadA, downloadB] = await Promise.all([a, b]);
    assert.deepEqual(downloadA, downloadB, 'Real updater merges concurrent downloads.');
    downloaded = downloadA;
    assert.equal(downloaded.length, 1);
    resultHash = await hashFile(downloaded[0]);
    assert.equal(resultHash, target.summary.sha512, 'Downloaded/reconstructed installer must match real package bytes.');
    assert.equal(fs.statSync(downloaded[0]).size, target.summary.size);
    success = true;
    if (name === 'cached') {
      const before = requests.length;
      const second = new NsisUpdater(undefined, adapter); second.httpExecutor = new ElectronHttpExecutor(); second.autoDownload = false; second.autoInstallOnAppQuit = false; second.disableWebInstaller = true; second.logger = updater.logger;
      await second.checkForUpdates(); await second.downloadUpdate();
      assert.equal(requests.slice(before).filter(r => r.path.endsWith('.exe')).length, 0, 'Restarted updater reuses SHA512-validated pending package.');
    }
  } catch (error) { errorCode = error.code || error.name; logs.push({ level: 'caught', message: error.message }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  const installerRequests = requests.filter(r => r.path.endsWith('.exe'));
  const ranges = installerRequests.filter(r => r.range && r.status === 206);
  const full = installerRequests.filter(r => !r.range && r.status === 200 && r.finished && r.bodyBytes === target.summary.size);
  const fallback = logs.some(l => l.message.includes('fallback to full download'));
  const expectedSuccess = !['offline', 'rate-limit', 'http-timeout', 'malformed-manifest', 'hash-mismatch', 'disconnect'].includes(name);
  assert.equal(success, expectedSuccess, `${name}: ${JSON.stringify(logs.filter(l => l.level === 'caught'))}`);
  if (['cached', 'redirect'].includes(name)) { assert.ok(ranges.length > 0); assert.equal(full.length, 0); assert.equal(fallback, false); }
  if (['no-cache', 'corrupt-cache', 'range-unavailable', 'bad-blockmap'].includes(name)) { assert.equal(fallback, true); assert.equal(full.length, 1); }
  if (!success) { assert.equal(events.some(e => e.event === 'update-downloaded'), false); assert.equal(updater.installerPath, null); }
  assert.ok(requests.filter(r => r.path === '/latest.yml').length <= (name === 'cached' ? 2 : 1), 'No automatic check retry, including concurrent check calls.');
  const result = { name, success, expectedSuccess, errorCode, fullInstallerBytes: target.summary.size, installerBodyBytes: installerRequests.reduce((n, r) => n + r.bodyBytes, 0), allBodyBytes: requests.reduce((n, r) => n + r.bodyBytes, 0), wireBytes: requests.reduce((n, r) => n + (r.wireBytes || 0), 0), range206Count: ranges.length, full200Count: full.length, fallback, expectedSha512: target.summary.sha512, resultSha512: resultHash, requests, events, logs, installerLaunched: false };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ name, success, installerBodyBytes: result.installerBodyBytes, range206Count: ranges.length, full200Count: full.length, fallback }));
  return result;
}
async function main() {
  await app.whenReady();
  assert.equal(require('electron-updater/package.json').version, '6.8.11');
  const old = await verifyDirectory(oldDirectory), target = await verifyDirectory(newDirectory);
  assert.equal(old.plan.profile, 'local-test'); assert.equal(target.plan.profile, 'local-test');
  assert.equal(old.plan.appId, target.plan.appId); assert.ok(compareVersions(target.plan.version, old.plan.version) > 0);
  const results = [];
  for (const name of ['no-cache', 'cached', 'corrupt-cache', 'redirect', 'range-unavailable', 'bad-blockmap', 'offline', 'rate-limit', 'http-timeout', 'malformed-manifest', 'hash-mismatch', 'disconnect']) results.push(await scenario(name, old, target));
  const summary = { schemaVersion: 1, updater: '6.8.11', electron: process.versions.electron, oldVersion: old.plan.version, newVersion: target.plan.version, oldSha512: old.summary.sha512, newSha512: target.summary.sha512, cases: results.map(({ name, success, expectedSuccess, errorCode, fullInstallerBytes, installerBodyBytes, allBodyBytes, wireBytes, range206Count, full200Count, fallback, resultSha512, installerLaunched }) => ({ name, success, expectedSuccess, errorCode, fullInstallerBytes, installerBodyBytes, allBodyBytes, wireBytes, range206Count, full200Count, fallback, resultSha512, installerLaunched })), installation: 'not-attempted', githubDistribution: 'not-tested', productionPolicyBypassed: false, scope: 'Standalone downloader harness; no installed-application policy or installation acceptance is claimed.' };
  fs.writeFileSync(path.join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
}
main().then(() => { clearTimeout(watchdog); app.exit(0); }).catch(error => { clearTimeout(watchdog); fs.writeFileSync(path.join(outputDirectory, 'failure.txt'), error.stack); console.error(error.stack); app.exit(1); });
