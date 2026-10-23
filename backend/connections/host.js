'use strict';
// Main-process injection only; no route or environment variable can configure a vault.
let factory = null;
function configureConnectionHost(createVault) {
    if (factory || typeof createVault !== 'function')
        throw new Error('Connection host already configured or invalid');
    factory = createVault;
}
const unavailable = () => { throw Object.assign(new Error('系统凭据保护不可用。'), { code: 'CREDENTIAL_UNAVAILABLE', statusCode: 409, connectionError: true }); };
function createHostVault(db) {
    return factory ? factory(db) : { store: unavailable, read: unavailable, state: ref => ref ? 'unavailable' : 'missing', revokeConnection: unavailable };
}
module.exports = { configureConnectionHost, createHostVault };
