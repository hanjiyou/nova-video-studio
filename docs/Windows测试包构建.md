# Windows 测试包构建

在已准备好依赖的 Windows 机器上，双击 `scripts\build-windows-test.bat` 即可构建当前工作区（包含未提交改动）。脚本从自身位置定位仓库，可从任意目录调用；支持 Windows PowerShell 5.1 和 PowerShell 7。

2026-10-24 已先同步完善规划，经主会话审核后实施。本轮代码审核与离线模拟验证通过；主审已独立查看 25/25 结果。实际打包未做，改动尚未提交或推送。

## 双击入口和输出位置

真实构建成功后，批处理自动打开最终输出目录，并显示成功提示；失败显示错误与日志位置。两种结果均等待按键，方便查看信息，并保留 PowerShell 脚本的退出码。

默认输出位于仓库的 `release-multi-reference\<构建版本>\`。例如首次可用版本为 `3.4.0.18` 时，安装包为：

```text
E:\Learn\AI\nova-image-studio\release-multi-reference\3.4.0.18\Nova-Studio-3.4.0.18-offline-test-x64.exe
```

版本从 `3.4.0.18` 起自动选择。脚本查看默认输出根中安装器、成功摘要和校验文本齐备的版本，递增 `3.4.0` 的最后一位。候选最终路径已存在时，无论是文件、空目录还是不完整历史目录，都保留并跳过；不会覆盖或清空已有输出。历史 `3.4.0.17` 不允许重新构建。

每次真实构建先写入同一输出根下唯一的 `.attempt-<版本>-<时间>-<标识>\`。前端构建、打包输出和错误保存在其中的 `build.log`。失败后 attempt 和日志保留，最终版本目录不出现；下次重试同一个候选版本，使用新的 attempt。安装器存在且非空、SHA256 与摘要保存成功后，完整 attempt 才原子重命名为最终版本目录。

例如 `.18` 成功后，下次选择 `.19`；`.19` 构建失败，下次仍尝试 `.19`。若 `.19` 最终路径已被其他内容占用，则保护该路径并选择下一个空闲版本。构建期间持有输出根的文件独占锁；其他构建在同一根上冲突时清楚报错。退出会释放锁，空的 `.nova-build.lock` 文件可以保留。

## 仅检查环境

先执行只读检查，不构建、不创建文件或目录、不占用版本，也不打开资源管理器：

```bat
"E:\Learn\AI\nova-image-studio\scripts\build-windows-test.bat" -CheckOnly
```

检查显示预计版本和安装器位置，实际构建时会重新选择并核对目标。若不希望等待按键，直接使用 PowerShell 入口；以下只对当前进程放行执行策略，不更改持久设置：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Learn\AI\nova-image-studio\scripts\build-windows-test.ps1' -CheckOnly
```

PowerShell 7 将 `powershell.exe` 换为 `pwsh.exe`。

## 指定版本或目录

保留 `-BuildVersion` 与 `-OutputDirectory`，含空格路径须加引号；相对目录以仓库为基准。显式指定的最终路径已存在时会报错，不自动替用户换目录或版本，即使目录为空也不覆盖。

```bat
"E:\Learn\AI\nova-image-studio\scripts\build-windows-test.bat" -BuildVersion 3.4.0.40 -OutputDirectory "D:\Nova Test Packages\version 40"
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\Learn\AI\nova-image-studio\scripts\build-windows-test.ps1' -BuildVersion '3.4.0.40' -OutputDirectory 'D:\Nova Test Packages\version 40'
```

只指定版本时，输出仍为默认根下该版本目录；只指定目录时，使用当前默认序列选择的版本，但目标冲突会报错。自定义输出的 attempt 与最终目录使用同一父目录，便于原子提升。**保存在默认输出根以外的自定义成功包不计入默认自动递增序列**；默认序列只查看 `release-multi-reference` 的直接子版本目录。

直接运行 PowerShell 默认不打开目录；可加 `-OpenOutput` 在真实成功后打开。批处理已自动传入该选项；`-CheckOnly` 始终不打开目录。

## 构建范围与验证

脚本先运行前端生产构建，成功后用本地 `electron-builder.cmd`、`electron-builder.offline-followup.yml` 构建 Windows NSIS x64。保留配置的 appId/productName 测试身份，只指定构建文件版本、安装包名称、输出目录和卸载显示名称；不改变 package 中的应用版本。

成功输出包括 `Nova-Studio-<版本>-offline-test-x64.exe`、同名 `.sha256`、只含版本/安装包名称/SHA256 的 `build-summary.json`、`build.log` 和打包工具的其他产物。失败返回非零退出码，恢复原工作目录，保留 attempt 日志。发生输入冲突、锁冲突等尚未进入构建的错误时，会说明没有创建 attempt 日志。

本轮使用临时隔离 fixture、假的 npm/builder 和目录打开接口进行 25 个场景验证，全部通过：PowerShell 5.1/7 下的递增、失败重试、前端和打包 stderr/退出码、日志保留、历史/显式/后占用保护、并发锁与释放、空格路径、CheckOnly 零写入，以及批处理暂停、成功开目录请求和失败退出码。主会话另在真实仓库执行了 PS5.1 `-CheckOnly`，选中 `3.4.0.18`；未构建。

脚本不自动安装依赖、安装或启动应用、发布、读取真实 Key 或修改应用用户数据。如缺少本地工具，先单独准备环境。摘要用于文件核对，不表示代码签名、完整产品验收或 FFmpeg 完整对应源码材料已经齐备。本轮不提升 T15/T16 最终、M5 或公开发行结论。
