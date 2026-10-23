'use strict';

// Test-only loopback provider. No env credentials, external requests, or production imports.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const FIXTURE_TOKEN = 'fixture-token';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'workbench-v1');
const fixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const DEFAULT_DOWNLOAD = Buffer.from([0, 255, 17, 34, 0, 13, 10, 128, 65, 66, 67]);

function hydrate(value, taskId, baseUrl) {
  if (Array.isArray(value)) return value.map(item => hydrate(item, taskId, baseUrl));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['id', 'task_id'].includes(key) ? taskId : ['url', 'result_url', 'video_url'].includes(key)
      ? `${baseUrl}/videos/${encodeURIComponent(taskId)}/content` : hydrate(item, taskId, baseUrl)]));
  return value;
}

async function parseBody(req, maxBodyBytes) {
  let size = 0;
  let exceeded = false;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) { exceeded = true; chunks.length = 0; }
    if (!exceeded) chunks.push(chunk);
  }
  if (exceeded) throw Object.assign(new Error('Mock request exceeds test body limit'), { status: 413 });
  const rawBody = Buffer.concat(chunks);
  const contentType = String(req.headers['content-type'] || '');
  if (/^application\/json\b/i.test(contentType)) {
    return { encoding: 'json', rawBody, json: JSON.parse(rawBody.toString('utf8')), parts: [] };
  }
  if (/^multipart\/form-data\b/i.test(contentType)) {
    // WHATWG parser preserves duplicate names and binary bytes; never decode files as text.
    const form = await new Response(rawBody, { headers: { 'content-type': contentType } }).formData();
    const parts = [];
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') parts.push({ kind: 'field', name, value });
      else {
        const bytes = Buffer.from(await value.arrayBuffer());
        parts.push({ kind: 'file', name, fileName: value.name, mimeType: value.type, bytes, byteLength: bytes.length, sha256: digest(bytes) });
      }
    }
    return { encoding: 'multipart', contentType, rawBody, parts };
  }
  throw Object.assign(new Error('Mock accepts JSON or multipart only'), { status: 415 });
}

function verifyMultipart(record, expected) {
  assert.equal(record.encoding, 'multipart');
  assert.match(record.contentType, /boundary=/i);
  const fields = record.parts.filter(part => part.kind === 'field');
  const files = record.parts.filter(part => part.kind === 'file');
  if (expected.fields) assert.deepEqual(fields.map(({ name, value }) => ({ name, value })), expected.fields);
  assert.equal(files.length, expected.files.length, 'file part count');
  expected.files.forEach((wanted, index) => {
    const actual = files[index];
    assert.equal(actual.name, wanted.name, `part ${index} field name`);
    assert.equal(actual.fileName, wanted.fileName, `part ${index} file name/order`);
    assert.equal(actual.mimeType, wanted.mimeType, `part ${index} MIME`);
    assert.deepEqual(actual.bytes, wanted.bytes, `part ${index} original bytes/order`);
    assert.equal(actual.sha256, digest(wanted.bytes), `part ${index} SHA-256`);
  });
}

async function startMockProvider(options = {}) {
  const records = [];
  const tasks = new Map((options.seedTasks || []).map(task => [task.id, { id: task.id, pollCount: 0, rawStatus: task.rawStatus || 'completed' }]));
  const seededTaskCount = tasks.size;
  const timers = new Set();
  const sockets = new Set();
  let baseUrl;
  let submitIndex = 0;
  let downloadIndex = 0;
  let sequence = 0;
  const stepAt = (steps, index, fallback = {}) => !steps?.length ? fallback : steps[Math.min(index, steps.length - 1)];
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  function respond(res, status, body, step = {}, extraHeaders = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const send = () => {
      if (res.destroyed) return;
      const headers = { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...Object.fromEntries(Object.entries({ ...extraHeaders, ...step.headers }).map(([name, value]) => [name.toLowerCase(), value])), 'content-length': String(payload.length) };
      res.writeHead(status, headers);
      if (step.disconnect === 'mid_body') {
        res.flushHeaders();
        res.write(payload.subarray(0, Math.max(1, Math.floor(payload.length / 2))));
        later(() => res.destroy(), 15);
      } else res.end(payload);
    };
    if (step.delayMs) later(send, step.delayMs); else send();
  }
  const server = http.createServer(async (req, res) => {
    const requestPath = new URL(req.url, 'http://127.0.0.1').pathname;
    const record = { method: req.method, path: requestPath, authorizationPresent: Boolean(req.headers.authorization), bodyComplete: false };
    records.push(record); // Count at request arrival, even if the response never reaches the client.
    try {
      if (req.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
        req.resume();
        respond(res, options.authFailureStatus || 401, { error: { code: 'fixture_auth_rejected', message: 'Synthetic authentication rejection' } });
        return;
      }
      if (req.method === 'POST' && requestPath === '/v1/videos') {
        Object.assign(record, await parseBody(req, options.maxBodyBytes || 1024 * 1024), { bodyComplete: true });
        const step = stepAt(options.submitSteps, submitIndex++);
        const status = step.status ?? 200;
        const accepted = step.accept ?? (status >= 200 && status < 300);
        let id;
        if (accepted) {
          do { id = `task_fixture_${String(++sequence).padStart(4, '0')}`; } while (tasks.has(id));
          tasks.set(id, { id, pollCount: 0, rawStatus: 'queued' });
          record.acceptedUpstreamTaskId = id;
        }
        if (step.disconnect === 'after_accept') { res.destroy(); return; }
        const body = step.body ?? hydrate(fixture('video-created.json').response.body, id, baseUrl);
        respond(res, status, body, step);
        return;
      }
      const match = requestPath.match(/^\/v1\/videos\/([^/]+)(\/content)?$/);
      if (req.method !== 'GET' || !match) { respond(res, 404, { error: 'Unknown mock route' }); return; }
      const id = decodeURIComponent(match[1]);
      const task = tasks.get(id);
      if (!task) { respond(res, 404, { error: { code: 'fixture_not_found' } }); return; }
      if (!match[2]) {
        const defaults = [fixture('video-generating.json').response, fixture('video-completed.json').response];
        const step = stepAt(options.pollSteps, task.pollCount, defaults[Math.min(task.pollCount, defaults.length - 1)]);
        task.pollCount++;
        const body = hydrate(step.body || {}, id, baseUrl);
        task.rawStatus = body.status || task.rawStatus;
        respond(res, step.status ?? 200, body, step);
        return;
      }
      const step = stepAt(options.downloadSteps, downloadIndex++);
      if (task.rawStatus !== 'completed' && !step.allowBeforeCompletion) { respond(res, 409, { error: 'Synthetic task is not completed' }); return; }
      let payload = step.body ?? DEFAULT_DOWNLOAD;
      let status = step.status ?? 200;
      const headers = {};
      if (Buffer.isBuffer(payload) && status === 200 && req.headers.range) {
        const range = String(req.headers.range).match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : -1;
        const end = range && range[2] ? Math.min(Number(range[2]), payload.length - 1) : payload.length - 1;
        if (!range || start < 0 || start > end || start >= payload.length) {
          respond(res, 416, Buffer.alloc(0), step, { 'content-range': `bytes */${payload.length}` }); return;
        }
        headers['content-range'] = `bytes ${start}-${end}/${payload.length}`;
        headers['accept-ranges'] = 'bytes';
        payload = payload.subarray(start, end + 1);
        status = 206;
      }
      respond(res, status, payload, step, headers);
    } catch (error) {
      record.parseError = error.message;
      if (!res.destroyed && !res.headersSent) respond(res, error.status || 400, { error: { code: 'fixture_invalid_request', message: error.message } });
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl,
    get requests() { return records; },
    get taskIds() { return [...tasks.keys()]; },
    count(method, requestPath) { return records.filter(record => record.method === method && (!requestPath || record.path === requestPath)).length; },
    get counters() { return { submitPosts: records.filter(r => r.method === 'POST' && r.path === '/v1/videos').length, pollGets: records.filter(r => r.method === 'GET' && /^\/v1\/videos\/[^/]+$/.test(r.path)).length, downloadGets: records.filter(r => r.method === 'GET' && r.path.endsWith('/content')).length, acceptedCreates: tasks.size - seededTaskCount }; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

module.exports = { startMockProvider, verifyMultipart, FIXTURE_TOKEN, FIXTURE_DIR, DEFAULT_DOWNLOAD };
