'use strict';
// Host only: Electron safeStorage is the sole encryption provider. No plaintext fallback.
const { randomUUID } = require('node:crypto');
function credentialError(code) {
    return Object.assign(new Error(code === 'CREDENTIAL_REQUIRED' ? '请配置连接凭据。' : '系统凭据保护不可用，请重新保存凭据。'), { code, statusCode: 409, connectionError: true });
}
function createCredentialVault({ db, safeStorage }) {
    function available() {
        return Boolean(safeStorage?.isEncryptionAvailable()) && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    }
    function read(ref) {
        const row = ref && db.prepare('SELECT ciphertext FROM credential_entries WHERE id=? AND revoked_at IS NULL').get(ref);
        if (!row?.ciphertext)
            throw credentialError('CREDENTIAL_REQUIRED');
        if (!available())
            throw credentialError('CREDENTIAL_UNAVAILABLE');
        try {
            const value = safeStorage.decryptString(row.ciphertext);
            if (typeof value !== 'string' || !value || /\p{Cc}/u.test(value))
                throw new Error('Invalid decrypted credential');
            return value;
        }
        catch {
            throw credentialError('CREDENTIAL_UNAVAILABLE');
        }
    }
    return {
        store(value) {
            if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value.trim() !== value || /\p{Cc}/u.test(value))
                throw credentialError('CREDENTIAL_REQUIRED');
            if (!available())
                throw credentialError('CREDENTIAL_UNAVAILABLE');
            let ciphertext;
            try {
                ciphertext = safeStorage.encryptString(value);
            }
            catch {
                throw credentialError('CREDENTIAL_UNAVAILABLE');
            }
            if (!Buffer.isBuffer(ciphertext) || !ciphertext.length)
                throw credentialError('CREDENTIAL_UNAVAILABLE');
            const ref = randomUUID();
            db.prepare('INSERT INTO credential_entries(id,ciphertext,created_at) VALUES(?,?,?)').run(ref, ciphertext, new Date().toISOString());
            return ref;
        },
        read,
        state(ref) {
            try {
                read(ref);
                return 'ready';
            }
            catch (error) {
                return error.code === 'CREDENTIAL_REQUIRED' ? 'missing' : 'unavailable';
            }
        },
        revokeConnection(connectionId) {
            db.prepare(`UPDATE credential_entries SET ciphertext=NULL,revoked_at=? WHERE id IN
        (SELECT credential_ref FROM connection_versions WHERE connection_id=?) AND revoked_at IS NULL`).run(new Date().toISOString(), connectionId);
        },
    };
}
module.exports = { createCredentialVault };
