'use strict';
// Codes/messages are deliberately independent of paths, remote URLs and response bodies.
const DETAILS = {
    AUTH_REJECTED: ['credential', '原连接版本鉴权被拒绝，下载已暂停。'],
    CREDENTIAL_REQUIRED: ['credential', '原连接版本凭据已清除，下载已暂停。'],
    CREDENTIAL_UNAVAILABLE: ['credential', '原连接版本凭据不可用，下载已暂停。'],
    RATE_LIMITED: ['download', '原任务资源刷新受限，请等待允许时间后重试。'],
    DOWNLOAD_INTERRUPTED: ['download', '上次下载已中断；可手动重新下载原任务结果。'],
    DOWNLOAD_TIMEOUT: ['download', '本次下载已达到时限；请检查网络或代理接管情况后重新下载。'],
    DOWNLOAD_CONNECTION_FAILED: ['download', '无法连接结果服务，请检查网络或代理接管情况后重新下载。'],
    DOWNLOAD_FAILED: ['download', '下载中断或服务暂不可用，请重试下载。'],
    DOWNLOAD_ACCESS_DENIED: ['download', '结果服务拒绝访问，请检查原结果权限或链接有效性；不会重新生成。'],
    DOWNLOAD_EXPIRED: ['download', '结果链接已过期；可查询原任务刷新，不能重新生成恢复。'],
    RESULT_NOT_RECOVERABLE: ['download', '原结果链接已失效或未保留，且无法通过原任务恢复；不会重新生成。'],
    DOWNLOAD_FORBIDDEN: ['download', '结果地址或重定向超出允许范围，已停止下载。'],
    DOWNLOAD_TOO_LARGE: ['download', '结果超出应用的单文件大小预算。'],
    DOWNLOAD_INCOMPLETE: ['download', '下载字节不完整，请重试下载。'],
    MEDIA_INVALID: ['media', '文件未通过完整媒体解码，不能作为已完成结果。'],
    MEDIA_VALIDATOR_UNAVAILABLE: ['media', '媒体解码器不可用，请修复应用后重试下载。'],
    DISK_FULL: ['storage', '磁盘空间不足，请释放空间后重试。'],
    FILE_BUSY: ['storage', '文件被占用，请关闭占用程序后重试。'],
    DIRECTORY_NOT_WRITABLE: ['storage', '输出目录不可写或已失效，请恢复该目录后重试。'],
    PATH_TOO_LONG: ['storage', '文件路径过长，请使用更短的目录。'],
    FILESYSTEM_ERROR: ['storage', '写入或发布文件失败，已有文件保留。'],
    ASSET_MISSING: ['storage', '本地文件缺失，作品记录已保留。'],
    ASSET_CORRUPT: ['storage', '本地文件与摘要不符，作品记录已保留。'],
    ASSET_FILE_CONFLICT: ['storage', '目标文件与受管摘要不一致，原文件已保留。'],
    ASSET_PATH_REJECTED: ['storage', '受管目录包含链接、联接或无效路径，请恢复原目录。'],
    OUTPUT_DIRECTORY_INVALID: ['storage', '任务输出目录版本无效。'],
    SAVE_TARGET_CHANGED: ['storage', '另存目标在确认后已改变，请重新选择。'],
};
function failure(code, cause) {
    const [phase, message] = DETAILS[code] || DETAILS.FILESYSTEM_ERROR;
    return Object.assign(new Error(message), { code: DETAILS[code] ? code : 'FILESYSTEM_ERROR', phase, statusCode: 409, cause });
}
function fileFailure(error) {
    if (DETAILS[error?.code]) return error;
    return failure(({ ENOSPC:'DISK_FULL', EDQUOT:'DISK_FULL', EBUSY:'FILE_BUSY', ETXTBSY:'FILE_BUSY', EPERM:'FILE_BUSY',
        EACCES:'DIRECTORY_NOT_WRITABLE', ENOENT:'DIRECTORY_NOT_WRITABLE', ENOTDIR:'DIRECTORY_NOT_WRITABLE', ENAMETOOLONG:'PATH_TOO_LONG' })[error?.code] || 'FILESYSTEM_ERROR', error);
}
module.exports = { DETAILS, failure, fileFailure };
