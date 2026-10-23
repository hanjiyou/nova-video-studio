'use strict';
const { fail, MAX_ASSET_BYTES } = require('./store');
function rangeFor(value, size) {
    if (!value) return null;
    const match=/^bytes=(\d*)-(\d*)$/.exec(value);
    if(!match||!match[1]&&!match[2])return false;
    if([match[1],match[2]].some(part=>part&&!Number.isSafeInteger(Number(part))))return false;
    let start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
    let end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start||!match[1]&&Number(match[2])===0)return false;
    return {start,end};
}
function createStorageHttp({ getStore, getConnections, readRawBody, sendJson }) {
    const jsonBody = async (req) => {
        try {
            return JSON.parse((await readRawBody(req, 256 * 1024)).toString('utf8'));
        }
        catch (error) {
            if (error.statusCode)
                throw error;
            throw fail('INVALID_STORAGE_JSON');
        }
    };
    return async function handleStorage(req, res, pathname, searchParams) {
        if (!pathname.startsWith('/api/nova/storage/') && !pathname.startsWith('/api/nova/assets/'))
            return false;
        const store = getStore();
        if (!store)
            return false; // Web mode retains its existing API and storage policy.
        try {
            if (pathname === '/api/nova/assets/import' && req.method === 'POST') {
                const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                if (!['image/png', 'image/jpeg'].includes(mime))
                    throw fail('ASSET_TYPE_INVALID', '导入参考图支持PNG和JPEG。', 415);
                const bytes = await readRawBody(req, MAX_ASSET_BYTES);
                const name = req.headers['x-nova-filename'] ? decodeURIComponent(req.headers['x-nova-filename']) : 'reference';
                sendJson(res, 201, { asset: store.importBuffer(bytes, { mimeType: mime, displayName: name }) });
                return true;
            }
            const asset = pathname.match(/^\/api\/nova\/assets\/([^/]+)(\/content)?$/);
            if (asset && ['GET', 'HEAD'].includes(req.method)) {
                if (!asset[2]) {
                    const result = store.getAsset(asset[1]);
                    if (!result)
                        throw fail('ASSET_NOT_FOUND', '找不到素材。', 404);
                    sendJson(res, 200, { asset: result });
                    return true;
                }
                const { bytes, asset: metadata } = store.readAsset(asset[1]);
                const etag='"sha256-'+metadata.sha256+'"',headers={ 'Content-Type': metadata.mimeType, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff','Accept-Ranges':'bytes',ETag:etag };
                const selected=req.method==='HEAD'||req.headers['if-range']&&req.headers['if-range']!==etag?null:rangeFor(req.headers.range,bytes.length);
                if(selected===false){res.writeHead(416,{...headers,'Content-Length':0,'Content-Range':'bytes */'+bytes.length});res.end();return true;}
                if(selected){headers['Content-Length']=selected.end-selected.start+1;headers['Content-Range']='bytes '+selected.start+'-'+selected.end+'/'+bytes.length;}
                res.writeHead(selected?206:200,headers);
                res.end(req.method === 'HEAD' ? undefined : selected?bytes.subarray(selected.start,selected.end+1):bytes);
                return true;
            }
            const draft = pathname.match(/^\/api\/nova\/storage\/drafts\/([^/]+)$/);
            if (draft && req.method === 'GET') {
                sendJson(res, 200, { draft: store.getDraft(decodeURIComponent(draft[1])) });
                return true;
            }
            if (draft && req.method === 'PUT') {
                sendJson(res, 200, { draft: store.putDraft(decodeURIComponent(draft[1]), await jsonBody(req)) });
                return true;
            }
            const setting = pathname.match(/^\/api\/nova\/storage\/settings\/([^/]+)$/);
            if (setting && req.method === 'GET') {
                sendJson(res, 200, { setting: store.getSetting(decodeURIComponent(setting[1])) });
                return true;
            }
            if (setting && req.method === 'PUT') {
                sendJson(res, 200, { setting: store.putSetting(decodeURIComponent(setting[1]), await jsonBody(req)) });
                return true;
            }
            if (pathname === '/api/nova/storage/tasks' && req.method === 'GET') {
                sendJson(res, 200, store.listTasks({ limit: Number(searchParams.get('limit') || 50), offset: Number(searchParams.get('offset') || 0), ...Object.fromEntries(['kind','search','model','status'].map(key => [key, searchParams.get(key) || ''])) }));
                return true;
            }
            if (pathname === '/api/nova/storage/submissions') {
                if (req.method === 'GET') sendJson(res, 200, { items: store.submissions() });
                else if (req.method === 'POST') { const input = await jsonBody(req); if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INPUT_INVALID'); const auth = getConnections().getAuth(input.connectionVersionId); sendJson(res, 201, { input: store.prepareSubmission(input, auth, store) }); }
                else throw fail('STORAGE_METHOD_NOT_ALLOWED');
                return true;
            }
            const submission = pathname.match(/^\/api\/nova\/storage\/submissions\/([^/]+)$/);
            if (submission && req.method === 'DELETE') { sendJson(res, 200, store.dismissSubmission(submission[1])); return true; }
            const attempt = pathname.match(/^\/api\/nova\/storage\/submissions\/([^/]+)\/attempt$/);
            if (attempt && req.method === 'POST') { const input = await jsonBody(req); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw fail('INVALID_STORAGE_INPUT'); sendJson(res, 200, store.markSubmissionAttempt(attempt[1])); return true; }
            const task = pathname.match(/^\/api\/nova\/storage\/tasks\/([^/]+)$/);
            if (task && req.method === 'GET') {
                const result = store.getTask(task[1]); if (!result) throw fail('TASK_NOT_FOUND', '找不到任务。', 404);
                sendJson(res, 200, { task: result }); return true;
            }
            if (task && req.method === 'DELETE') {
                const input = await jsonBody(req);
                if (!input || Object.keys(input).some(key => key !== 'deleteOutputs')) throw fail('INVALID_STORAGE_INPUT');
                sendJson(res, 200, store.removeHistory(task[1], input)); return true;
            }
            const events = pathname.match(/^\/api\/nova\/storage\/tasks\/([^/]+)\/events$/);
            if (events && req.method === 'GET') {
                sendJson(res, 200, { events: store.events(events[1]) });
                return true;
            }
            sendJson(res, 405, { code: 'STORAGE_METHOD_NOT_ALLOWED', error: '不支持此存储操作。' });
            return true;
        }
        catch (error) {
            sendJson(res, error.statusCode || 500, { code: error.statusCode ? error.code : 'STORAGE_OPERATION_FAILED', error: error.statusCode ? error.message : '存储操作失败，已有记录和文件保留。' });
            return true;
        }
    };
}
module.exports = { createStorageHttp, rangeFor };
