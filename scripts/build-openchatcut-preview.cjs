'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { inspectOpenChatCutRuntime, readConfiguration, hashFile, SHARED_FFMPEG_PATH } = require('./openchatcut-runtime.cjs');
const REPOSITORY = path.resolve(__dirname, '..');
const IDENTITY = { appId: 'com.novaimage.studio.editor-preview', productName: 'Nova Studio Editor Preview', name: 'nova-studio-editor-preview' };

function localPreviewPlan(version = '3.6.11-local.1', repository = REPOSITORY) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-local\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match.slice(1).some(part => Number(part) > 65535)) throw new Error('本地预览版本格式为 3.6.11-local.2，各数字不得超过 65535。');
  const output = path.join(repository, 'release-local-editor', version);
  const installer = `Nova-Studio-Editor-Preview-${version}-x64.exe`;
  return { profile: 'local-preview', version, windowsVersion: match.slice(1).join('.'), ...IDENTITY, output, installer, publication: 'never', source: 'current workspace, including uncommitted changes' };
}

function argumentsFrom(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check-only' && !result.checkOnly) result.checkOnly = true;
    else if (argv[i] === '--version' && result.version === undefined && argv[i + 1]) result.version = argv[++i];
    else throw new Error('未知或重复参数：' + argv[i]);
  }
  localPreviewPlan(result.version);
  return result;
}

function copyRuntime(sourceRoot, destination, config, { sharedFfmpeg } = {}) {
  if (fs.existsSync(destination)) throw new Error('Preview runtime destination already exists.');
  if (sharedFfmpeg) {
    const binary = path.join(sourceRoot, 'node_modules/ffmpeg-static/ffmpeg.exe');
    if (hashFile(binary) !== sharedFfmpeg.sha256 || fs.statSync(binary).size !== sharedFfmpeg.bytes) throw new Error('Editor and shared FFmpeg must be identical before deduplication.');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'), 'utf8'));
  fs.mkdirSync(destination, { recursive: true });
  const copy = (relative, filter) => fs.cpSync(path.join(sourceRoot, relative), path.join(destination, relative), { recursive: true, dereference: false, errorOnExist: true, force: false, ...(filter ? { filter } : {}) });
  for (const relative of ['package.json', 'package-lock.json', 'LICENSE', config.serviceEntry, config.buildReceipt]) copy(relative);
  const distRoot = path.join(sourceRoot, config.distDirectory);
  const uploadRoot = path.join(distRoot, 'media', 'uploads');
  copy(config.distDirectory, file => file !== uploadRoot && !file.startsWith(uploadRoot + path.sep));
  const packages = Object.entries(lock.packages).filter(([name, record]) => /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(name) && !record.dev && fs.existsSync(path.join(sourceRoot, name)));
  for (const [relative] of packages) {
    copy(relative, file => {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlinks are not permitted in the preview runtime.');
      const key = path.relative(sourceRoot, file).replaceAll('\\', '/');
      if (sharedFfmpeg && key === 'node_modules/ffmpeg-static/ffmpeg.exe') return false;
      // The upstream package contains binaries for several operating systems.
      const native = /^node_modules\/onnxruntime-node\/bin\/napi-v6\/([^/]+)(?:\/([^/]+))?/.exec(key);
      return !native || (native[1] === 'win32' && (!native[2] || native[2] === 'x64'));
    });
  }
  for (const name of config.packagedRequiredPackages) if (!fs.existsSync(path.join(destination, 'node_modules', name, 'package.json'))) throw new Error('Missing runtime dependency: ' + name);
  const record = {
    schemaVersion: 1, profile: 'local-preview', engineCommit: config.engineCommit,
    receiptSha256: hashFile(path.join(destination, config.buildReceipt)),
    packageSha256: hashFile(path.join(destination, 'package.json')),
    productionPackages: packages.length, nativeModelSync: false,
    ...(sharedFfmpeg ? { sharedFfmpeg } : {}),
  };
  fs.writeFileSync(path.join(destination, 'nova-runtime.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}

function builderConfiguration(repository, attempt, runtime, version) {
  const builderRequire = createRequire(require.resolve('app-builder-lib'));
  const base = builderRequire('js-yaml').load(fs.readFileSync(path.join(repository, 'electron-builder.yml'), 'utf8'));
  return {
    extends: path.join(repository, 'electron-builder.yml'), appId: IDENTITY.appId, productName: IDENTITY.productName,
    buildVersion: localPreviewPlan(version, repository).windowsVersion,
    electronDist: path.join(repository, 'node_modules/electron/dist'),
    extraMetadata: { name: IDENTITY.name, productName: IDENTITY.productName, version, novaLocalPreview: { schemaVersion: 1, engineCommit: readConfiguration().engineCommit, publication: 'never' } },
    directories: { output: attempt },
    files: [...base.files, 'scripts/openchatcut-runtime.cjs', 'config/openchatcut-runtime.json'],
    extraResources: [
      ...base.extraResources.filter(entry => !['docs/本地离线测试版使用说明.md', 'desktop/installer/LOCAL-TEST-NOTICE.txt'].includes(entry.from)),
      { from: runtime, to: 'openchatcut' },
      // electron-builder excludes a FileMatcher's root node_modules even for
      // extraResources. A dedicated mapping makes these production packages explicit.
      { from: path.join(runtime, 'node_modules'), to: 'openchatcut/node_modules' },
      { from: path.join(repository, 'docs/本地剪辑预览包使用说明.md'), to: '本地剪辑预览包使用说明.md' },
    ],
    forceCodeSigning: false, publish: null,
    win: { target: ['nsis'], artifactName: `Nova-Studio-Editor-Preview-${version}-x64.exe`, signAndEditExecutable: true, signExecutable: false, verifyUpdateCodeSignature: false },
    nsis: { ...base.nsis, license: null, createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: false, uninstallDisplayName: `${IDENTITY.productName} ${version}` },
  };
}

async function main(options = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This local preview requires Windows x64.');
  const plan = localPreviewPlan(options.version);
  const { version, output } = plan;
  const root = path.join(REPOSITORY, 'release-local-editor');
  if (options.checkOnly) {
    const runtime = inspectOpenChatCutRuntime({ repositoryRoot: REPOSITORY });
    console.log(JSON.stringify({ ...plan, outputExists: fs.existsSync(output), currentEditorRuntime: { available: runtime.available, code: runtime.code }, checkOnly: true, note: 'No files written, no build, commit, push or publication.' }, null, 2));
    return plan;
  }
  if (fs.existsSync(output)) throw new Error('Preview output already exists; it will not be overwritten.');
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, '.build.lock');
  const lock = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const attempt = fs.mkdtempSync(path.join(root, '.attempt-'));
  const log = path.join(attempt, 'build.log');
  const run = (args, label) => new Promise((resolve, reject) => {
    fs.appendFileSync(log, '\n--- ' + label + ' ---\n');
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN', 'NOVA_RELEASE_TOKEN']) delete env[name];
    const child = spawn(process.execPath, args, { cwd: REPOSITORY, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { fs.appendFileSync(log, data); process.stdout.write(data); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(label + ' failed: ' + code)));
  });
  try {
    fs.writeFileSync(log, 'Local preview of current workspace including uncommitted changes. No commit, push, installation or publication.\n');
    await run([path.join(REPOSITORY, 'scripts/build-openchatcut.cjs')], 'Original editor build');
    const config = readConfiguration();
    const source = inspectOpenChatCutRuntime({ repositoryRoot: REPOSITORY });
    if (!source.available) throw new Error(source.code);
    const runtime = path.join(attempt, 'editor-runtime');
    const sharedBinary = path.join(REPOSITORY, 'node_modules/ffmpeg-static/ffmpeg.exe');
    const sharedFfmpeg = { sha256: hashFile(sharedBinary), bytes: fs.statSync(sharedBinary).size };
    if (sharedFfmpeg.sha256 !== require('../desktop/ffmpeg-runtime.json')['win32-x64'].sha256) throw new Error('Shared FFmpeg differs from the audited binary.');
    const runtimeReceipt = copyRuntime(source.sourceRoot, runtime, config, { sharedFfmpeg });
    // Mirror the packaged layout for the staging preflight. This hard link is
    // build-only; the installer receives the existing Nova copy from asarUnpack.
    const stagedShared = path.join(attempt, SHARED_FFMPEG_PATH);
    fs.mkdirSync(path.dirname(stagedShared), { recursive: true });
    try { fs.linkSync(sharedBinary, stagedShared); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
      fs.copyFileSync(sharedBinary, stagedShared, fs.constants.COPYFILE_EXCL);
    }
    const checked = inspectOpenChatCutRuntime({ packaged: true, resourcesPath: attempt, configuration: { ...config, packagedDirectory: 'editor-runtime' } });
    if (!checked.available) throw new Error(checked.code);
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    await run([npmCli, 'run', 'build'], 'Nova frontend build');
    const builderConfig = path.join(attempt, 'builder-config.json');
    fs.writeFileSync(builderConfig, JSON.stringify(builderConfiguration(REPOSITORY, attempt, runtime, version), null, 2));
    await run([require.resolve('electron-builder/cli.js'), '--config', builderConfig, '--win', 'nsis', '--x64', '--publish', 'never'], 'Local unsigned preview package');
    const installer = `Nova-Studio-Editor-Preview-${version}-x64.exe`;
    const installerPath = path.join(attempt, installer);
    if (!fs.statSync(installerPath).size) throw new Error('Installer missing.');
    const packaged = inspectOpenChatCutRuntime({ packaged: true, resourcesPath: path.join(attempt, 'win-unpacked/resources') });
    if (!packaged.available) throw new Error(packaged.code);
    const sha256 = hashFile(installerPath);
    fs.writeFileSync(installerPath + '.sha256', `${sha256}  ${installer}\n`);
    fs.writeFileSync(path.join(attempt, 'build-summary.json'), JSON.stringify({ version, ...IDENTITY, installer, bytes: fs.statSync(installerPath).size, sha256, publication: 'never', source: 'current workspace, uncommitted', runtimeReceipt, realMediaRenderValidated: false }, null, 2));
    if (fs.existsSync(output)) throw new Error('Final output became occupied.');
    fs.renameSync(attempt, output);
    console.log(JSON.stringify({ ok: true, installer: path.join(output, installer), executable: path.join(output, 'win-unpacked', IDENTITY.productName + '.exe'), sha256 }));
  } catch (error) {
    fs.appendFileSync(log, '\nFAILED: ' + error.message + '\n');
    console.error('Attempt retained: ' + attempt);
    throw error;
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}

module.exports = { copyRuntime, builderConfiguration, IDENTITY, localPreviewPlan, argumentsFrom };
if (require.main === module) Promise.resolve().then(() => main(argumentsFrom(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
