'use strict';
const ERROR_NAMES=new Set(['Error','TypeError','SyntaxError','ReferenceError','RangeError','DOMException','UnknownError','QuotaExceededError','SecurityError','AbortError','NotAllowedError']);
const SYSTEM_CODES=new Set(['ENOENT','EACCES','EPERM','EADDRINUSE','ENOMEM','EMFILE','ENOSPC','MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_DLOPEN_FAILED','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_ARG_TYPE','ERR_FAILED']);
const CATEGORIES=new Set(['unknown','filesystem','module-load','native-library','javascript','browser-storage','browser-error','graphics','network','webassembly']);
const SERVICE_PHASES=new Set(['entry','profile','imports','plugins','projects','listen','ready']);
const EDITOR_CODES=new Set('EDITOR_RUNTIME_UNAVAILABLE EDITOR_DEPENDENCIES_MISSING EDITOR_BUILD_MISSING EDITOR_VERSION_MISMATCH EDITOR_NODE_UNSUPPORTED EDITOR_SERVICE_FAILED EDITOR_SERVICE_EXITED EDITOR_START_TIMEOUT EDITOR_INVALID_ORIGIN EDITOR_LOAD_FAILED EDITOR_RENDERER_EXITED EDITOR_WINDOW_UNAVAILABLE EDITOR_INVALID_VIEWPORT EDITOR_STOPPED EDITOR_CREDENTIALS_NOT_READY EDITOR_RUNTIME_NOT_PACKAGED EDITOR_SOURCE_MISSING EDITOR_RUNTIME_INVALID EDITOR_BUILD_INVALID EDITOR_PRECHECK_FAILED EDITOR_START_FAILED EDITOR_CREDENTIAL_BRIDGE_NOT_READY'.split(' '));
function errorFields(error){const result={};if(ERROR_NAMES.has(error?.name))result.errorName=error.name;if(SYSTEM_CODES.has(error?.code))result.systemCode=error.code;return result;}
function classifyText(value){const text=typeof value==='string'?value:'';const result={category:'unknown'};
  for(const code of SYSTEM_CODES)if(new RegExp('(?:^|[^A-Z_])'+code+'(?:[^A-Z_]|$)').test(text)){result.systemCode=code;break;}
  for(const name of ERROR_NAMES)if(new RegExp('(?:^|[^A-Za-z])'+name+':').test(text)){result.errorName=name;break;}
  if(/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(text))result.category='module-load';
  else if(/ERR_DLOPEN_FAILED|native module|\.node\b/i.test(text))result.category='native-library';
  else if(/ENOENT|EACCES|EPERM|ENOSPC|EMFILE/.test(text))result.category='filesystem';
  else if(/indexeddb|\bIDB(?:Database|Factory|Transaction)|QuotaExceededError/i.test(text))result.category='browser-storage';
  else if(/WebGL|GPU|shader/i.test(text))result.category='graphics';
  else if(/WebAssembly|\bWASM\b/i.test(text))result.category='webassembly';
  else if(/ERR_(?:CONNECTION|NAME|TIMED)|Failed to fetch|NetworkError/i.test(text))result.category='network';
  else if(['TypeError','SyntaxError','ReferenceError','RangeError'].includes(result.errorName))result.category='javascript';
  else if(result.errorName)result.category='browser-error';
  return result;
}
module.exports={ERROR_NAMES,SYSTEM_CODES,CATEGORIES,SERVICE_PHASES,EDITOR_CODES,errorFields,classifyText};
