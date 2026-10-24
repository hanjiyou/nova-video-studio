# U01–U02 本地实施记录

日期：2026-10-24。基线：dev / `8a14f9ef6210bce55a8a937914d68867404a9459`。本批保留未提交改动交主审；未 commit/push/publish，未安装或运行应用。

## 交付

- 精确新增 `electron-updater@6.8.11` 生产依赖；npm registry latest/v26=6.8.11，next=7.0.0-alpha.11。无无关版本升级；新增 updater 及其必要依赖，原已存在共享包从 dev 标记变为生产依赖是打包所需。安装使用 `--ignore-scripts --no-audit --no-fund`，未运行生命周期服务。包/source SHA256 与 registry integrity 见 [source evidence](updater-source-evidence.json)。
- `config/windows-update.json` 为单一策略与版本定义。旧根 package.version=3.4.0、旧四段测试打包入口保留。新产物 extraMetadata.version 与 latest.yml 对齐；Windows buildVersion 从相同 SemVer 推导 `.0`。测试安装 appId/productName 保持 followup 身份，正式身份分开，不迁移资料。
- 用户选择的固定 feed 为公开 `hanjiyou/nova-video-studio`；配置无 Token。本地构建使用明确的 loopback generic；正式签名仍 pending，release 构建拒绝。该状态不阻止后续本地运行时开发。
- `electron-builder.update.yml`、build/verify/finalize 脚本及 lib 单独支撑更新构建。执行 `--publish never`；保留完整 exe/blockmap/builder latest.yml，并校验版号、哈希、大小、路径、块覆盖、包内策略、固定 feed/缓存、PE 版本和 Authenticode 边界。正式/测试缓存按 appId 分离，package.name 和资料目录不改。
- 细节与下一批接口见 [Windows 可更新包构建](../../Windows可更新包构建.md)。本批未触碰 desktop 运行时、frontend/backend 业务、旧本地脚本或 docs/验收原始证据。

## 执行与结果

| 命令（仓库根） | 结果 |
| --- | --- |
| `node --test scripts/windows-update.test.cjs` | 34 tests、34 pass、0 fail、0 skipped；主审另独立运行同样 34/34。 |
| `node scripts/build-windows-update.cjs --profile local-test --version 3.5.0 --test-feed-url http://127.0.0.1:18888/ --check-only` | 成功、未写入/构建/预留版本。 |
| `node scripts/build-windows-update.cjs --profile release --check-only` | 预期拒绝：Release signing/publisher decision is pending；无构建写入。 |
| `node scripts/build-windows-update.cjs --profile local-test --version 3.5.0 --test-feed-url http://127.0.0.1:18888/` | Next production 与 NSIS 构建成功；初次末段验证失败，按下述事实修正后对原字节复验、提升成功目录。 |
| `node scripts/build-windows-update.cjs --profile local-test --version 3.5.1 --test-feed-url http://127.0.0.1:18888/` | 全流程成功；Next production、builder、完整验证与原子提升退出 0。 |
| `node scripts/verify-windows-update.cjs release-updates/local-test/3.5.0` | 主审独立复验退出 0。 |
| `node scripts/verify-windows-update.cjs release-updates/local-test/3.5.1` | 独立复验退出 0。 |
| `git -c safe.directory=E:/Learn/AI/nova-image-studio diff --check` | 退出 0；仅 package.json 既有 Git LF/CRLF 提示。 |

实际构建均是当前含未提交改动的工作区。前端生产构建的 TypeScript 步骤通过只代表该构建检查；未宣称仓库全量 tsc/lint 通过，原有约 60 个全量 tsc 错误与 lint 基线不在本批修复。

| 真实产物 | installer bytes | blockmap chunks | 签名 | 状态 |
| --- | --- | --- | --- | --- |
| `release-updates/local-test/3.5.0/Nova-Studio-3.5.0-update-test-x64.exe` | 133744924 | 6376 | installer/app 均 NotSigned | 原生清单/整包 SHA512/每块及覆盖总字节通过；未安装。 |
| `release-updates/local-test/3.5.1/Nova-Studio-3.5.1-update-test-x64.exe` | 133744956 | 6370 | installer/app 均 NotSigned | 原生清单/整包 SHA512/每块及覆盖总字节通过；未安装。 |

可追溯副本：[3.5.0 summary](artifacts-3.5.0.json)、[3.5.1 summary](artifacts-3.5.1.json)、[builder 3.5.0 latest](latest-3.5.0.yml)、[builder 3.5.1 latest](latest-3.5.1.yml)、[3.5.0 log](build-3.5.0.log)、[3.5.1 log](build-3.5.1.log)。三件更新资产本体位于上述被 git 忽略的版本目录，不进源码提交。

3.5.0 初次末段校验暴露两项环境/格式事实：PS7 父进程的 PSModulePath 会使 PS5 Microsoft.PowerShell.Security 自动加载失败；子进程清空该变量后可正常读取 Authenticode。builder 26.15.3 的应用 exe ProductVersion 实际为四段 `3.5.0.0`，installer ProductVersion 为三段 `3.5.0`，两者 FileVersion 都是 `3.5.0.0`；校验按锁定工具实际输出核对。修复后未改 exe/blockmap/latest.yml 原字节，对既有完整 attempt 全量复验成功后才同父目录原子提升至 3.5.0；build.log 保留初次失败与重验说明。3.5.1 在修复后完整成功。

真实 blockmap 证明当前校验接受锁定 builder 的 gzip/version=2/单 file、offset=0、块 <=32768 格式；两版累计 12746 个块的 BLAKE2b(18 bytes) 校验与总大小一致。该检查不代表实际差分下载成功。

## 下一批契约与保留项

U03 从受信包内 package.novaUpdate 读取固定身份/feed/signature/最低版和 runtimeReady；当前为 false，工作区无元数据时也禁用。先配置 `autoDownload=false`、`autoInstallOnAppQuit=false`、`disableWebInstaller=true`。仅主进程更新服务调用 check/download，窄 IPC 不接收 URL 或任意路径。U04 必须在 quitAndInstall 前完成可证明的草稿保存、阻止派发、媒体/数据库关闭，协调 before-quit/app.exit；6.8.11 不存在 autoInstallEvent，quitAndInstall 也不是安装完成 Promise。详情在构建说明的实际 API 表。

下一批无需等待正式证书即可用隔离 mock 和受限本地 feed 开发/验证；正式构建和发布仍受待决签名门槛约束。请保留本批输出，不覆盖已用的 3.5.0/3.5.1；接入运行时后的安装测试另选新版本。旧应用手动安装 bootstrap、缓存缺失可能全量、必要时第三版验差分的规则保留。

未验证：真实 app.getVersion() 调用、安装/卸载/重启、现 NSIS 崩溃根因、网络下载/Range/重定向与真实节省、GitHub 分发、签名证书/轮换、三种资料模式、草稿与任务恢复、无额外 POST。两版本批均 `runtimeReady=false`，不能用作已实现更新功能的 bootstrap。U01 不标全部完成，U02 仅本地构建/校验本地范围已获主审接受，U03–U08 未实施；T15/T16 最终、M5 和 FFmpeg 完整对应源码材料门槛不提升。

主审结论：已独立运行 34/34 定向测试，并分别复验 3.5.0、3.5.1；接受 U01 技术基线和 U02 本地构建范围。正式签名待决、U03–U08 未实施/未验边界保持；本批不提交推送。
