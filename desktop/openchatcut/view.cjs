'use strict';
const { partitionName, viewportBounds, createEditorSessionPolicy } = require('./policy.cjs');
const {classifyText,errorFields}=require('./diagnostic-fields.cjs');
const {EDITOR_READINESS_TIMEOUT_MS}=require('../../backend/storage/editor-settings');

const EDITOR_READY_SCRIPT = "Boolean(document.querySelector('.cc-editor-shell') && document.querySelector('.cc-library-panel') && document.querySelector('.cc-timeline'))";

function createEditorView({ electron, getWindow, dataDirectory, onFailure, onDiagnostic=()=>{}, sidebarCss = 202,
  probeReady = contents => contents.executeJavaScript(EDITOR_READY_SCRIPT), readinessTimeoutMs = EDITOR_READINESS_TIMEOUT_MS, readinessPollMs = 150 }) {
  let view, contentsReference, attachedWindow, detachPolicy, detachNavigation, rectangle;
  let active = false, disposed = false, closing,detachDiagnostics,loadGeneration=0;
  const report=(event,fields={})=>{try{onDiagnostic(event,fields);}catch{}};
  function hide() {
    active = false;
    // Closing WebContents can destroy the native WebContentsView before the
    // JavaScript wrapper is detached from its parent. Teardown is idempotent.
    try { if (view) view.setVisible(false); } catch { /* Native view already gone. */ }
  }
  function resize() {
    if (!view || !attachedWindow || attachedWindow.isDestroyed?.() || !rectangle) return;
    const size = attachedWindow.getContentBounds();
    const zoom = attachedWindow.webContents.getZoomFactor?.() || 1;
    const bounds = viewportBounds(rectangle, size, zoom, sidebarCss);
    try {
      if (!contentsReference || contentsReference.isDestroyed()) return;
      view.setBounds(bounds);
      view.setVisible(Boolean(active && rectangle.visible && bounds.width && bounds.height));
    } catch { /* A native close may race the window's resize event. */ }
  }
  function setViewport(value) { rectangle = value; resize(); }
  function activate() { active = true; resize(); }
  async function load(origin, route) {
    if (disposed) throw new Error('EDITOR_STOPPED');
    const epoch=++loadGeneration;
    const emit=(event,fields={})=>{if(epoch===loadGeneration&&!disposed)report(event,fields);};
    const window = getWindow();
    if (!window || window.isDestroyed?.()) throw new Error('EDITOR_WINDOW_UNAVAILABLE');
    if (!view) {
      const session = electron.session.fromPartition(partitionName(dataDirectory));
      const policy = createEditorSessionPolicy(origin);
      detachPolicy = policy.attach(session);
      view = new electron.WebContentsView({ webPreferences: {
        session, contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false,
      } });
      contentsReference = view.webContents;
      emit('view_created');
      view.setVisible(false);
      detachNavigation = policy.constrain(contentsReference);
      const target=contentsReference, handlers=[];
      const listen=(name,handler)=>{const guarded=(...args)=>{if(target===contentsReference&&!disposed)handler(...args);};target.on(name,guarded);handlers.push([name,guarded]);};
      listen('dom-ready',()=>emit('page_dom_ready'));
      listen('did-fail-load',(_event,netErrorCode,_description,_url,mainFrame)=>emit('page_load_failed',{netErrorCode,mainFrame}));
      listen('console-message',(_event,level,message,lineNumber)=>{const details=level&&typeof level==='object'?level:{level,message,lineNumber};if(details.level===3||details.level==='error')emit('console_error',{...classifyText(details.message),lineNumber:details.lineNumber});});
      listen('render-process-gone',(_event,details)=>{emit('renderer_gone',{reason:details?.reason,exitCode:details?.exitCode});hide();onFailure?.('EDITOR_RENDERER_EXITED');});
      detachDiagnostics=()=>{for(const [name,handler]of handlers)target.removeListener(name,handler);};
      attachedWindow = window;
      window.contentView.addChildView(view);
      window.on('resize', resize);
      window.webContents.on('zoom-changed', resize);
    }
    emit('page_load_started');
    try{await contentsReference.loadURL(origin + route);}catch(error){emit('page_load_failed',errorFields(error));throw error;}
    if (disposed||epoch!==loadGeneration) throw new Error('EDITOR_STOPPED');
    emit('page_loaded');
    const contents = contentsReference;
    const deadline = Date.now() + readinessTimeoutMs;
    let ready = false;
    emit('shell_wait_started',{deadlineMs:readinessTimeoutMs});
    while (!disposed && epoch===loadGeneration && !contents.isDestroyed() && Date.now() <= deadline) {
      if (await probeReady(contents)) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, readinessPollMs));
    }
    if (!ready || disposed || epoch!==loadGeneration || contents.isDestroyed()){emit('shell_timeout',{deadlineMs:readinessTimeoutMs});throw new Error('EDITOR_LOAD_FAILED');}
    emit('shell_ready');
    resize();
  }
  function destroyView() {
    loadGeneration++;
    hide();
    try{detachDiagnostics?.();}catch{}
    try {
      attachedWindow?.removeListener('resize', resize);
      attachedWindow?.webContents.removeListener('zoom-changed', resize);
    } catch { /* Parent native window already gone. */ }
    if (view) {
      try { attachedWindow?.contentView.removeChildView(view); } catch { /* Window already closed. */ }
      try { detachNavigation?.(); } catch { /* WebContents already gone. */ }
      try { if (contentsReference && !contentsReference.isDestroyed()) contentsReference.close(); } catch { /* Native view already gone. */ }
    }
    try { detachPolicy?.(); } catch { /* Session already destroyed during shutdown. */ }
    view = contentsReference = attachedWindow = detachPolicy = detachNavigation = detachDiagnostics = undefined;
  }
  function requestClose() {
    if (!view || !contentsReference || contentsReference.isDestroyed()) return Promise.resolve(true);
    if (closing) return closing;
    const contents = contentsReference;
    closing = new Promise(resolve => {
      let settled = false;
      const settle = allowed => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener('destroyed', destroyed);
        contents.removeListener('will-prevent-unload', prevented);
        resolve(allowed);
      };
      const destroyed = () => settle(true);
      // Do NOT preventDefault here: Electron uses that to override the page's
      // beforeunload veto. Keep the native persistence guard authoritative.
      const prevented = () => settle(false);
      const timer = setTimeout(() => settle(false), 5000);
      contents.once('destroyed', destroyed);
      contents.once('will-prevent-unload', prevented);
      try { contents.close({ waitForBeforeUnload: true }); } catch { settle(false); }
    }).finally(() => { closing = null; });
    return closing;
  }
  return {
    activate, hide, resize, setViewport, load, reset: destroyView, requestClose,
    hasView: () => Boolean(view),
    dispose() { disposed = true; destroyView(); },
  };
}
module.exports = { createEditorView, EDITOR_READY_SCRIPT };
