'use strict';
/** An opaque ID must survive WHATWG URL parsing as exactly one non-special path segment.
 * Encoding "." as "%2E" is insufficient: the URL parser normalizes encoded dot segments too.
 */
function isQueryableUpstreamTaskId(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value === '.' || value === '..' ||
        [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) return false;
    try { encodeURIComponent(value); return true; } catch { return false; } // Reject unpaired UTF-16 surrogates.
}
function encodeUpstreamTaskId(value) {
    if (!isQueryableUpstreamTaskId(value)) throw Object.assign(new Error('上游标识无法安全表示为单一路径段。'), { code: 'INVALID_UPSTREAM_ID', statusCode: 400 });
    return encodeURIComponent(value);
}
module.exports = { isQueryableUpstreamTaskId, encodeUpstreamTaskId };
