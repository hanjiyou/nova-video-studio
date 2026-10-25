'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPOSITORY, makePlan, builderConfiguration, assertNewOutput, verifyArtifacts } = require('./lib/windows-update.cjs');

function argumentsFrom(argv) {
  const result = {};
  const values = new Map([['--profile', 'profile'], ['--version', 'version'], ['--test-feed-url', 'testFeedUrl']]);
  for (let i = 0; i < argv.length; i++) {
    const name = values.get(argv[i]);
    if (name) {
      if (result[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing or repeated argument: ' + argv[i]);
      result[name] = argv[++i];
    } else if (argv[i] === '--check-only') result.checkOnly = true;
    else if (argv[i] === '--require-clean-source' && !result.requireCleanSource) result.requireCleanSource = true;
    else if (argv[i] === '--enable-test-runtime' && !result.enableTestRuntime) result.enableTestRuntime = true;
    else throw new Error('Unknown argument: ' + argv[i]);
  }
  return result;
}

function tools() {
  if (process.platform !== 'win32') throw new Error('Windows update builds require Windows.');
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const builder = require.resolve('electron-builder/cli.js');
  for (const file of [npm, builder, path.join(REPOSITORY, 'frontend/node_modules/next/dist/bin/next'), path.join(REPOSITORY, 'node_modules/electron/dist/electron.exe'), path.join(REPOSITORY, 'node_modules/ffmpeg-static/ffmpeg.exe')]) {
    if (!fs.existsSync(file)) throw new Error('Required local build tool missing. Prepare dependencies separately: ' + file);
  }
  return { npm, builder };
}

async function runBuild(options, dependencies = {}) {
  const plan = (dependencies.makePlan || makePlan)(options);
  if (plan.profile === 'release' || options.requireCleanSource) plan.source = (dependencies.source || releaseSource)();
  assertNewOutput(plan);
  const localTools = (dependencies.tools || tools)();
  if (options.checkOnly) {
    console.log(JSON.stringify({ ...plan, checkOnly: true, publication: 'never', note: 'No files created; no version reserved. Test runtime enablement does not approve release signing or publication.' }, null, 2));
    return plan;
  }
  fs.mkdirSync(plan.root, { recursive: true });
  const lock = path.join(plan.root, '.build.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx'); } catch { throw new Error('Another update build holds the lock. If its process crashed, inspect and manually remove only release-updates/.build.lock.'); }
  let attempt;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, version: plan.version, profile: plan.profile }));
    assertNewOutput(plan);
    const parent = path.dirname(plan.output);
    fs.mkdirSync(parent, { recursive: true });
    attempt = fs.mkdtempSync(path.join(parent, `.attempt-${plan.version}-`));
    const log = path.join(attempt, 'build.log');
    fs.writeFileSync(log, 'Source: current workspace, including uncommitted changes. Build only; publish never.\n', { flag: 'wx' });
    const config = path.join(attempt, 'builder-config.json');
    fs.writeFileSync(config, JSON.stringify(builderConfiguration(plan, attempt), null, 2), { flag: 'wx' });
    fs.writeFileSync(path.join(attempt, 'update-plan.json'), JSON.stringify({ profile: plan.profile, version: plan.version, testFeedUrl: options.testFeedUrl || null, metadata: plan.metadata, ...(plan.source ? { source: plan.source } : {}) }, null, 2), { flag: 'wx' });
    const execute = dependencies.execute || ((args, label) => new Promise((resolve, reject) => {
      fs.appendFileSync(log, `\n--- ${label} ---\n`);
      const child = spawn(process.execPath, args, { cwd: REPOSITORY, windowsHide: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { fs.appendFileSync(log, data); process.stdout.write(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}).`)));
    }));
    await execute([localTools.npm, 'run', 'build'], 'Frontend production build');
    if (plan.source && JSON.stringify(releaseSource()) !== JSON.stringify(plan.source)) throw new Error('Release source changed during build.');
    await execute([localTools.builder, '--config', config, '--win', 'nsis', '--x64', '--publish', 'never'], 'Windows NSIS update build');
    const summary = await (dependencies.verifyArtifacts || verifyArtifacts)(attempt, plan);
    fs.writeFileSync(path.join(attempt, 'update-summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
    assertNewOutput(plan);
    if (fs.lstatSync(attempt).isSymbolicLink() || path.dirname(attempt) !== path.dirname(plan.output)) throw new Error('Unsafe attempt/final path; attempt retained.');
    fs.renameSync(attempt, plan.output);
    console.log(`Validated build saved: ${plan.output}\n${plan.signature.mode !== 'authenticode' ? 'Unsigned test only.' : 'Signed build validated.'} No installation or publication performed.`);
    return plan;
  } catch (error) {
    if (attempt) {
      fs.appendFileSync(path.join(attempt, 'build.log'), `\n[FAILED] ${error.message}\n`);
      console.error('Attempt retained: ' + attempt);
    }
    throw error;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

function releaseSource() {
  const git = args => execFileSync('git', ['-c', `safe.directory=${REPOSITORY.replace(/\\/g, '/')}`, ...args], { cwd: REPOSITORY, encoding: 'utf8', windowsHide: true });
  if (git(['status', '--porcelain']).trim()) throw new Error('Release requires a clean committed source workspace, including untracked files.');
  const commit = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Release source commit is invalid.');
  return { commit, clean: true };
}

if (require.main === module) Promise.resolve().then(() => runBuild(argumentsFrom(process.argv.slice(2)))).catch(error => { console.error('[FAILED] ' + error.message); process.exitCode = 1; });
module.exports = { argumentsFrom, runBuild, releaseSource };
