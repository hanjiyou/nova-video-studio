'use strict';
// Keep startup failures visible without echoing paths, credentials or raw service errors.
function reportStartupFailure({ dialog, error, log = console.error }) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,50}$/.test(error.code) ? error.code : 'STARTUP_FAILED';
  log('Nova Studio 启动失败：' + code);
  dialog.showErrorBox('影像工作台启动失败', '暂时无法初始化本机数据或后台服务。\n请检查保存目录权限、可用磁盘空间，或关闭占用相同数据目录的应用后重试。\n已有任务与作品不会被自动删除。\n错误代码：' + code);
}
module.exports = { reportStartupFailure };
