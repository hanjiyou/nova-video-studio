'use strict';
function updateError(code = 'UPDATE_PREPARING') { return Object.assign(new Error('应用正在准备更新，请稍后再试。'), { code, statusCode: 503 }); }
function createUpdateGate() {
  let phase = 'open';
  const active = new Set();
  return {
    get phase() { return phase; },
    get activeCount() { return active.size; },
    enter({ flush = false, read = false } = {}) {
      if (phase !== 'open' && !(phase === 'preparing' && (flush || read))) throw updateError();
      const id = Symbol(); active.add(id); let released = false;
      return () => { if (!released) { released = true; active.delete(id); } };
    },
    async run(operation, options) { const leave = this.enter(options); try { return await operation(); } finally { leave(); } },
    begin() { if (phase !== 'open' || active.size) throw updateError('UPDATE_BUSY'); phase = 'preparing'; },
    commit() { if (phase !== 'preparing' || active.size) throw updateError('UPDATE_BUSY'); phase = 'closing'; },
    release() { if (phase === 'preparing' || phase === 'closing') phase = 'open'; },
    closed() { phase = 'closed'; },
    fault() { phase = 'fault'; },
  };
}
function strictCloseDatabase(db) {
  if (!db.open) throw updateError('UPDATE_DATABASE_NOT_OPEN');
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  if (!Array.isArray(checkpoint) || checkpoint.length !== 1 || checkpoint.some(row => row.busy !== 0)) throw updateError('UPDATE_CHECKPOINT_FAILED');
  db.close();
  if (db.open) throw updateError('UPDATE_DATABASE_CLOSE_FAILED');
  return { databaseClosed: true, checkpointComplete: true };
}
module.exports = { createUpdateGate, strictCloseDatabase, updateError };
