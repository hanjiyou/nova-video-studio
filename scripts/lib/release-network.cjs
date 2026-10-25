"use strict";
const { fetch, Agent, ProxyAgent } = require('undici');
class NetworkError extends Error {}
function configuration(options = {}, env = process.env) {
  const proxy = options.proxy ?? env.NOVA_RELEASE_PROXY;
  if (options.direct && options.proxy) throw new NetworkError('Choose --proxy or --direct.');
  let endpoint;
  if (proxy && !options.direct) {
    try { endpoint = new URL(proxy); } catch { throw new NetworkError('Invalid release proxy URL.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new NetworkError('Proxy must be an HTTP(S) origin without credentials.');
  }
  const seconds = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < 1 || n > 7200) throw new NetworkError('Network timeouts must be integer seconds from 1 to 7200.');
    return n * 1000;
  };
  return { proxy: endpoint?.origin, apiMs: 60000, connectMs: 30000,
    transferMs: seconds(options.transferTimeout, 1800), idleMs: seconds(options.idleTimeout, 60) };
}
function createNetwork(options = {}, dependencies = {}) {
  const config = configuration(options);
  // The operation's abort signal owns deadlines; undici's default 300s
  // headers/body timers must not silently shorten the configured transfer limit.
  const transportOptions = { headersTimeout: 0, bodyTimeout: 0 };
  const DirectAgent = dependencies.Agent || Agent, TunnelAgent = dependencies.ProxyAgent || ProxyAgent;
  const dispatcher = dependencies.dispatcher || (config.proxy
    ? new TunnelAgent({ ...transportOptions, uri: config.proxy, proxyTunnel: true, requestTls: { timeout: config.connectMs }, proxyTls: { timeout: config.connectMs }, connectTimeout: config.connectMs })
    : new DirectAgent({ ...transportOptions, connect: { timeout: config.connectMs } }));
  const log = dependencies.log || console.log;
  log('[network] ' + (config.proxy ? 'explicit proxy ' + config.proxy : 'no application proxy (system VPN/TUN may still apply)'));
  return {
    async execute(kind, operation) {
      const controller = new AbortController(), start = Date.now();
      let reason, count = 0, idle;
      const abort = why => { reason = why; controller.abort(); };
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort('idle timeout'), config.idleMs); };
      const total = setTimeout(() => abort('total timeout'), kind === 'API' ? config.apiMs : config.transferMs);
      const progress = (bytes = 0) => { count += bytes; touch(); };
      const printProgress = () => {
        const elapsed = (Date.now() - start) / 1000;
        log(`[${kind}] ${count} bytes, ${elapsed.toFixed(1)}s, ${Math.round(count / Math.max(elapsed, 0.001))} B/s`);
      };
      const ticker = kind === 'API' ? null : setInterval(printProgress, 5000);
      touch();
      try {
        const result = await operation((url, init) => (dependencies.fetch || fetch)(url, { ...init, dispatcher, signal: controller.signal }), progress);
        if (kind !== 'API') log(`[${kind}] complete: ${count} bytes, ${((Date.now() - start) / 1000).toFixed(1)}s`);
        return result;
      } catch (error) {
        if (error?.safeReleaseError) throw error;
        const code = error?.cause?.code || error?.code;
        const category = reason || (code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timeout' : 'connection/stream failure');
        throw new NetworkError(`${kind}: ${category}; draft retained. Inspect status before retrying.`);
      } finally { clearTimeout(total); clearTimeout(idle); clearInterval(ticker); }
    },
    close: () => dispatcher.close()
  };
}
module.exports = { configuration, createNetwork, NetworkError };
