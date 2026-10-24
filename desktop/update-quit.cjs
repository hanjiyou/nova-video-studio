'use strict';
function createUpdateQuitHandler({ getUpdates, getLaunchProof, closeHost, quit, onFailure }) {
  let pending = false;
  return {
    handle(event) {
      const updates = getUpdates();
      if (!updates?.installing && !updates?.preparing && !updates?.backendClosed) return false;
      event.preventDefault();
      if (!updates.installing || pending) return true;
      pending = true;
      void Promise.resolve().then(() => getLaunchProof().confirm()).then(launched => {
        if (!launched) { onFailure(); return; }
        closeHost(); quit();
      }).catch(() => onFailure());
      return true;
    },
  };
}
module.exports = { createUpdateQuitHandler };
