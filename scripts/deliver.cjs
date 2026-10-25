'use strict';
// Explicit, review-bound delivery. Default run is a read-only preview.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const REPO = path.resolve(__dirname, '..');
const need = (ok, message) => { if (!ok) throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function git(root, args, env = {}) {
  return execFileSync('git', ['-c', 'safe.directory=' + root.replace(/\\/g, '/'), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env, GIT_LITERAL_PATHSPECS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function command(root, executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
  need(!result.error && result.status === 0, '步骤执行失败，已保留进度。');
}
function prepareElectron(root, execute = command) {
  const installer = path.join(root, 'node_modules/electron/install.js');
  need(fs.existsSync(installer), 'Electron 安装器缺失，请检查锁文件依赖安装。');
  // Electron 43 no longer runs its binary installer through npm lifecycle scripts.
  // Its installer verifies the installed version and uses checked cached/downloaded artifacts.
  execute(root, process.execPath, [installer]);
  need(fs.existsSync(path.join(root, 'node_modules/electron/dist/electron.exe')), 'Electron 运行文件未准备完成。');
}
function localPath(root, name) {
  need(typeof name === 'string' && name && !name.startsWith('-') && !name.includes('\\') && !path.isAbsolute(name) && !name.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f]/.test(name), '文件路径无效：' + name);
  need(!/^(?:\.git|node_modules|release[^/]*|temp)(?:\/|$)/i.test(name) && !/(?:^|\/)(?:node_modules|\.env(?:\..*)?|\.aws|\.next)(?:\/|$)/i.test(name), '不允许交付临时目录、依赖或凭据文件：' + name);
  const file = path.join(root, name);
  let current = root;
  for (const part of name.split('/')) { current = path.join(current, part); if (fs.existsSync(current)) need(!fs.lstatSync(current).isSymbolicLink(), '不支持符号链接：' + name); }
  return file;
}
function fingerprint(root, name) {
  const file = localPath(root, name);
  if (!fs.existsSync(file)) return null;
  need(fs.statSync(file).isFile(), '必须逐个列出文件：' + name);
  return digest(fs.readFileSync(file));
}
function branch(root) { const value = git(root, ['symbolic-ref', '--short', 'HEAD']); need(value && !value.startsWith('-'), '需要普通分支。'); return value; }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file);
}
function recordReview(root, files, reviewer, evidence) {
  need(reviewer?.trim() && evidence?.trim(), '请填写审核人和验证记录。');
  need(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length, '审核文件清单不能为空或重复。');
  const changed = new Set([...git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0'), ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean));
  const entries = files.map(name => { need(changed.has(name), '文件不在当前改动中：' + name); return { name, sha256: fingerprint(root, name) }; });
  return { schemaVersion: 1, id: randomUUID(), root: fs.realpathSync(root), branch: branch(root), base: git(root, ['rev-parse', 'HEAD']), reviewer, evidence, reviewedAt: new Date().toISOString(), files: entries };
}
function validateReview(root, review, checkFiles = true) {
  need(review.schemaVersion === 1 && Array.isArray(review.files) && review.files.length && /^[a-f0-9-]{36}$/.test(review.id) && /^[a-f0-9]{40}$/.test(review.base), '审核记录格式错误。');
  need(fs.realpathSync(root) === review.root && branch(root) === review.branch, '项目或分支与审核记录不同。');
  for (const file of review.files) { localPath(root, file.name); if (checkFiles) need(fingerprint(root, file.name) === file.sha256, '审核后文件已改变，请重新审核：' + file.name); }
}
function stages(mode) { need(['push', 'build', 'publish'].includes(mode), '操作应为 push、build 或 publish。'); return ['commit', 'push', ...(mode !== 'push' ? ['build', 'verify'] : []), ...(mode === 'publish' ? ['release'] : [])]; }
async function sequence(state, mode, operations, save) {
  for (const stage of stages(mode)) {
    if (state.done.includes(stage)) continue;
    state.current = stage; save(state);
    const values = await operations[stage](state);
    Object.assign(state, values || {}); state.done.push(stage); state.current = null; save(state);
  }
  return state;
}
function options(argv) {
  const out = { action: argv[0] || 'menu', mode: 'push', profile: 'github-test' };
  need(['menu', 'review', 'run', 'status'].includes(out.action), '用法：deliver [menu|review|run|status]');
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--execute') { need(!out.execute, '重复参数'); out.execute = true; continue; }
    const key = ({ '--review': 'review', '--files': 'files', '--reviewer': 'reviewer', '--evidence': 'evidence', '--mode': 'mode', '--profile': 'profile', '--version': 'version', '--message': 'message', '--notes-file': 'notesFile' })[argv[i]];
    need(key && argv[i + 1] && !argv[i + 1].startsWith('--'), '未知或缺少参数：' + argv[i]); out[key] = argv[++i];
  }
  return out;
}
function deliveryDirectory(root) { return path.join(git(root, ['rev-parse', '--absolute-git-dir']), 'nova-delivery'); }
function remoteTip(root, ref) {
  const url = git(root, ['remote', 'get-url', '--push', 'origin']);
  need(['https://github.com/hanjiyou/nova-video-studio.git', 'https://github.com/hanjiyou/nova-video-studio', 'git@github.com:hanjiyou/nova-video-studio.git'].includes(url), 'origin 推送地址不是指定的 Nova 仓库。');
  // Query the actual push destination rather than a potentially different fetch URL.
  return git(root, ['ls-remote', url, 'refs/heads/' + ref]).split(/\s/)[0];
}
async function run(root, opts, deps = {}) {
  const tipFor = deps.remoteTip || remoteTip;
  need(opts.review, '请指定 --review 审核记录。');
  const bytes = fs.readFileSync(path.resolve(opts.review)); const review = JSON.parse(bytes);
  validateReview(root, review, false); stages(opts.mode);
  const stateFile = path.join(deliveryDirectory(root), review.id + '.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { schemaVersion: 1, reviewHash: digest(bytes), done: [] };
  need(state.reviewHash === digest(bytes), '审核记录与交付进度不一致。');
  const version = opts.version || state.version, profile = state.profile || opts.profile;
  need(!state.profile || state.profile === opts.profile, '续跑不能更改发布类型。');
  need(!state.version || !opts.version || state.version === opts.version, '续跑不能更改版本。');
  const message = state.message || opts.message;
  need(message?.trim(), '首次交付需要 --message 提交说明。');
  let notes = state.notes;
  if (opts.notesFile) { const supplied = fs.readFileSync(path.resolve(opts.notesFile), 'utf8'); need(!notes || notes === supplied, '续跑不能更改发布说明。'); notes = supplied; }
  if (opts.mode !== 'push') {
    need(['github-test', 'release'].includes(profile) && version, '打包需要发布类型及版本。');
    require('./lib/windows-update.cjs').makePlan({ profile, version });
  }
  if (opts.mode === 'publish') need(notes?.trim(), '发布需要 --notes-file。');
  if (!state.commit && !state.tree) validateReview(root, review);
  const preview = { branch: review.branch, mode: opts.mode, profile, version: version || null, reviewedBy: review.reviewer, evidence: review.evidence, files: review.files.map(f => f.name), completed: state.done, commit: state.commit || null, output: state.output || null };
  console.log(JSON.stringify(preview, null, 2));
  if (!opts.execute) { console.log('仅预览，没有执行提交、联网、打包或发布。'); return preview; }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lock = path.join(deliveryDirectory(root), 'delivery.lock');
  const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, review: review.id }));
    state = { ...state, message, profile, ...(version ? { version } : {}), ...(notes ? { notes } : {}) };
    const save = value => writeJson(stateFile, value); save(state);
    const head = git(root, ['rev-parse', 'HEAD']);
    if (!state.commit && state.tree && head !== review.base) {
      need(git(root, ['rev-parse', 'HEAD^']) === review.base && git(root, ['rev-parse', 'HEAD^{tree}']) === state.tree, '提交结果不明且 HEAD 不匹配，请人工检查。');
      state.commit = head; save(state);
    }
    if (state.commit) need(git(root, ['rev-parse', state.commit + '^{tree}']) === state.tree && git(root, ['rev-parse', state.commit + '^']) === review.base, '已记录提交与审核树不匹配。');
    need(head === (state.commit || review.base), 'HEAD 已变化，请使用新的审核记录。');
    if (!state.commit) {
      validateReview(root, review);
      need(!git(root, ['diff', '--cached', '--name-only']), '暂存区已有内容，请先整理，脚本不会覆盖。');
    }
    const tip = tipFor(root, review.branch);
    need(tip === review.base || tip === state.commit, '远端分支与审核起点不一致，先处理同步或分叉。');
    if (opts.mode !== 'push' && !state.checkout) {
      const tags = git(root, ['ls-remote', '--tags', git(root, ['remote', 'get-url', '--push', 'origin'])]).split('\n').map(line => line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1]).filter(Boolean);
      const { compareVersions } = require('./lib/windows-update.cjs');
      need(tags.every(tag => compareVersions(version, tag) > 0), '新版本必须高于远端现有版本；续跑请使用原审核记录。');
    }
    if (opts.mode === 'publish') need(process.env.NOVA_RELEASE_TOKEN?.trim(), '发布需要在当前进程设置 NOVA_RELEASE_TOKEN。');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const operations = {
      commit: async () => {
        if (!state.commit) {
          validateReview(root, review);
          const index = path.join(deliveryDirectory(root), review.id + '.index');
          const env = { GIT_INDEX_FILE: index };
          git(root, ['read-tree', review.base], env);
          git(root, ['add', '--', ...review.files.map(f => f.name)], env);
          state.tree = git(root, ['write-tree'], env); save(state);
          need(state.tree !== git(root, ['rev-parse', review.base + '^{tree}']), '本轮没有可提交的变更。');
          validateReview(root, review);
          git(root, ['diff', '--cached', '--check'], env);
          git(root, ['commit', '-m', message], env);
          state.commit = git(root, ['rev-parse', 'HEAD']); save(state);
          need(git(root, ['rev-parse', 'HEAD^{tree}']) === state.tree && git(root, ['rev-parse', 'HEAD^']) === review.base, '提交钩子改变了已审核内容，请人工检查。');
        }
        git(root, ['reset', '-q', 'HEAD', '--', ...review.files.map(f => f.name)]);
        return { commit: state.commit };
      },
      push: async () => { git(root, ['push', 'origin', state.commit + ':refs/heads/' + review.branch]); need(tipFor(root, review.branch) === state.commit, '远端未确认提交。'); },
      build: async () => {
        need(fs.existsSync(npmCli), '未找到 Node 配套 npm CLI。');
        if (!state.checkout) { state.checkout = path.join(os.tmpdir(), 'nova-delivery-' + randomUUID()); save(state); }
        if (!fs.existsSync(path.join(state.checkout, '.git'))) git(root, ['clone', '--no-checkout', '--shared', root, state.checkout]);
        git(state.checkout, ['checkout', '--detach', state.commit]);
        need(git(state.checkout, ['rev-parse', 'HEAD']) === state.commit, '构建源码不匹配。');
        const output = path.join(state.checkout, 'release-updates', profile, version);
        if (!fs.existsSync(output)) {
          for (const directory of ['', 'frontend', 'backend']) command(path.join(state.checkout, directory), process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund']);
          prepareElectron(state.checkout);
          command(state.checkout, process.execPath, ['scripts/build-windows-update.cjs', '--profile', profile, '--version', version, '--require-clean-source']);
        }
        return { output };
      },
      verify: async () => {
        command(state.checkout, process.execPath, ['scripts/verify-windows-update.cjs', state.output]);
        const record = JSON.parse(fs.readFileSync(path.join(state.output, 'update-plan.json'), 'utf8'));
        need(record.source?.commit === state.commit && record.source.clean === true && record.profile === profile && record.version === version, '安装包与本轮提交或版本不一致。');
      },
      release: async () => {
        const workflow = fs.readFileSync(path.join(state.checkout, '.github/workflows/desktop-release.yml'), 'utf8');
        need(!/push:|action-gh-release|contents: write/.test(workflow), '当前提交仍包含旧标签自动发布流程，请审核并提交工作流修正。');
        const release = require(path.join(state.checkout, 'scripts/release-windows-update.cjs'));
        const notesFile = path.join(deliveryDirectory(root), review.id + '.notes.txt'); fs.writeFileSync(notesFile, notes);
        const common = { directory: state.output, commit: state.commit, confirmTag: 'v' + version, execute: true, resume: true, notesFile };
        const deps = { onDraft: id => { state.releaseId = String(id); save(state); } };
        const uploaded = await release.run({ ...common, phase: 'draft', ...(state.releaseId ? { releaseId: state.releaseId } : {}) }, deps);
        const result = uploaded.published ? uploaded : await release.run({ ...common, phase: 'publish', releaseId: String(uploaded.releaseId) }, deps);
        return { releaseId: String(result.releaseId), releaseUrl: 'https://github.com/hanjiyou/nova-video-studio/releases/tag/v' + version, published: result.published };
      }
    };
    await sequence(state, opts.mode, operations, save);
    delete state.failedStage; delete state.failedAt; save(state);
    console.log('交付完成：' + state.done.join(' → ')); if (state.output) console.log('安装包目录：' + state.output); if (state.releaseUrl) console.log(state.releaseUrl);
    return state;
  } catch (error) {
    state.failedStage = state.current || 'preflight';
    state.failedAt = new Date().toISOString();
    writeJson(stateFile, state);
    throw error;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function menu(root) {
  const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Nova 统一交付\n1. 仅提交推送\n2. 提交推送并打包\n3. 完整发布\n4. 记录已完成的审核');
    const choice = (await rl.question('请选择：')).trim();
    if (choice === '4') {
      const files = JSON.parse(fs.readFileSync((await rl.question('文件清单 JSON 路径：')).trim(), 'utf8'));
      const reviewer = await rl.question('审核人：'), evidence = await rl.question('已通过的检查及记录位置：');
      console.log(files.join('\n'));
      need((await rl.question('确认这些文件已审核通过？输入 YES：')).trim() === 'YES', '已取消。');
      const record = recordReview(root, files, reviewer, evidence), file = path.join(deliveryDirectory(root), record.id + '.review.json'); writeJson(file, record); console.log('审核记录：' + file); return;
    }
    const mode = ({ '1': 'push', '2': 'build', '3': 'publish' })[choice]; need(mode, '已取消。');
    const opts = { mode, profile: 'github-test', review: (await rl.question('审核记录路径：')).trim(), message: await rl.question('提交说明（续跑可留空）：') };
    if (mode !== 'push') { opts.version = (await rl.question('版本号（续跑可留空）：')).trim(); const type = (await rl.question('发布类型：1 GitHub测试版 / 2 正式签名版 [1]：')).trim(); need(['', '1', '2'].includes(type), '无效类型'); opts.profile = type === '2' ? 'release' : 'github-test'; }
    if (mode === 'publish') opts.notesFile = (await rl.question('发布说明文件路径（续跑可留空）：')).trim();
    await run(root, opts);
    if ((await rl.question('按以上清单执行？输入 YES：')).trim() === 'YES') await run(root, { ...opts, execute: true });
  } finally { rl.close(); }
}
async function main(root, opts) {
  if (opts.action === 'menu') return menu(root);
  if (opts.action === 'review') {
    need(opts.files, '请指定 --files JSON文件清单。');
    const review = recordReview(root, JSON.parse(fs.readFileSync(opts.files, 'utf8')), opts.reviewer, opts.evidence);
    const file = path.join(deliveryDirectory(root), review.id + '.review.json'); writeJson(file, review); console.log(file); return review;
  }
  if (opts.action === 'status') { need(opts.review, '需要 --review'); const review = JSON.parse(fs.readFileSync(opts.review, 'utf8')); validateReview(root, review, false); const file = path.join(deliveryDirectory(root), review.id + '.json'); console.log(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '尚未执行。'); return; }
  return run(root, opts);
}
if (require.main === module) main(REPO, options(process.argv.slice(2))).catch(error => { console.error(error.status !== undefined ? 'Git操作失败，请检查分支、身份与认证。' : error.message); console.error('交付未完成。请查看上方步骤输出及 deliver status；进度和构建目录已保留。不会自动回滚或重复生成版本。'); process.exitCode = 1; });
module.exports = { prepareElectron, recordReview, validateReview, fingerprint, localPath, stages, sequence, options, git, run, main };
