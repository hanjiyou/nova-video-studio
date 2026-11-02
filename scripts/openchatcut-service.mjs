// Bundled beside the upstream desktop artifacts. No Electron app lifecycle here.
import { createServer } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import runtimeConfiguration from '../config/openchatcut-runtime.json' with { type: 'json' };

const ENGINE_COMMIT = runtimeConfiguration.engineCommit;
let server;
let closing = false;
const report = message => process.send?.(message);
async function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  process.exit(exitCode);
}
process.on('message', message => { if (message?.type === 'openchatcut:stop') void stop(); });
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

async function main() {
  const root = process.env.OPENCHATCUT_DATA_DIR;
  const distDir = process.env.NOVA_OPENCHATCUT_DIST_DIR;
  if (!root || !isAbsolute(root) || !distDir || !isAbsolute(distDir) || !process.env.OPENCHATCUT_DEV_PROFILE_ID || process.env.NOVA_OPENCHATCUT_OFFLINE !== '1') throw new Error('EDITOR_PROFILE_REQUIRED');
  await stat(join(distDir, 'index.html'));
  await mkdir(root, { recursive: true });
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    if (!process.env[key] || !isAbsolute(process.env[key])) throw new Error('EDITOR_PROFILE_REQUIRED');
    await mkdir(process.env[key], { recursive: true });
  }
  // Resolve native profile singletons only after cwd and environment isolation.
  process.chdir(root);
  const [{ serverPlugins }, { createMiniConnect }, { distStaticMiddleware, uploadsMiddleware }, { registerProductAssetRoot }, projects, { listenWithAffinity }] = await Promise.all([
    import('../third_party/openchatcut/server/plugins/index.ts'),
    import('../third_party/openchatcut/desktop/mini-connect.ts'),
    import('../third_party/openchatcut/desktop/static-files.ts'),
    import('../third_party/openchatcut/server/product-assets.ts'),
    import('../third_party/openchatcut/server/external-agent/projects.ts'),
    import('../third_party/openchatcut/desktop/embedded-port.ts'),
  ]);
  registerProductAssetRoot(distDir);
  const app = createMiniConnect(() => { /* Never send raw errors/paths to renderer or parent. */ });
  server = createServer((req, res) => app.handle(req, res));
  // OCC06 replaces native plaintext keystore persistence before credentials are enabled.
  app.use((req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    const blocked = ((pathname === '/api/keys' || pathname.startsWith('/api/keys/')) && !['GET', 'HEAD'].includes(req.method))
      || pathname.startsWith('/api/external-mcp')
      || ((pathname === '/api/skills' || pathname.startsWith('/api/skills/')) && !['GET', 'HEAD'].includes(req.method))
      || /^\/api\/(?:codex|claude-code|copilot|xai-oauth|skill-exec|skill-install)(?:\/|$)/.test(pathname);
    if (!blocked) { next(); return; }
    req.resume(); res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ code: 'EDITOR_CREDENTIAL_BRIDGE_NOT_READY', error: '凭据与外部工具接入尚未就绪；当前仅验证本地编辑。' }));
  });
  const fake = { middlewares: { use: app.use.bind(app) }, httpServer: server, config: { logger: { info() {}, warn() {}, error() {} } } };
  for (const plugin of serverPlugins({ projectStoreHttp: true })) {
    const hook = plugin.configureServer;
    const run = typeof hook === 'function' ? hook : hook?.handler;
    await run?.call(plugin, fake);
  }
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));
  let project = (await projects.listExternalProjects())[0];
  if (!project) project = await projects.createExternalProject({ name: '未命名剪辑', compositionWidth: 1920, compositionHeight: 1080, fps: 30 });
  if (closing) return;
  // Keep browser storage on the same origin across normal restarts. The native
  // fallback also remembers a new port if another local service occupies it.
  const port = await listenWithAffinity(server, { home: process.env.HOME, profileId: process.env.OPENCHATCUT_DEV_PROFILE_ID, log() {} });
  report({ type: 'openchatcut:ready', origin: `http://127.0.0.1:${port}`, editorPath: `/#/editor/${encodeURIComponent(project.id)}`, engineCommit: ENGINE_COMMIT });
}
main().catch(() => { report({ type: 'openchatcut:failed', code: 'EDITOR_START_FAILED' }); void stop(1).catch(() => process.exit(1)); });
