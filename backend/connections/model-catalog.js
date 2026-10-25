'use strict';
const RULES = require('./model-rules.json');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const TYPES = new Set(['image-generation','image-editor','video-generation','video','chat-completions','responses','openai','anthropic','gemini']);
function entries(value) {
    if (!Array.isArray(value)) return [];
    const map = new Map();
    for (const raw of value) {
        const model = typeof raw === 'string' ? raw : raw?.id || raw?.model;
        if (typeof model !== 'string' || !ID.test(model)) continue;
        const types = raw?.supported_endpoint_types || raw?.endpointTypes || [];
        map.set(model, { model, endpointTypes: Array.isArray(types) ? [...new Set(types.filter(t => TYPES.has(t)))] : [] });
    }
    return [...map.values()];
}
function classify(model, endpointTypes = [], override) {
    if (override) return { categories: override, classificationSource: 'user' };
    const categories = [];
    if (endpointTypes.some(t => ['image-generation','image-editor'].includes(t))) categories.push('image');
    if (endpointTypes.some(t => ['video-generation','video'].includes(t))) categories.push('video');
    if (categories.length) return { categories, classificationSource:'endpoint' };
    if (/^(gpt-image-|grok-imagine-image(?:-|$)|gemini-[a-z0-9.-]*image(?:-|$)|(?:doubao-)?seedream(?:-|$)|qwen-image(?:-|$))/i.test(model)) return { categories:['image'], classificationSource:'name' };
    if (/^(grok-imagine-video(?:-|$)|sora(?:-|$)|veo(?:-|$))/i.test(model)) return { categories:['video'], classificationSource:'name' };
    return { categories:[], classificationSource:'unknown' };
}
function videoRule(model, scope) { return scope?.provider === RULES.provider && (scope.baseUrl || scope.base_url) === RULES.baseUrl ? RULES.models[model] || null : null; }
function validSize(size) { if (typeof size !== 'string' || !/^[1-9][0-9]*x[1-9][0-9]*$/.test(size)) return false; return size.split('x').every(n => Number.isSafeInteger(Number(n)) && Number(n) > 0); }
function validParameters(rule, p) { return Boolean(rule && p && Number.isInteger(p.seconds) && p.seconds >= rule.minSeconds && p.seconds <= rule.maxSeconds && Object.keys(p).every(k => (rule.sendSize ? ['seconds','size'] : ['seconds']).includes(k)) && (rule.sendSize ? validSize(p.size) : !Object.hasOwn(p,'size'))); }
function modelRejected(payload, status) {
    if (![400,404,410,422].includes(status)) return false;
    const code = payload?.error?.code || payload?.error?.type || payload?.code;
    return ['model_not_found','model_not_available','model_unavailable','model_disabled','model_deactivated'].includes(code);
}
module.exports = { RULES, ID, entries, classify, videoRule, validSize, validParameters, modelRejected };
