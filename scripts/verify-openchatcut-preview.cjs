'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { hashFile, SHARED_FFMPEG_PATH } = require('./openchatcut-runtime.cjs');
const { verifyBlockmap } = require('./lib/windows-update.cjs');
const { localPreviewPlan } = require('./build-openchatcut-preview.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify(directory) {
  const root = path.resolve(directory);
  const update = fs.existsSync(path.join(root, 'update-plan.json'));
  const verified = update ? await require('./lib/windows-update.cjs').verifyDirectory(root) : null;
  const expectedName = update ? verified.plan.productName : 'Nova Studio Editor Preview';
  const executable = path.join(root, 'win-unpacked', expectedName + '.exe');
  assert.ok(fs.existsSync(executable), 'Packaged executable must exist');
  const summary = update ? { version: verified.plan.version, installer: verified.plan.artifactName, bytes: verified.summary.size, sha256: hashFile(path.join(root, verified.plan.artifactName)) } : JSON.parse(fs.readFileSync(path.join(root, 'build-summary.json'), 'utf8'));
  if (!update) assert.equal(summary.installer, localPreviewPlan(summary.version).installer);
  const installer = path.join(root, summary.installer);
  const sha256 = hashFile(installer);
  assert.equal(sha256, summary.sha256, 'Installer SHA256');
  assert.equal(fs.statSync(installer).size, summary.bytes, 'Installer length');
  if (!update) assert.equal(fs.readFileSync(installer + '.sha256', 'utf8').trim(), sha256 + '  ' + summary.installer);
  const blockmap = verifyBlockmap(installer + '.blockmap', installer, summary.bytes);
  const resources = path.join(root, 'win-unpacked/resources');
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(resources, 'openchatcut/nova-runtime.json'), 'utf8'));
  if (runtimeManifest.sharedFfmpeg) {
    assert.equal(fs.existsSync(path.join(resources, 'openchatcut/node_modules/ffmpeg-static/ffmpeg.exe')), false);
    assert.equal(hashFile(path.join(resources, SHARED_FFMPEG_PATH)), runtimeManifest.sharedFfmpeg.sha256);
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-pkg-'));
  const env = { ...process.env, NODE_ENV: 'production', NOVA_DATA_DIR: path.join(data, 'profile'), NOVA_BACKEND_PORT: '0' };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NOVA_RELEASE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
  const windowsRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
  env.Path = path.join(windowsRoot, 'System32') + path.delimiter + windowsRoot;
  const child = spawn(executable, ['--inspect=127.0.0.1:0', '--disable-gpu'], { cwd: data, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', launchError, exited = false, exitCode, socket;
  child.on('error', error => { launchError = error; });
  child.on('exit', code => { exited = true; exitCode = code; });
  child.stdout.on('data', () => {});
  child.stderr.on('data', bytes => { if (stderr.length < 24000) stderr += bytes.toString(); });
  const report = { scope: 'actual packaged executable, app.asar, isolated temporary profile and real original editor View', gpuDisabled: true, installed: false, paidServiceCalled: false, artifact: { bytes: summary.bytes, sha256, blockmap }, checks: ['installer hash, sidecar, length and complete blockmap verified'] };
  const resultPath = path.join(root, 'packaged-runtime-result.json');
  let requestId = 0;
  const pending = new Map();
  try {
    let inspector;
    const waitUntil = Date.now() + 25000;
    while (Date.now() < waitUntil && !inspector) {
      if (launchError) throw launchError;
      if (exited) throw new Error('Preview process exited before readiness');
      inspector = /ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/.exec(stderr)?.[0];
      if (!inspector) await delay(100);
    }
    assert.ok(inspector, 'Local main-process verification endpoint must be ready');
    socket = new WebSocket(inspector);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.on('message', data => {
      const message = JSON.parse(String(data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) request.reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
      else request.resolve(message.result?.result?.value);
    });
    const evaluate = expression => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Packaged verification evaluation timed out')); }, 65000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    report.identity = await evaluate(`(async()=>{const e=process.mainModule.require('electron');await e.app.whenReady();const until=Date.now()+30000;let w;while(Date.now()<until){w=e.BrowserWindow.getAllWindows()[0];if(w&&!w.webContents.isLoadingMainFrame()){const ready=await w.webContents.executeJavaScript('!!window.novaDesktop');if(ready)break}await new Promise(r=>setTimeout(r,100))}if(!w)throw Error('Nova window unavailable');w.hide();return {packaged:e.app.isPackaged,name:e.app.getName(),archive:e.app.getAppPath().endsWith('app.asar'),title:w.getTitle(),bridge:await w.webContents.executeJavaScript('!!window.novaDesktop')}})()`);
    assert.equal(report.identity.packaged, true);
    assert.equal(report.identity.name, expectedName);
    assert.equal(report.identity.archive, true);
    assert.equal(report.identity.bridge, true);
    report.checks.push('actual packaged application and Nova preload ready under isolated profile');
    const opened = await evaluate(`(async()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];return await w.webContents.executeJavaScript('(async()=>{await window.novaDesktop.setEditorViewport({visible:true,x:202,y:0,width:1200,height:850});return await window.novaDesktop.openEditor()})()')})()`);
    assert.equal(opened.ok, true, opened.code);
    assert.equal(opened.state.phase, 'ready');
    report.checks.push('packaged Nova IPC starts shipped editor service without Git, Node or development sources');
    report.nativeDom = await evaluate(`(async()=>{const e=process.mainModule.require('electron');const w=e.BrowserWindow.getAllWindows()[0];const v=w.contentView.children.find(v=>v.webContents&&v.webContents.getURL().includes('/#/editor/'));if(!v)throw Error('Original editor View missing');return await v.webContents.executeJavaScript('({shell:!!document.querySelector(".cc-editor-shell"),agent:!!document.querySelector(".cc-chat-panel"),library:!!document.querySelector(".cc-library-panel"),preview:!!document.querySelector(".cc-preview-stage"),timeline:!!document.querySelector(".cc-timeline"),tabs:[...document.querySelectorAll(".cc-main-tab")].map(x=>x.textContent),novaBridge:typeof window.novaDesktop,partialNativeBridge:typeof window.openChatCutDesktop})')})()`);
    for (const name of ['shell', 'agent', 'library', 'preview', 'timeline']) assert.equal(report.nativeDom[name], true, name);
    assert.equal(report.nativeDom.tabs.length, 6);
    assert.equal(report.nativeDom.novaBridge, 'undefined');
    assert.equal(report.nativeDom.partialNativeBridge, 'undefined');
    report.checks.push('original six tabs, Agent, library, preview and timeline mounted without Nova authority');
    if (runtimeManifest.sharedFfmpeg) {
      const remotionBinary = path.join(resources, 'openchatcut/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe');
      assert.ok(fs.existsSync(remotionBinary), 'Original Remotion FFmpeg must remain');
      const remotionSha256 = hashFile(remotionBinary);
      assert.notEqual(remotionSha256, runtimeManifest.sharedFfmpeg.sha256, 'Remotion ships a distinct renderer binary');
      report.sharedFfmpeg = { ...runtimeManifest.sharedFfmpeg, duplicateAbsent: true, generalPurposeCopies: 1 };
      report.remotionFfmpeg = { retained: true, sha256: remotionSha256, bytes: fs.statSync(remotionBinary).size };
      report.checks.push('Nova and editor share the audited FFmpeg; the redundant copy is absent and the distinct Remotion binary is retained');
      const mediaScript = `(async()=>{
        const samples=16000, wav=new Uint8Array(44+samples*2), view=new DataView(wav.buffer);
        const text=(offset,value)=>{for(let i=0;i<value.length;i++)wav[offset+i]=value.charCodeAt(i)};
        text(0,'RIFF');view.setUint32(4,36+samples*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples*2,true);
        for(let i=0;i<samples;i++)view.setInt16(44+i*2,Math.round(3000*Math.sin(2*Math.PI*440*i/16000)),true);
        const uploaded=await fetch('/upload?name=ffmpeg-shared-probe.wav',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav,signal:AbortSignal.timeout(30000)});
        if(!uploaded.ok)throw Error('synthetic upload failed: '+uploaded.status);
        const asset=await uploaded.json();
        const response=await fetch('/api/extract-audio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({src:asset.path,force:true}),signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw Error('shared FFmpeg extraction failed: '+response.status);
        const audio=await response.json();
        const result=await fetch(audio.path,{signal:AbortSignal.timeout(30000)});if(!result.ok)throw Error('synthetic result read failed');
        const bytes=new Uint8Array(await result.arrayBuffer());
        return {ok:audio.ok,bytes:bytes.length,cached:audio.cached,format:audio.path.endsWith('.ogg')?'ogg':'mp3'};
      })()`;
      report.syntheticAudio = await evaluate(`(async()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows()[0];const v=w.contentView.children.find(v=>v.webContents&&v.webContents.getURL().includes('/#/editor/'));return await v.webContents.executeJavaScript(${JSON.stringify(mediaScript)})})()`);
      assert.equal(report.syntheticAudio.ok, true);
      assert.equal(report.syntheticAudio.cached, false);
      assert.ok(report.syntheticAudio.bytes > 0);
      report.checks.push('original audio extraction API encodes synthetic audio using the shared binary with developer PATH removed');
    }
    await delay(1500);
    await evaluate("setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true");
    // Node waits for an attached debugger when exiting; disconnect after requesting quit.
    socket.close();
    const closeUntil = Date.now() + 12000;
    while (!exited && Date.now() < closeUntil) await delay(100);
    assert.equal(exited, true, 'Packaged app must shut down cleanly');
    assert.equal(exitCode, 0, 'Packaged app exit code');
    report.exitCode = exitCode;
    report.checks.push('packaged application closes its original editor context');
    report.ok = true;
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, checks: report.checks.length, resultPath }));
  } catch (error) {
    report.ok = false; report.failure = String(error.message).slice(0, 1200);
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    socket?.close();
    if (!exited) child.kill();
  }
}
if (!process.argv[2]) { console.error('Supply the local preview output directory.'); process.exitCode = 1; }
else verify(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
