'use strict';
function containsCredential(value, credential) {
    if (!credential || typeof value !== 'string') return false;
    let candidate = value;
    for (let depth = 0; depth < 3; depth++) {
        if (candidate.includes(credential)) return true;
        if (depth === 2) break;
        // Decode valid percent bytes independently: unrelated malformed escapes or
        // invalid UTF-8 must not prevent detection of a recoverable known secret.
        const decoded = candidate.replace(/(?:%[0-9a-f]{2})+/gi, bytes =>
            Buffer.from(bytes.match(/[0-9a-f]{2}/gi).map(byte => parseInt(byte, 16))).toString('utf8'));
        if (decoded === candidate) break;
        candidate = decoded;
    }
    return false;
}
module.exports = { containsCredential };
