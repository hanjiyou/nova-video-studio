'use strict';
// Render the actual editor with synthetic props, without starting the app, vault, database or network.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), front = path.join(root, 'frontend'), out = path.join(root, 'docs', 'implementation', 'model-display-visual');
const req = Module.createRequire(path.join(front, 'package.json')), ts = req('typescript');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { return originalResolve.call(this, request.startsWith('@/') ? path.join(front, 'src', request.slice(2)) : request, parent, ...rest); };
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const content = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  module._compile(content, filename);
};
const React = req('react'), { renderToStaticMarkup } = req('react-dom/server');
const { DraftEditor } = require('../src/components/workbench/DraftEditor.tsx');
const { WorkbenchSettings } = require('../src/components/workbench/WorkbenchSettings.tsx');
const policy = require('../../backend/tasks/image-policy.json');
const flare='gpt-image-2.5-flare',sunburst='gpt-image-2.5-sunburst',six='grok-imagine-video-1.5-6s';
const connection={connectionId:'synthetic',connectionVersionId:'synthetic-version',provider:policy.provider,baseUrl:policy.baseUrl,protocol:'openai',displayName:'合成布局连接',hasCredential:true,credentialState:'ready',validationState:'verified',routeSupported:true,route:'cn',routeRevision:1,defaultImageModel:flare,defaultVideoModel:six};
const displaySettings={revision:0,imageModels:[flare,sunburst],videoModels:[six],defaultImageModel:flare,defaultVideoModel:six,pricingGroup:null};
const models={connectionVersionId:connection.connectionVersionId,route:'cn',routeRevision:1,modelsFetchedAt:'2026-10-28T00:00:00Z',displaySettings,pricingGroups:['【生图分组】image2超分','【生图分组】Image2-满参'],models:[{model:flare,categories:['image'],visibility:'visible',submissionEnabled:true},{model:sunburst,categories:['image'],visibility:'visible',submissionEnabled:true},{model:'synthetic-image-model-with-a-very-long-name-for-layout-validation',categories:['image'],visibility:'visible',submissionEnabled:false},{model:six,categories:['video'],visibility:'visible',submissionEnabled:true},{model:'grok-imagine-video-6s',categories:['video'],visibility:'visible',submissionEnabled:false},{model:'grok-imagine-video-1.5-preview',categories:['video'],visibility:'visible',submissionEnabled:false}],capabilities:[flare,sunburst].flatMap(model=>['image.text','image.reference'].map(mode=>({capabilityVersionId:model+mode,model,mode,provider:connection.provider,baseUrl:connection.baseUrl,protocol:'openai',parameters:{sizes:policy.profiles['openai-images-v1'].sizes,qualities:policy.profiles['openai-images-v1'].qualities,encoding:mode==='image.text'?'json':'multipart',referenceCount:mode==='image.text'?0:1,...(mode==='image.reference'?{inputReferenceName:'image'}:{})},evidenceLevel:'unverified',evidenceVersion:policy.evidenceVersion,evidence:{sourceIds:[],applicationVerified:false,submissionPolicy:policy.submissionPolicy,configuredProtocol:'openai-images-v1',submissionEnabled:true}})))};
const css=fs.readFileSync(path.join(front,'src/app/globals.css'),'utf8').split('/* Desktop workbench:')[1];
const illustration='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#554479"/><stop offset="1" stop-color="#1c304b"/></linearGradient></defs><rect width="800" height="600" fill="url(#a)"/><circle cx="570" cy="160" r="68" fill="#c9b6e6" opacity=".5"/><path d="M0 450L220 220 420 440 560 320 800 520V600H0Z" fill="#9f8db0" opacity=".5"/><text x="400" y="550" fill="#e1d4ec" font-size="28" text-anchor="middle">合成参考素材 · 仅用于布局检查</text></svg>').toString('base64');
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chrome)) throw Error('Headless Chrome is unavailable');
fs.mkdirSync(out, { recursive: true });
const noop = () => {};
const report = { scope: 'Actual WorkbenchSettings, ModelDisplaySettings, DraftEditor and global workbench CSS; static SSR with synthetic props; CSP blocks all network; no user data, credentials or generation', checks: [] };
async function main() {
for (const sample of [{name:'settings-wide',kind:'settings',width:1536,height:1050},{name:'settings-narrow',kind:'settings',width:390,height:1700},{name:'hidden-wide',kind:'hidden',width:1280,height:1600},{name:'hidden-narrow',kind:'hidden',width:390,height:1600}]) {
  const noop=()=>{};
  const assets=[{assetId:'synthetic-reference',kind:'image',displayName:'合成参考图.png',mimeType:'image/png',availability:'available',validationState:'verified',previewUrl:illustration}];
  const draft={mode:'image.text',model:flare,prompt:'雨后的城市街道，暖色灯光映在路面，电影感构图。',parameters:{},inputAssets:assets,revision:1,updatedAt:null};
  const catalog=sample.kind==='hidden'?{...models,displaySettings:{...displaySettings,imageModels:[sunburst],defaultImageModel:sunburst}}:models;
  const content=sample.kind==='settings'?renderToStaticMarkup(React.createElement(WorkbenchSettings,{connection,models:catalog,onModels:noop,onSaved:noop,general:React.createElement('p',null,'通用设置'),about:React.createElement('p',null,'关于')})):renderToStaticMarkup(React.createElement(DraftEditor,{draft,connection,models:catalog,saving:false,onChange:noop,onConfigure:noop,onRetry:noop,onReload:noop,onSubmit:noop}));
  const sidebar='<aside class="wb-sidebar"><header class="wb-brand"><span>✦</span><div>影像工作台<small>NOVA STUDIO</small></div></header><nav><button>▧　图片生成</button><button>▤　视频生成</button><button>♧　作品库</button><button aria-current="page">⚙　设置</button></nav><footer class="wb-sidebar-bottom">●　作品保存在本机<small>合成数据 · 布局验收</small></footer></aside>';
  const markup=sample.kind==='settings'?'<div class="wb-shell">'+sidebar+'<main class="wb-main"><div class="wb-settings"><div class="wb-section-heading"><h2>设置</h2></div>'+content+'</div></main></div>':'<main class="wb-main"><header class="wb-page-header"><h1>图片生成</h1></header><div class="wb-workspace-grid">'+content+'<section class="wb-panel wb-preview"><h2>图片预览</h2><img src="'+illustration+'" style="width:100%;margin:auto 0;border-radius:9px"/><p class="wb-help">合成素材，仅用于布局验收</p></section></div></main>';
  const evidenceScript='('+function(){const cards=[...document.querySelectorAll('.wb-model-card')].map(item=>{const r=item.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});document.getElementById('layout-evidence').textContent=JSON.stringify({viewport:innerWidth,noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth,cards,checkboxTargets:[...document.querySelectorAll('.wb-model-check')].every(item=>{const r=item.getBoundingClientRect();return r.width>=32&&r.height>=32;}),duplicateHiddenWarning:!!document.querySelector('.wb-hidden-model')&&!!document.querySelector('.wb-generation-guidance'),hiddenGuidance:!!document.querySelector('.wb-hidden-model'),hiddenPlaceholder:!!document.querySelector('select option[disabled][hidden]'),generateDisabled:!!document.querySelector('.wb-editor-footer button:disabled')});}.toString()+')();';
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; script-src \'unsafe-inline\'"><title>模型显示与隐藏草稿离线布局检查</title><style>body{margin:0;background:#101116}[hidden]:not([hidden="until-found"]){display:none!important}/* Desktop workbench:' + css + '</style><div class="nova-workbench">' + markup + '</div><pre id="layout-evidence" hidden></pre><script>' + evidenceScript + '</script></html>';
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
      if (!metrics || metrics.viewport !== sample.width || !metrics.noHorizontalOverflow || !metrics.checkboxTargets || metrics.duplicateHiddenWarning || sample.kind==='hidden' && (!metrics.hiddenGuidance || !metrics.hiddenPlaceholder || !metrics.generateDisabled) || sample.kind==='settings' && (metrics.cards.length!==2 || sample.width>1150 && Math.abs(metrics.cards[0].top-metrics.cards[1].top)>1 || sample.width<650 && metrics.cards[0].bottom>metrics.cards[1].top)) throw Error('Layout validation failed: ' + JSON.stringify(metrics));
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
