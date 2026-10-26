'use strict';
const { BASES } = require('./route-policy');
const IMAGE_MODEL = 'gpt-image-2.5-flare';
const REFERENCE_GROUP = '【生图分组】Image2原生-中质量';
const unavailable = reason => ({ model: IMAGE_MODEL, group: REFERENCE_GROUP, estimate: null, reason });
const finiteNonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Public pricing data is never executable. Only the confirmed fixed-per-image shape is supported. */
function parseImagePricing(payload) {
    if (!object(payload) || payload.success === false || !Array.isArray(payload.data) || payload.data.length > 5000)
        return unavailable('PRICING_INVALID');
    const matches = payload.data.filter(item => object(item) && item.model_name === IMAGE_MODEL);
    if (matches.length !== 1) return unavailable(matches.length ? 'PRICING_INVALID' : 'MODEL_NOT_PRICED');
    const entry = matches[0], price = entry.model_price;
    if (entry.quota_type !== 1 || !finiteNonnegative(price)) return unavailable('BILLING_UNSUPPORTED');
    const expression = entry.billing_expr;
    if (entry.billing_mode !== undefined && entry.billing_mode !== 'tiered_expr') return unavailable('BILLING_UNSUPPORTED');
    if (expression !== undefined) {
        if (typeof expression !== 'string' || expression.length > 200) return unavailable('BILLING_UNSUPPORTED');
        const fixed = expression.match(/^\s*tier\(\s*"image"\s*,\s*fixed\(\s*((?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*\)\s*\)\s*\*\s*image_count\s*$/);
        if (!fixed || !finiteNonnegative(Number(fixed[1])) || Number(fixed[1]) !== price) return unavailable('BILLING_UNSUPPORTED');
    } else if (entry.billing_mode === 'tiered_expr') return unavailable('BILLING_UNSUPPORTED');
    const groups = entry.enable_groups;
    if (!Array.isArray(groups) || !groups.length || groups.length > 1000 ||
        groups.some(group => typeof group !== 'string' || !group || group.length > 200) ||
        new Set(groups).size !== groups.length || !object(payload.group_ratio)) return unavailable('GROUP_PRICING_INVALID');
    if (!groups.includes(REFERENCE_GROUP) || !Object.hasOwn(payload.group_ratio, REFERENCE_GROUP) ||
        !finiteNonnegative(payload.group_ratio[REFERENCE_GROUP])) return unavailable('GROUP_PRICING_INVALID');
    const ratio = payload.group_ratio[REFERENCE_GROUP], amount = price * ratio;
    if (!finiteNonnegative(amount) || (price > 0 && ratio > 0 && amount === 0)) return unavailable('GROUP_PRICING_INVALID');
    return { model: IMAGE_MODEL, group: REFERENCE_GROUP, estimate: { perImage: amount }, reason: null };
}

/** Public, credential-free snapshots. A scope initializes once; model refresh explicitly replaces it. */
function createImagePricing({ fetchImpl, timeoutMs = 8000, maxBytes = 1024 * 1024 }) {
    const slots = new Map();
    async function load(route) {
        const controller = new AbortController();
        let timer, activeReader;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); void activeReader?.cancel().catch(() => {}); reject(Error('PRICING_UNAVAILABLE')); }, timeoutMs);
        });
        const read = async () => {
            const url = new URL('/api/pricing', BASES[route]);
            const response = await fetchImpl(url.href, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
            if (controller.signal.aborted || response.status !== 200 || response.redirected) {
                void response.body?.cancel().catch(() => {});
                return unavailable('PRICING_UNAVAILABLE');
            }
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
                void response.body?.cancel().catch(() => {});
                return unavailable('PRICING_INVALID');
            }
            if (!response.body) return unavailable('PRICING_INVALID');
            const reader = response.body.getReader(), chunks = [];
            activeReader = reader;
            let size = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > maxBytes) {
                        void reader.cancel().catch(() => {});
                        return unavailable('PRICING_INVALID');
                    }
                    chunks.push(Buffer.from(value));
                }
            } finally { reader.releaseLock(); }
            try { return parseImagePricing(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { return unavailable('PRICING_INVALID'); }
        };
        try { return await Promise.race([read(), timeout]); }
        catch { return unavailable('PRICING_UNAVAILABLE'); }
        finally { clearTimeout(timer); controller.abort(); }
    }
    return async (route, { scope = route, force = false } = {}) => {
        if (!Object.hasOwn(BASES, route)) return { ...unavailable('PRICING_UNSUPPORTED'), cached: false };
        const key = route + ':' + scope;
        let slot = slots.get(key);
        if (!slot) {
            // Keep memory bounded without evicting work that is still being merged.
            if (slots.size >= 64) {
                const oldest = [...slots].find(([, value]) => !value.pending);
                if (!oldest) return { ...unavailable('PRICING_UNAVAILABLE'), cached: false };
                slots.delete(oldest[0]);
            }
            slot = {}; slots.set(key, slot);
        }
        if (slot.pending) return { ...await slot.pending, cached: false };
        if (slot.value && !force) return { ...slot.value, cached: true };
        slot.value = null;
        slot.pending = load(route).then(value => { slot.value = value; return value; });
        try { return { ...await slot.pending, cached: false }; }
        finally { slot.pending = null; }
    };
}
module.exports = { IMAGE_MODEL, REFERENCE_GROUP, parseImagePricing, createImagePricing };
