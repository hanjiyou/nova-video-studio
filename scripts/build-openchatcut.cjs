'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync, execFileSync } = require('node:child_process');
const { readConfiguration, createOpenChatCutServiceEnvironment, hashFile } = require('./openchatcut-runtime.cjs');
const repositoryRoot = path.resolve(__dirname, '..');
const config = readConfiguration();
const sourceRoot = path.resolve(repositoryRoot, config.sourceDirectory);
async function main() {
  if (Number(process.versions.node.split('.')[0]) !== config.nodeMajor) throw new Error('EDITOR_NODE_UNSUPPORTED');
  const commit = execFileSync('git', ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`, '-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (commit !== config.engineCommit) throw new Error('EDITOR_VERSION_MISMATCH');
  const sourceMediaPackage = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'node_modules', 'ffmpeg-static', 'package.json'), 'utf8'));
  const rootMediaPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'node_modules', 'ffmpeg-static', 'package.json'), 'utf8'));
  // Reuse only the exact same audited ffmpeg-static binary for this dev probe.
  const mediaName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const mediaTarget = path.join(sourceRoot, 'node_modules', 'ffmpeg-static', mediaName);
  if (!fs.existsSync(mediaTarget) && sourceMediaPackage.version === rootMediaPackage.version) {
    const audited = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'desktop', 'ffmpeg-runtime.json'), 'utf8'));
    const source = path.join(repositoryRoot, 'node_modules', 'ffmpeg-static', mediaName);
    const expected = audited[`${process.platform}-${process.arch}`]?.sha256;
    if (expected && fs.existsSync(source) && hashFile(source) === expected) fs.copyFileSync(source, mediaTarget, fs.constants.COPYFILE_EXCL);
  }
  if (!fs.existsSync(mediaTarget)) throw new Error('EDITOR_MEDIA_RUNTIME_MISSING');
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-occ-build-'));
  fs.writeFileSync(path.join(buildRoot, 'settings.env'), '');
  const distDir = path.join(sourceRoot, config.distDirectory);
  const env = createOpenChatCutServiceEnvironment({ dataDirectory: buildRoot, distDirectory: distDir });
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: sourceRoot, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0 || result.error) throw new Error('EDITOR_BUILD_FAILED');
  };
  if (!process.argv.includes('--service-only')) {
    run([path.join(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-b']);
    run([path.join(sourceRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'config/vite.config.ts']);
  }
  const { build } = await import(pathToFileURL(path.join(sourceRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  const servicePath = path.join(sourceRoot, config.serviceEntry);
  await build({
    entryPoints: [path.join(__dirname, 'openchatcut-service.mjs')], outfile: servicePath, bundle: true,
    platform: 'node', format: 'esm', packages: 'external', sourcemap: true,
    banner: { js: "import { createRequire as __novaCreateRequire } from 'node:module'; const require = __novaCreateRequire(import.meta.url);" },
    plugins: [{ name: 'native-raw-assets', setup(b) { b.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' })); } }],
  });
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('EDITOR_FRONTEND_BUILD_MISSING');
  const receipt = { schemaVersion: 1, engineCommit: config.engineCommit, lockSha256: hashFile(path.join(sourceRoot, 'package-lock.json')), serviceSha256: hashFile(servicePath), indexSha256: hashFile(indexPath), nativeModelSync: false };
  fs.writeFileSync(path.join(sourceRoot, config.buildReceipt), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ built: true, engineCommit: config.engineCommit, nativeModelSync: false }) + '\n');
}
main().catch(error => { process.stderr.write((/^EDITOR_[A-Z_]+$/.test(error.message) ? error.message : 'EDITOR_BUILD_FAILED') + '\n'); process.exitCode = 1; });
