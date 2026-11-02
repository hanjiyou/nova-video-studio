'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectOpenChatCutRuntime } = require('./openchatcut-runtime.cjs');

async function main() {
  if (process.platform !== 'win32') throw new Error('此启动脚本适用于 Windows。');
  if (process.argv.slice(2).some(arg => arg !== '--check-only')) throw new Error('不支持该参数；仅支持 --check-only 检查运行资源。');
  const repository = path.resolve(__dirname, '..');
  const executable = path.join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(executable)) throw new Error('缺少 Electron 运行文件，请先准备工程依赖。');
  if (!fs.existsSync(path.join(repository, 'frontend', 'out', 'index.html'))) throw new Error('工作台页面尚未构建，请先在工程目录运行 npm run build。');
  const runtime = inspectOpenChatCutRuntime({ repositoryRoot: repository });
  if (!runtime.available) throw new Error('剪辑运行资源尚未就绪（' + runtime.code + '）。请先在工程目录运行 npm run editor:check，按提示准备依赖或运行 npm run editor:build。');
  const localData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (!path.isAbsolute(localData)) throw new Error('本机应用资料目录无效。');
  const dataDirectory = path.join(localData, 'NovaStudioPreview');
  if (process.argv.includes('--check-only')) {
    console.log('运行资源检查通过；未启动窗口，未改动测试资料。');
    console.log('测试资料目录：' + dataDirectory);
    return;
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const logPrefix = path.join(dataDirectory, 'launch-' + Date.now());
  const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: dataDirectory, NOVA_BACKEND_PORT: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const stdout = fs.openSync(logPrefix + '.stdout.log', 'wx');
  let stderr;
  try {
    stderr = fs.openSync(logPrefix + '.stderr.log', 'wx');
    const child = spawn(executable, [repository], {
      cwd: repository, env, detached: true, windowsHide: false,
      stdio: ['ignore', stdout, stderr],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    console.log('已发送工作台启动请求；已打开时会切回原窗口。');
    console.log('测试资料目录：' + dataDirectory);
    console.log('启动日志：' + logPrefix + '.stderr.log');
  } finally {
    fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
