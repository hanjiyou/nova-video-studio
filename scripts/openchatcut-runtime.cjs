'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'openchatcut-runtime.json');
const SHARED_FFMPEG_PATH = 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe';
function readConfiguration() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function resolveInternal(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('invalid runtime configuration');
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error('invalid runtime configuration');
  return file;
}
function sourceRevision(repositoryRoot, sourceRoot) {
  return execFileSync('git', ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`, '-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
}
function parentGitlink(repositoryRoot, sourceDirectory) {
  const line = execFileSync('git', ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`, '-C', repositoryRoot, 'ls-files', '--stage', '--', sourceDirectory], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  return /^160000 ([a-f0-9]{40}) 0\t/.exec(line)?.[1] || null;
}
/** Host-only result. Never forward paths or diagnostics to a renderer. */
function inspectOpenChatCutRuntime(options = {}) {
  const config = options.configuration || readConfiguration();
  const base = { available: false, engineCommit: config.engineCommit };
  try {
    if (options.packaged) {
      if (!options.resourcesPath || !path.isAbsolute(options.resourcesPath)) return { ...base, code: 'EDITOR_RUNTIME_NOT_PACKAGED' };
      const resourcesRoot = path.resolve(options.resourcesPath);
      const sourceRoot = resolveInternal(resourcesRoot, config.packagedDirectory || 'openchatcut');
      const manifestPath = path.join(sourceRoot, 'nova-runtime.json');
      if (!fs.existsSync(manifestPath)) return { ...base, code: 'EDITOR_RUNTIME_NOT_PACKAGED' };
      if (!inside(fs.realpathSync(resourcesRoot), fs.realpathSync(sourceRoot))) return { ...base, code: 'EDITOR_RUNTIME_INVALID' };
      const distDir = resolveInternal(sourceRoot, config.distDirectory);
      const servicePath = resolveInternal(sourceRoot, config.serviceEntry);
      const receiptPath = resolveInternal(sourceRoot, config.buildReceipt);
      const result = { ...base, sourceRoot, distDir, servicePath, workingDirectory: sourceRoot };
      if (Number((options.nodeVersion || process.versions.node).split('.')[0]) !== config.nodeMajor) return { ...result, code: 'EDITOR_NODE_UNSUPPORTED' };
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.engineCommit !== config.engineCommit) return { ...result, code: 'EDITOR_VERSION_MISMATCH' };
      if (manifest.schemaVersion !== 1 || manifest.profile !== 'local-preview') return { ...result, code: 'EDITOR_BUILD_INVALID' };
      for (const file of [manifestPath, servicePath, receiptPath, path.join(distDir, 'index.html'), path.join(sourceRoot, 'package.json'), path.join(sourceRoot, 'package-lock.json')]) {
        if (!fs.existsSync(file)) return { ...result, code: 'EDITOR_BUILD_MISSING' };
        if (!inside(fs.realpathSync(sourceRoot), fs.realpathSync(file))) return { ...result, code: 'EDITOR_RUNTIME_INVALID' };
      }
      for (const name of config.packagedRequiredPackages || config.requiredPackages) {
        const file = path.join(sourceRoot, 'node_modules', name, 'package.json');
        if (!fs.existsSync(file)) return { ...result, code: 'EDITOR_DEPENDENCIES_MISSING' };
        if (!inside(fs.realpathSync(sourceRoot), fs.realpathSync(file))) return { ...result, code: 'EDITOR_RUNTIME_INVALID' };
      }
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (manifest.receiptSha256 !== hashFile(receiptPath) || manifest.packageSha256 !== hashFile(path.join(sourceRoot, 'package.json')) || receipt.schemaVersion !== 1 || receipt.engineCommit !== config.engineCommit || receipt.serviceSha256 !== hashFile(servicePath) || receipt.indexSha256 !== hashFile(path.join(distDir, 'index.html')) || receipt.lockSha256 !== hashFile(path.join(sourceRoot, 'package-lock.json'))) return { ...result, code: 'EDITOR_BUILD_INVALID' };
      if (manifest.sharedFfmpeg !== undefined) {
        const record = manifest.sharedFfmpeg;
        const audit = (options.readMediaAudit || (() => require('../desktop/ffmpeg-runtime.json')))();
        if (!record || record.sha256 !== audit['win32-x64']?.sha256 || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) return { ...result, code: 'EDITOR_BUILD_INVALID' };
        const ffmpegPath = resolveInternal(resourcesRoot, SHARED_FFMPEG_PATH);
        if (!fs.existsSync(ffmpegPath)) return { ...result, code: 'EDITOR_DEPENDENCIES_MISSING' };
        if (!inside(fs.realpathSync(resourcesRoot), fs.realpathSync(ffmpegPath))) return { ...result, code: 'EDITOR_RUNTIME_INVALID' };
        const mediaStat = fs.statSync(ffmpegPath);
        if (!mediaStat.isFile() || mediaStat.size !== record.bytes || hashFile(ffmpegPath) !== record.sha256) return { ...result, code: 'EDITOR_BUILD_INVALID' };
        if (fs.existsSync(path.join(sourceRoot, 'node_modules/ffmpeg-static/ffmpeg.exe'))) return { ...result, code: 'EDITOR_BUILD_INVALID' };
        result.ffmpegPath = ffmpegPath;
      }
      return { ...result, available: true };
    }
    const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..'));
    const sourceRoot = resolveInternal(repositoryRoot, config.sourceDirectory);
    const distDir = resolveInternal(sourceRoot, config.distDirectory);
    const servicePath = resolveInternal(sourceRoot, config.serviceEntry);
    const receiptPath = resolveInternal(sourceRoot, config.buildReceipt);
    const result = { ...base, sourceRoot, distDir, servicePath, workingDirectory: sourceRoot };
    if (Number((options.nodeVersion || process.versions.node).split('.')[0]) !== config.nodeMajor) return { ...result, code: 'EDITOR_NODE_UNSUPPORTED' };
    if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) return { ...result, code: 'EDITOR_SOURCE_MISSING' };
    if (!inside(fs.realpathSync(repositoryRoot), fs.realpathSync(sourceRoot))) return { ...result, code: 'EDITOR_RUNTIME_INVALID' };
    const revision = (options.readRevision || sourceRevision)(repositoryRoot, sourceRoot);
    const gitlink = (options.readGitlink || parentGitlink)(repositoryRoot, config.sourceDirectory);
    if (revision !== config.engineCommit || gitlink !== config.engineCommit) return { ...result, code: 'EDITOR_VERSION_MISMATCH' };
    for (const name of config.requiredPackages) {
      if (!fs.existsSync(path.join(sourceRoot, 'node_modules', name, 'package.json'))) return { ...result, code: 'EDITOR_DEPENDENCIES_MISSING' };
    }
    if (![servicePath, receiptPath, path.join(distDir, 'index.html')].every(file => fs.existsSync(file))) return { ...result, code: 'EDITOR_BUILD_MISSING' };
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.engineCommit !== config.engineCommit || receipt.serviceSha256 !== hashFile(servicePath) || receipt.indexSha256 !== hashFile(path.join(distDir, 'index.html')) || receipt.lockSha256 !== hashFile(path.join(sourceRoot, 'package-lock.json'))) return { ...result, code: 'EDITOR_BUILD_INVALID' };
    return { ...result, available: true };
  } catch { return { ...base, code: 'EDITOR_PRECHECK_FAILED' }; }
}
/** Deliberately exclude inherited provider keys, OAuth locations and NODE_OPTIONS. */
function createOpenChatCutServiceEnvironment({ dataDirectory, profileId, parentEnv = process.env, distDirectory, ffmpegPath } = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) throw new TypeError('absolute dataDirectory required');
  if (distDirectory !== undefined && !path.isAbsolute(distDirectory)) throw new TypeError('absolute distDirectory required');
  if (ffmpegPath !== undefined && (typeof ffmpegPath !== 'string' || !path.isAbsolute(ffmpegPath))) throw new TypeError('absolute ffmpegPath required');
  const profile = profileId || 'cfad6716-906f-42f8-8902-2d7782a4c6d0';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(profile)) throw new TypeError('profileId must be UUIDv4');
  const result = {};
  const permitted = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'number_of_processors', 'processor_architecture']);
  for (const [name, value] of Object.entries(parentEnv)) if (permitted.has(name.toLowerCase()) && typeof value === 'string') result[name] = value;
  const home = path.join(dataDirectory, 'private-home');
  return Object.assign(result, {
    NODE_ENV: 'production', ELECTRON_RUN_AS_NODE: '1',
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCHATCUT_DATA_DIR: path.resolve(dataDirectory), OPENCHATCUT_DEV_PROFILE_ID: profile,
    NOVA_OPENCHATCUT_OFFLINE: '1', ...(distDirectory ? { NOVA_OPENCHATCUT_DIST_DIR: distDirectory } : {}),
    ...(ffmpegPath ? { OPENCHATCUT_FFMPEG: ffmpegPath, FFMPEG_BIN: ffmpegPath } : {}),
  });
}
module.exports = { inspectOpenChatCutRuntime, createOpenChatCutServiceEnvironment, readConfiguration, hashFile, SHARED_FFMPEG_PATH };
if (require.main === module) {
  const state = inspectOpenChatCutRuntime();
  process.stdout.write(JSON.stringify({ available: state.available, code: state.code, engineCommit: state.engineCommit }) + '\n');
  process.exitCode = state.available ? 0 : 1;
}
