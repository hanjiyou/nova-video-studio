'use strict';
const net = require('node:net');
const path = require('node:path');
function resolveDataPolicy({ env = process.env, systemUserData }) {
  if (env.NOVA_DATA_DIR) return { mode: 'override', directory: path.resolve(env.NOVA_DATA_DIR) };
  if (env.PORTABLE_EXECUTABLE_DIR) return { mode: 'portable', directory: path.join(path.resolve(env.PORTABLE_EXECUTABLE_DIR), 'data') };
  return { mode: 'system', directory: systemUserData };
}
function tryListen(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(chosen));
    });
  });
}
async function resolveBackendPort(start = 31207, attempts = 10) {
  if (!Number.isInteger(start) || start < 0 || start > 65535) throw new Error('Invalid NOVA_BACKEND_PORT');
  for (let index = 0; index < attempts && start + index <= 65535; index++) {
    try { return await tryListen(start === 0 ? 0 : start + index); } catch { /* bounded next-port attempt */ }
  }
  return tryListen(0);
}
module.exports = { resolveDataPolicy, resolveBackendPort };
