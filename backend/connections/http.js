'use strict';
function createConnectionHttp({ getService, readJsonBody, sendJson }) {
    return async (req, res, pathname) => {
        if (!pathname.startsWith('/api/nova/connections'))
            return false;
        const service = getService();
        if (!service)
            return false;
        try {
            if (req.method === 'GET' && pathname === '/api/nova/connections') {
                sendJson(res, 200, { connections: service.list(), currentConnection: service.current() });
                return true;
            }
            if (req.method === 'GET' && pathname === '/api/nova/connections/current') {
                sendJson(res, 200, { connection: service.current() });
                return true;
            }
            const match = pathname.match(/^\/api\/nova\/connections\/([^/]+)(\/models|\/check|\/model-settings|\/model-display|\/pricing)?$/);
            if (match?.[2] === '/pricing' && req.method === 'GET') {
                sendJson(res, 200, await service.pricing(match[1], { model: new URL(req.url, 'http://localhost').searchParams.get('model') ?? undefined }));
                return true;
            }
            if (match?.[2] === '/model-display' && req.method === 'GET') {
                sendJson(res,200,service.models(match[1]));return true;
            }
            if (match?.[2] === '/model-display' && req.method === 'PUT') {
                sendJson(res,200,service.updateModelDisplay(match[1],await readJsonBody(req)));return true;
            }
            if (match && !['/check','/model-settings','/model-display','/pricing'].includes(match[2]) && req.method === 'GET') {
                sendJson(res, 200, match[2] === '/models' ? service.models(match[1]) : { connection: service.summary(match[1]) });
                return true;
            }
            if (match?.[2] === '/model-settings' && req.method === 'PUT') {
                sendJson(res,200,service.updateModelSettings(match[1],await readJsonBody(req)));return true;
            }
            if (match?.[2] === '/check' && req.method === 'POST') {
                sendJson(res, 200, await service.check(match[1], await readJsonBody(req)));
                return true;
            }
            sendJson(res, 405, { code: 'CONNECTION_METHOD_NOT_ALLOWED', error: '连接保存与凭据清除请使用受信桌面接口。' });
        }
        catch (error) {
            sendJson(res, error.connectionError ? error.statusCode : 500, { code: error.connectionError ? error.code : 'CONNECTION_OPERATION_FAILED', error: error.connectionError ? error.message : '连接操作失败。' });
        }
        return true;
    };
}
module.exports = { createConnectionHttp };
