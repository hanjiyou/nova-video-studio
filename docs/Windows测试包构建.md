# Windows 测试包构建

在已准备好项目依赖的 Windows 机器上运行。脚本构建**当前工作区，包含尚未提交的改动**；从脚本所在位置定位仓库，可从任意目录调用。支持 Windows PowerShell 5.1 和 PowerShell 7。

以下命令仅为当前 PowerShell 进程放行脚本执行，不更改持久执行策略。PowerShell 7 可将 `powershell.exe` 换为 `pwsh.exe`。先执行只读检查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Learn\AI\nova-image-studio\scripts\build-windows-test.ps1' -CheckOnly
```

正式构建测试安装包：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Learn\AI\nova-image-studio\scripts\build-windows-test.ps1'
```

默认构建版本 `3.4.0.18`，输出到仓库内 `release-multi-reference/3.4.0.18/`。可指定其他构建版本及含空格的输出目录；相对输出路径以仓库为基准：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Learn\AI\nova-image-studio\scripts\build-windows-test.ps1' -BuildVersion '3.4.0.19' -OutputDirectory 'D:\Nova Test Packages\3.4.0.19'
```

脚本先运行前端生产构建，成功后使用本地 `electron-builder.cmd`、`electron-builder.offline-followup.yml` 构建 Windows NSIS x64。保留该配置的 appId/productName 测试身份；只覆盖构建文件版本、安装包名称、输出目录和卸载显示名称，应用内部 package 版本不变。

输出包括安装器 `Nova-Studio-<构建版本>-offline-test-x64.exe`、同名 `.sha256` 文本以及只含版本、安装包名称、SHA256 的 `build-summary.json`。目标安装器已存在或输出目录非空时拒绝执行，请换版本/目录；历史 `3.4.0.17` 版本保留，不允许重新构建。脚本不清空目录。

`-CheckOnly` 不创建输出、不执行构建。实际构建出错会停止并返回非零退出码，工作目录会恢复。脚本不自动安装依赖、安装/启动应用或发布；如缺少本地工具，先单独准备环境。生成摘要只用于文件核对，不表示代码签名、完整验收或 FFmpeg 对应源码材料已齐备。