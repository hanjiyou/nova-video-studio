'use strict';
// Only machine codes, never messages, URLs, headers or arbitrary nested objects.
const CATEGORIES = new Set(['dns','connection_refused','connection_reset','tls','timeout','aborted','http','disk_full','file_permission','file_busy','checksum','signature','unknown']);
function classifyError(error) {
  let current = error;
  for (let depth=0; current && depth<4; depth++,current=current.cause) {
    const code=current.code;
    if(['ENOSPC','DISK_FULL'].includes(code))return 'disk_full';
    if(['EACCES','EPERM','DIRECTORY_NOT_WRITABLE'].includes(code))return 'file_permission';
    if(['EBUSY','FILE_BUSY'].includes(code))return 'file_busy';
    if(['ERR_CHECKSUM_MISMATCH','ERR_UPDATER_NO_CHECKSUM'].includes(code))return 'checksum';
    if(code==='ERR_UPDATER_INVALID_SIGNATURE')return 'signature';
    if (['ENOTFOUND','EAI_AGAIN'].includes(code)) return 'dns';
    if (code==='ECONNREFUSED') return 'connection_refused';
    if (['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code)) return 'connection_reset';
    if (['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_PROTOCOL_ERROR'].includes(code)) return 'tls';
    if (['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code) || current.name==='TimeoutError') return 'timeout';
    if (current.name==='AbortError'||code==='ABORT_ERR') return 'aborted';
  }
  const status=error?.httpStatus??error?.statusCode;
  return Number.isInteger(status)&&status>=400&&status<=599?'http':'unknown';
}
module.exports={classifyError,CATEGORIES};
