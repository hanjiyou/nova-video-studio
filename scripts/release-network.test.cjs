"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { configuration, createNetwork } = require('./lib/release-network.cjs');
const { github, remoteHash } = require('./release-windows-update.cjs');
const API = 'https://api.github.com/repos/hanjiyou/nova-video-studio';
async function serve(t, server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('configuration validates proxy and bounded timeouts; direct overrides environment', () => {
  assert.equal(configuration({}, { NOVA_RELEASE_PROXY: 'http://127.0.0.1:1234' }).proxy, 'http://127.0.0.1:1234');
  assert.equal(configuration({ direct: true }, { NOVA_RELEASE_PROXY: 'http://127.0.0.1:1234' }).proxy, undefined);
  for (const proxy of ['bad', 'http://user:secret@localhost', 'http://localhost/?secret=x', 'socks://localhost']) assert.throws(() => configuration({ proxy }), /proxy|Proxy/);
  assert.throws(() => configuration({ proxy: 'http://localhost', direct: true }));
  for (const transferTimeout of [0, -1, 0.5, 'bad', 7201]) assert.throws(() => configuration({ transferTimeout }));
  assert.equal(configuration({}, {}).transferMs, 1800000);
});
test('real loopback proxy carries upload and verification response through one dispatcher', async t => {
  const bytes = Buffer.alloc(256 * 1024, 42); let received = 0, tunnels = 0;
  const target = await serve(t, http.createServer(async (req, res) => {
    for await (const chunk of req) received += chunk.length;
    res.end(bytes);
  }));
  const proxyServer = http.createServer();
  const upstreams = new Set(); t.after(() => { for (const socket of upstreams) socket.destroy(); });
  proxyServer.on('connect', (req, socket, head) => {
    tunnels++;
    const endpoint = new URL('http://' + req.url);
    assert.equal(endpoint.hostname, '127.0.0.1');
    const upstream = net.connect(Number(endpoint.port), endpoint.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstreams.add(upstream); upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
  });
  const proxy = await serve(t, proxyServer), logs = [];
  const network = createNetwork({ proxy }, { log: line => logs.push(line) });
  try {
    for (const method of ['POST', 'GET']) {
      const result = await network.execute(method === 'POST' ? 'upload' : 'download', async (send, progress) => {
        const response = await send(target, { method, ...(method === 'POST' ? { body: bytes } : {}) });
        const chunks = []; for await (const chunk of response.body) { progress(chunk.length); chunks.push(chunk); }
        return Buffer.concat(chunks);
      });
      assert.deepEqual(result, bytes);
    }
    assert.equal(received, bytes.length); assert.ok(tunnels > 0); assert.ok(logs.some(line => line.includes('complete')));
  } finally { await network.close(); }
});
test('stalled response aborts with redacted idle diagnostic and releases connection', async t => {
  const url = await serve(t, http.createServer((req, res) => { res.writeHead(200); res.write('start'); }));
  const network = createNetwork({ direct: true, idleTimeout: 1, transferTimeout: 5 }, { log() {} });
  try {
    await assert.rejects(network.execute('download', async (send, progress) => {
      const response = await send(url + '/secret-token');
      for await (const chunk of response.body) progress(chunk.length);
    }), error => /idle timeout/.test(error.message) && !error.message.includes('secret-token'));
  } finally { await network.close(); }
});
test('active transfer still obeys total deadline', async t => {
  const url = await serve(t, http.createServer((req, res) => {
    const timer = setInterval(() => res.write('x'), 100); res.on('close', () => clearInterval(timer));
  }));
  const network = createNetwork({ direct: true, transferTimeout: 1, idleTimeout: 3 }, { log() {} });
  try {
    await assert.rejects(network.execute('download', async (send, progress) => {
      const response = await send(url); for await (const chunk of response.body) progress(chunk.length);
    }), /total timeout/);
  } finally { await network.close(); }
});
test('GitHub upload and redirected hash use transport, strip auth and preserve HTTP diagnostic', async () => {
  const calls = [];
  const network = { execute: async (kind, operation) => operation(async (url, init) => {
    calls.push({ url, init, kind });
    if (url.includes('uploads.github.com')) {
      let size = 0; for await (const chunk of init.body) size += chunk.length;
      assert.equal(size, 100000); return new Response('{}');
    }
    if (url.startsWith(API)) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } });
    assert.equal(init.headers.Authorization, undefined); return new Response('fixture');
  }, () => {}) };
  await github('synthetic', undefined, network)('https://uploads.github.com/repos/hanjiyou/nova-video-studio/releases/42/assets?name=x', { method: 'POST', binary: true, body: Buffer.alloc(100000) });
  assert.equal((await remoteHash(1, 'synthetic', network)).size, 7);
  assert.equal(calls.length, 3);
  await assert.rejects(github('synthetic', async () => new Response('', { status: 403 }))(API), /HTTP 403/);
});


test('connection errors never print upstream URLs or secrets', async () => {
 const network=createNetwork({direct:true},{log(){},fetch:async()=>{throw Error('https://secret.invalid/token=secret');}});
 try {await assert.rejects(network.execute('API',send=>send('https://secret.invalid')),error=>/connection\/stream failure/.test(error.message)&&!error.message.includes('secret'));}
 finally {await network.close();}
});
test('asset redirects reject untrusted destinations before sending credentials', async()=>{
 let sends=0;
 const network={execute:async(kind,operation)=>operation(async()=>{sends++;return new Response(null,{status:302,headers:{location:'https://github.com.evil.invalid/secret'}});},()=>{})};
 await assert.rejects(remoteHash(1,'synthetic',network),/Unexpected GitHub asset redirect/);assert.equal(sends,1);
});


test('direct and proxy pools leave total and idle deadlines to the operation', async () => {
 const seen = [];
 class Pool { constructor(options) { seen.push(options); } async close() {} }
 for (const options of [{direct:true}, {proxy:'http://127.0.0.1:1234'}]) {
   const network = createNetwork(options, {Agent:Pool, ProxyAgent:Pool, log(){}});
   await network.close();
 }
 assert.equal(seen.length,2);
 for (const options of seen) { assert.equal(options.headersTimeout,0); assert.equal(options.bodyTimeout,0); }
 assert.equal(seen[0].connect.timeout,30000);
 assert.equal(seen[1].connectTimeout,30000);
});
