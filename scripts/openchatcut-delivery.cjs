'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const SOURCE = 'third_party/openchatcut';
const URL = 'https://github.com/hanjiyou/OpenChatCut.git';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function configuration(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/openchatcut-runtime.json'), 'utf8'));
  if (config.sourceDirectory !== SOURCE || config.repository !== URL || !/^[a-f0-9]{40}$/.test(config.engineCommit)) throw Error('Invalid pinned OpenChatCut source.');
  return config;
}
function childGit(root, args) {
  const source = path.join(root, SOURCE);
  return execFileSync('git', ['-c', 'safe.directory=' + source.replaceAll('\\', '/'), '-C', source, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function moduleUrl(root) {
  return execFileSync('git', ['config', '--file', path.join(root, '.gitmodules'), '--get', 'submodule.' + SOURCE + '.url'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fingerprintSubmodule(root, name) {
  if (name !== SOURCE) throw Error('Only the pinned editor submodule may be reviewed as a directory.');
  const config = configuration(root);
  if (moduleUrl(root) !== URL || childGit(root, ['remote', 'get-url', 'origin']) !== URL) throw Error('OpenChatCut repository differs from the approved fork.');
  const commit = childGit(root, ['rev-parse', 'HEAD']);
  if (commit !== config.engineCommit || childGit(root, ['status', '--porcelain', '--untracked-files=all'])) throw Error('OpenChatCut must be clean and match its pinned commit.');
  return digest(JSON.stringify({ mode: '160000', commit, repository: URL, config: digest(fs.readFileSync(path.join(root, 'config/openchatcut-runtime.json'))), modules: digest(fs.readFileSync(path.join(root, '.gitmodules'))) }));
}
function prepareSource(root, git, command, npmCli) {
  configuration(root);
  if (moduleUrl(root) !== URL) throw Error('OpenChatCut submodule URL is not approved.');
  git(root, ['submodule', 'update', '--init', '--checkout', '--', SOURCE]);
  fingerprintSubmodule(root, SOURCE);
  command(path.join(root, SOURCE), process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  command(root, process.execPath, [path.join(root, 'scripts/build-openchatcut.cjs')]);
}
function preparePackage(root, attempt, builder, dependencies = {}) {
  const { inspectOpenChatCutRuntime, hashFile, readConfiguration } = dependencies.runtime || require('./openchatcut-runtime.cjs');
  const copyRuntime = dependencies.copyRuntime || require('./build-openchatcut-preview.cjs').copyRuntime;
  const checked = inspectOpenChatCutRuntime({ repositoryRoot: root });
  if (!checked.available) throw Error(checked.code);
  const binary = path.join(root, 'node_modules/ffmpeg-static/ffmpeg.exe');
  const sharedFfmpeg = { sha256: hashFile(binary), bytes: fs.statSync(binary).size };
  const audit = JSON.parse(fs.readFileSync(path.join(root, 'desktop/ffmpeg-runtime.json'), 'utf8'));
  if (sharedFfmpeg.sha256 !== audit['win32-x64'].sha256) throw Error('Shared FFmpeg differs from its audit.');
  const runtime = path.join(attempt, 'editor-runtime');
  copyRuntime(checked.sourceRoot, runtime, readConfiguration(), { sharedFfmpeg });
  const yaml = require('js-yaml');
  const base = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  return {
    ...builder,
    files: [...base.files, 'scripts/openchatcut-runtime.cjs', 'config/openchatcut-runtime.json'],
    extraResources: [
      ...(builder.extraResources || base.extraResources),
      { from: runtime, to: 'openchatcut' },
      { from: path.join(runtime, 'node_modules'), to: 'openchatcut/node_modules' },
    ],
  };
}
function verifyPackaged(root, directory) {
  const { inspectOpenChatCutRuntime } = require('./openchatcut-runtime.cjs');
  const checked = inspectOpenChatCutRuntime({ packaged: true, resourcesPath: path.join(directory, 'win-unpacked/resources') });
  if (!checked.available) throw Error(checked.code);
}
module.exports = { fingerprintSubmodule, prepareSource, preparePackage, verifyPackaged };
