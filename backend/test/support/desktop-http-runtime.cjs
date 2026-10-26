'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');
const { resolveBackendPort } = require('../../../desktop/runtime.cjs');
// Test-only Node host bridge. No production route/env switch provides this fake vault.
function testProtection() {
    const key = createHash('sha256').update('T04 fixed synthetic Node-only fixture encryption').digest();
    return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_crypto',
        encryptString(value) { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); return Buffer.concat([nonce, ...encrypt(cipher, value)]); },
        decryptString(bytes) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); } };
}
function encrypt(cipher, value) { const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [cipher.getAuthTag(), ciphertext]; }
function runChild() {
    let server;
    const responseReads=[];
    process.on('message', async (message) => {
        try {
            if (message.action === 'start') {
                if(message.opensosenOrigin||message.pluginOrigin){
                    const worker=require('../../storage/download-worker'),production=worker.createDownloadWorker;
                    const origins=message.opensosenOrigin?['https://newapi.opensosen.com','https://newapi.opensosen.cn']:['https://pro.ccode.vip'];
                    // Test-only destination check; global.fetch below maps this exact synthetic
                    // service to loopback. There is no production env/route capability bypass.
                    worker.createDownloadWorker=options=>production({...options,checkUrl:async url=>{if(!origins.includes(url.origin))throw require('../../storage/download-errors').failure('DOWNLOAD_FORBIDDEN');}});
                }
                if (message.session) {
                    require('../../desktop-session').configureDesktopSession(message.session);
                    require('../../connections/host').configureConnectionHost(db => require('../../../desktop/credential-vault.cjs').createCredentialVault({ db, safeStorage: testProtection() }));
                }
                if (message.pluginOrigin) {
                    const destination=new URL(message.pluginOrigin);assert.equal(destination.hostname,'127.0.0.1');
                    const originalFetch=global.fetch;
                    global.fetch=(url,init)=>{const target=new URL(url);assert.equal(target.origin,'https://pro.ccode.vip');return originalFetch(new URL(target.pathname+target.search,destination),init);};
                }
                if (message.opensosenOrigin) {
                    const destination=new URL(message.opensosenOrigin);assert.equal(destination.hostname,'127.0.0.1');
                    const originalFetch=global.fetch;
                    global.fetch=(url,init)=>{const target=new URL(url);assert.ok(['https://newapi.opensosen.com','https://newapi.opensosen.cn'].includes(target.origin));return originalFetch(new URL(target.pathname+target.search,destination),init);};
                }
                if (message.pluginRequestTimeoutMs !== undefined) {
                    assert.ok(Number.isInteger(message.pluginRequestTimeoutMs) && message.pluginRequestTimeoutMs>0 && message.pluginRequestTimeoutMs<=1000);
                    const originalTimeout=global.setTimeout;
                    global.setTimeout=(callback,delay,...args)=>originalTimeout(callback,delay===90000?message.pluginRequestTimeoutMs:delay,...args);
                }
                if (message.imageRequestTimeoutMs !== undefined) {
                    assert.ok(Number.isInteger(message.imageRequestTimeoutMs) && message.imageRequestTimeoutMs>0 && message.imageRequestTimeoutMs<=1000);
                    const originalTimeout=global.setTimeout;
                    // Desktop adapter receives a shorter existing remainingMs budget only in this test host.
                    // The service deadline remains its normal 120s; Web keeps its existing timer compression.
                    const imageAdapter=require('../../tasks/flare-image-adapter'),make=imageAdapter.createFlareImageAdapter;
                    imageAdapter.createFlareImageAdapter=options=>{const instance=make(options),submit=instance.submit.bind(instance);return {...instance,submit(task,snapshot,auth){return submit(task,snapshot,{...auth,remainingMs:()=>Math.min(auth.remainingMs?.()??Infinity,message.imageRequestTimeoutMs)});}};};
                    global.setTimeout=(callback,delay,...args)=>originalTimeout(callback,delay===30*60*1000?message.imageRequestTimeoutMs:delay,...args);
                }
                if (message.trackResponseReads) {
                    const originalFetch=global.fetch;
                    global.fetch=async(url,init)=>{
                        const response=await originalFetch(url,init);
                        const record={path:new URL(url).pathname,method:init?.method || 'GET',status:response.status,headersReceivedAt:Date.now(),textReads:0};responseReads.push(record);
                        const originalText=response.text.bind(response);
                        response.text=async(...args)=>{record.textReads++;try{return await originalText(...args);}finally{record.readSettledAt=Date.now();}};
                        return response;
                    };
                }
                server = require('../../server');
                await server.ready;
                process.send({ id: message.id, result: 'ready' });
            }
            else if (message.action === 'stop') {
                await server.shutdown({ drain: false });
                await require('undici').getGlobalDispatcher().close();
                process.disconnect();
            }
            else if (message.action==='response-reads') process.send({id:message.id,result:responseReads});
            else if (message.action==='prepare-update') process.send({id:message.id,result:server.prepareForUpdate()});
            else if (message.action==='release-update') {server.releaseUpdate();process.send({id:message.id,result:{ok:true}});}
            else if (message.action==='close-update') process.send({id:message.id,result:await server.shutdownForUpdate()});
            else if (['save', 'clear', 'select'].includes(message.action))
                process.send({ id: message.id, result: server.connections[message.action](message.input) });
            else
                throw new Error('Unsupported test bridge action');
        }
        catch (error) {
            process.send({ id: message.id, error: error.code || 'TEST_HOST_FAILED' });
        }
    });
}
async function start(directory, { desktop = true, imageStream = false, pluginOrigin, imageRequestTimeoutMs, trackResponseReads=false, opensosenOrigin, pluginRequestTimeoutMs } = {}) {
    const backend = path.resolve(__dirname, '../..'), port = await resolveBackendPort(0), origin = 'http://127.0.0.1:' + port, token = randomBytes(32).toString('hex');
    const child = spawn(process.execPath, ['-e', "require('./test/support/desktop-http-runtime.cjs').runChild()"], { cwd: backend, env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port), NOVA_TASK_DB: path.join(directory, 'tasks.sqlite'), NOVA_IMAGE_DIR: path.join(directory, 'images'), NOVA_PLUGIN_MEDIA_DIR: path.join(directory, 'plugin-media'), NOVA_STORAGE_DIR: path.join(directory, 'storage'), NOVA_CDP_ENABLED: 'false', NOVA_AGENT_ENABLED: 'false', NOVA_IMAGE_STREAM: imageStream ? 'true' : 'false', NOVA_IMAGE_PARTIAL_IMAGES: '2', NOVA_TASK_CONCURRENCY: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    const pending = new Map();
    for (const stream of ['stdout', 'stderr'])
        child[stream].on('data', chunk => { output += chunk; });
    child.on('message', message => {
        const entry = pending.get(message.id);
        if (!entry)
            return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        message.error ? entry.reject(Object.assign(new Error(message.error), { code: message.error })) : entry.resolve(message.result);
    });
    const rpc = (action, input) => new Promise((resolve, reject) => { const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('Test host timeout: ' + action)); }, 10000); pending.set(id, { resolve, reject, timer }); child.send({ id, action, input, ...(action === 'start' && desktop ? { session: { origin, token } } : {}), ...(pluginOrigin?{pluginOrigin}:{}), ...(opensosenOrigin?{opensosenOrigin}:{}), ...(pluginRequestTimeoutMs===undefined?{}:{pluginRequestTimeoutMs}), ...(imageRequestTimeoutMs===undefined?{}:{imageRequestTimeoutMs}), ...(trackResponseReads?{trackResponseReads:true}:{}) }); });
    try {
        await rpc('start');
    }
    catch (error) {
        child.kill();
        throw new Error(error.message + '; ' + output,{cause:error});
    }
    const headers = desktop ? { 'x-nova-session': token } : {};
    return { origin, secret: token, headers, request: (route, options = {}) => fetch(origin + route, { ...options, headers: { ...headers, ...options.headers } }), output: () => output,
        openWebSocket: () => new (require('ws'))(origin.replace('http:', 'ws:') + '/api/nova/ws', { headers: { ...headers, Origin: origin } }),
        responseReads:()=>rpc('response-reads'),
        prepareUpdate:()=>rpc('prepare-update'), releaseUpdate:()=>rpc('release-update'), closeUpdate:()=>rpc('close-update'),
        saveConnection: input => rpc('save', input), clearConnectionCredential: input => rpc('clear', input), selectConnection: input => rpc('select', input),
        async crash() {
            const exit=await new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.kill('SIGKILL');});
            assert.equal(output.includes(token),false);return exit;
        },
        async stop() {
            if (child.exitCode !== null)
                return;
            await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Shutdown timeout')); }, 5000); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Shutdown exit ' + code + '; ' + output)); }); child.send({ action: 'stop' }); });
            assert.equal(output.includes(token), false);
        }
    };
}
module.exports = { start, runChild };
