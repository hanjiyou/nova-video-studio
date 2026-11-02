'use strict';

function createEditorCloseGuard({ getEditor, getWindow, dialog }) {
  let closing = null, allowWindowClose = false;
  function requestClose() {
    if (closing) return closing;
    closing = (async () => {
      const editor = getEditor();
      if (!editor?.hasEditingContext()) return true;
      let allowed = false;
      try { allowed = await editor.requestClose(); } catch { /* Preserve the page when close cannot be verified. */ }
      if (!allowed) {
        const window = getWindow();
        const message = { type: 'warning', title: '剪辑工程尚未完成保存',
          message: '请回到视频剪辑，等待工程保存完成后再关闭。',
          detail: '剪辑页面已保留，本次关闭已取消。', buttons: ['返回应用'], defaultId: 0, cancelId: 0 };
        if (window && !window.isDestroyed?.()) { window.show?.(); window.focus?.(); await dialog.showMessageBox(window, message); }
        else await dialog.showMessageBox(message);
      }
      return allowed;
    })().finally(() => { closing = null; });
    return closing;
  }
  function interceptWindowClose(event) {
    if (allowWindowClose || !getEditor()?.hasEditingContext()) return false;
    event.preventDefault();
    void requestClose().then(allowed => {
      const window = getWindow();
      if (!allowed || !window || window.isDestroyed?.()) return;
      allowWindowClose = true;
      try { window.close(); } finally { allowWindowClose = false; }
    }).catch(() => {});
    return true;
  }
  return { requestClose, interceptWindowClose };
}
module.exports = { createEditorCloseGuard };
