'use strict';
// Render the actual editor with synthetic props, without starting the app, vault, database or network.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), front = path.join(root, 'frontend'), out = path.join(root, 'docs', 'implementation', 'video-guidance-visual');
const req = Module.createRequire(path.join(front, 'package.json')), ts = req('typescript');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { return originalResolve.call(this, request.startsWith('@/') ? path.join(front, 'src', request.slice(2)) : request, parent, ...rest); };
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const content = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  module._compile(content, filename);
};
const React = req('react'), { renderToStaticMarkup } = req('react-dom/server');
const { DraftEditor } = require('../frontend/src/components/workbench/DraftEditor.tsx');
const rules = require('../backend/connections/model-rules.json');
const model = 'grok-imagine-video-1.5-6s';
const connection = { connectionId: 'synthetic', connectionVersionId: 'synthetic-version', provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', hasCredential: true, credentialState: 'ready', defaultVideoModel: model };
const models = { connectionVersionId: connection.connectionVersionId, modelsFetchedAt: null, models: [{ model, visibility: 'visible' }], capabilities: ['video.dual_reference'].map(mode => ({ capabilityVersionId: 'synthetic-' + mode, model, mode, provider: rules.provider, baseUrl: rules.baseUrl, protocol: 'openai', parameters: rules.models[model], evidenceVersion: rules.version, evidenceLevel: 'unverified', evidence: { sourceIds: [], applicationVerified: false } })) };
const css = fs.readFileSync(path.join(front, 'src/app/globals.css'), 'utf8').split('/* Desktop workbench:')[1];
if (!css) throw Error('Workbench CSS boundary missing');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) throw Error('Headless Chrome is unavailable');
fs.mkdirSync(out, { recursive: true });
const noop = () => {};
const report = { scope: 'Actual DraftEditor and global workbench CSS; static SSR with synthetic props; CSP blocks all network; no user data, credentials or generation', checks: [] };
async function main() {
for (const sample of [{ name: 'wide', width: 720, height: 1600, seconds: 3, count: 0 }, { name: 'narrow', width: 390, height: 1800, seconds: 6, count: 1 }]) {
  const assets = Array.from({ length: sample.count }, (_, index) => ({ assetId: 'synthetic-' + index, kind: 'image', displayName: 'reference.png', mimeType: 'image/png', availability: 'available', validationState: 'verified', previewUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#43375f"/></svg>').toString('base64') }));
  const draft = { mode: 'video.dual_reference', model, prompt: '', parameters: { seconds: sample.seconds }, inputAssets: assets, revision: 1, updatedAt: null };
  const markup = renderToStaticMarkup(React.createElement(DraftEditor, { draft, connection, models, saving: false, onChange: noop, onConfigure: noop, onRetry: noop, onReload: noop, onSubmit: noop }));
  const evidenceScript = '(' + function () {
    const input = document.querySelector('.wb-duration-row input').getBoundingClientRect();
    const button = document.querySelector('.wb-duration-default').getBoundingClientRect();
    const guidance = document.querySelector('.wb-generation-guidance').getBoundingClientRect();
    const text = getComputedStyle(document.querySelector('.wb-generation-guidance')).color;
    const result = { viewport: innerWidth, inputHeight: input.height, buttonHeight: button.height, rowAligned: Math.abs(input.top - button.top) < 1, noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth, guidanceWithinViewport: guidance.left >= 0 && guidance.right <= innerWidth, guidanceTextColor: text, issues: document.querySelectorAll('.wb-generation-guidance li').length };
    document.getElementById('layout-evidence').textContent = JSON.stringify(result);
  }.toString() + ')();';
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; script-src \'unsafe-inline\'"><title>视频控件隔离布局检查</title><style>body{margin:0;background:#101116}[hidden]:not([hidden="until-found"]){display:none!important}/* Desktop workbench:' + css + '</style><main class="nova-workbench"><div class="wb-main"><header class="wb-page-header"><h1>视频生成</h1></header>' + markup + '</div></main><pre id="layout-evidence" hidden></pre><script>' + evidenceScript + '</script></html>';
  const htmlPath = path.join(out, sample.name + '.html'), imagePath = path.join(out, sample.name + '.png');
  fs.writeFileSync(htmlPath, html);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-video-guidance-chrome-'));
  try {
    const args = ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars', '--remote-debugging-pipe', '--user-data-dir=' + profile];
    const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
    const pending = new Map(); let sequence = 0, buffer = '';
    browser.stdio[4].on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf('\u0000'); if (index < 0) break;
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (!message.id || !pending.has(message.id)) continue;
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\u0000');
    });
    try {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Emulation.setDeviceMetricsOverride', { width: sample.width, height: sample.height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send('Page.enable', {}, sessionId);
      await send('Page.navigate', { url: require('node:url').pathToFileURL(htmlPath).href }, sessionId);
      let metrics;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await send('Runtime.evaluate', { expression: 'document.getElementById("layout-evidence")?.textContent', returnByValue: true }, sessionId);
        if (result.result?.value) { metrics = JSON.parse(result.result.value); break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!metrics || metrics.viewport !== sample.width || metrics.inputHeight !== 44 || metrics.buttonHeight !== 44 || !metrics.rowAligned || !metrics.noHorizontalOverflow || !metrics.guidanceWithinViewport || metrics.issues !== 2) throw Error('Layout validation failed: ' + JSON.stringify(metrics));
      const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true }, sessionId);
      fs.writeFileSync(imagePath, Buffer.from(screenshot.data, 'base64'));
      report.checks.push({ name: sample.name, status: 'passed', screenshot: imagePath, ...metrics });
    } finally {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      await send('Browser.close').catch(() => browser.kill());
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Browser closed')); }
      browser.stdio[3].destroy(); browser.stdio[4].destroy();
    }
  } finally {
    const target = path.resolve(profile), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(tempRoot)) throw Error('Temporary profile cleanup escaped temp root');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
report.status = 'passed';
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
