'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BASELINE_FILE = 'installer-state.json';
const FILES = Object.freeze({ installer: 'installer.exe', baseline: BASELINE_FILE, blockmap: 'current.blockmap' });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const ordinary = s => s.isFile() && !s.isSymbolicLink();
const outcome = reason => ({ trusted: false, reason });
async function inspect(options) {
  const { cacheDirectory, appId, version } = options || {};
  if (typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory) || !/^[a-zA-Z0-9.-]+$/.test(appId || '') || !/^\d+\.\d+\.\d+$/.test(version || '') || path.basename(cacheDirectory) !== appId + '-updater') return outcome('cache_invalid');
  let root;
  try { root = await fs.promises.lstat(cacheDirectory); }
  catch (error) { return outcome(error.code === 'ENOENT' ? 'cache_missing' : 'cache_invalid'); }
  if (!root.isDirectory() || root.isSymbolicLink()) return outcome('cache_invalid');
  const marker = path.join(cacheDirectory, FILES.baseline), installer = path.join(cacheDirectory, FILES.installer);
  let markerStat, record;
  try {
    markerStat = await fs.promises.lstat(marker);
    if (!ordinary(markerStat) || markerStat.size > 4096) return outcome('baseline_invalid');
    const handle = await fs.promises.open(marker, 'r');
    try {
      if (!same(markerStat, await handle.stat())) return outcome('cache_changed');
      record = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { return outcome(error.code === 'ENOENT' ? 'baseline_missing' : 'baseline_invalid'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join('|') !== 'appId|schemaVersion|sha512|version' || record.schemaVersion !== 1 || typeof record.sha512 !== 'string' || !/^[a-fA-F0-9]{128}$/.test(record.sha512)) return outcome('baseline_invalid');
  if (record.appId !== appId) return outcome('identity_mismatch');
  if (record.version !== version) return outcome('version_mismatch');
  let stat, handle, digest;
  try {
    stat = await fs.promises.lstat(installer);
    if (!ordinary(stat) || stat.size === 0) return outcome('installer_unreadable');
    handle = await fs.promises.open(installer, 'r');
    if (!same(stat, await handle.stat())) return outcome('cache_changed');
    const hash = createHash('sha512');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    digest = hash.digest('hex');
    if (!same(stat, await handle.stat()) || !same(stat, await fs.promises.lstat(installer)) || !same(markerStat, await fs.promises.lstat(marker))) return outcome('cache_changed');
    const after = await fs.promises.lstat(cacheDirectory);
    if (!after.isDirectory() || after.isSymbolicLink() || root.dev !== after.dev || root.ino !== after.ino) return outcome('cache_changed');
  } catch (error) { return outcome(error.code === 'ENOENT' ? 'installer_missing' : 'installer_unreadable'); }
  finally { if (handle) await handle.close(); }
  return digest === record.sha512.toLowerCase() ? { trusted: true, reason: null, root } : outcome('installer_corrupt');
}
async function validateInstallerCache(options) {
  const { trusted, reason } = await inspect(options);
  return { trusted, reason };
}
async function prepareInstallerCache(options) {
  const result = await inspect(options);
  if (!result.trusted) return result;
  // Updater 6.8.11 promotes a target's map before installation. Fetch the map
  // matching app.version afresh; pending downloads/other channels are untouched.
  try {
    const map = path.join(options.cacheDirectory, FILES.blockmap);
    let stat;
    try { stat = await fs.promises.lstat(map); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (!ordinary(stat)) return outcome('map_unusable');
      const root = await fs.promises.lstat(options.cacheDirectory);
      if (!root.isDirectory() || root.isSymbolicLink() || result.root.dev !== root.dev || result.root.ino !== root.ino) return outcome('cache_changed');
      try { await fs.promises.unlink(map); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const root = await fs.promises.lstat(options.cacheDirectory);
    if (!root.isDirectory() || root.isSymbolicLink() || result.root.dev !== root.dev || result.root.ino !== root.ino) return outcome('cache_changed');
    return { trusted: true, reason: null };
  } catch { return outcome('map_unusable'); }
}
module.exports = { BASELINE_FILE, FILES, validateInstallerCache, prepareInstallerCache };