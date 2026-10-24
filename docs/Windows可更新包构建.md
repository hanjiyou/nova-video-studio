# Windows 可更新包构建（U01–U02）

日期：2026-10-24。本文保留 U01–U02 构建基线；U03–U05 运行时已获主审接受，U06–U08 本地新增范围见文末。未安装本批应用、启动生成服务、提交推送或发布。

## 固定决策与待决项

单一版本和安装身份定义为 `config/windows-update.json`。根 package.version 继续为 `3.4.0`，旧 `scripts/build-windows-test.ps1/.bat` 的 `3.4.0.n` 规则不改。更新构建通过 builder 的 `extraMetadata.version` 改写**产物内** package.version，应用 `app.getVersion()` 将按该值读取；本批未启动应用实测该调用。

| 字段 | 本地第一版 | 本地第二版 |
| --- | --- | --- |
| 应用 SemVer / latest.yml version | 3.5.0 | 3.5.1 |
| Windows buildVersion / FileVersion | 3.5.0.0 | 3.5.1.0 |
| 预留 tag 名（未创建） | v3.5.0 | v3.5.1 |
| installer ProductVersion | 3.5.0 | 3.5.1 |
| 应用 exe ProductVersion（builder 26.15.3） | 3.5.0.0 | 3.5.1.0 |
| 测试安装 appId | com.novaimage.studio.offline-test.followup-20261024 | 相同 |
| 测试 productName | Nova Studio T16 Followup | 相同 |

- 最低可更新版本规范为 `3.5.0`。旧版没有更新模块，必须手动安装完成 U03–U05 的 bootstrap 后才能应用内更新。本批产物 `runtimeReady=false`，是构建/校验基线，**尚不是具备更新操作的 bootstrap**。已成功的本地版本目录也不覆盖；后续接入运行时后用新版本验证。
- 正式身份仍为 `com.novaimage.studio` / `Nova Image Studio`。不从测试身份推定正式覆盖升级，不探测、读取或迁移旧资料；不改 package.name 或现有资料路径策略。
- 用户已选定公开仓库 `hanjiyou/nova-video-studio` 作为固定 GitHub feed（主审核实 public、仓库 ID 1430645673）。固定 `github` / `latest` / 正式 release；匿名读取公开产物，客户端无 Token。选择来源不等于授权发布。本批未创建 tag/Release、上传资产、改仓库可见性或改 main。
- **正式签名/发布者待决，本地未签名验证可以继续。** `signing.status=pending`、publisherNames 为空，release 构建会在任何文件写入前拒绝。正式签名改为 approved 并冻结发布者需另行审查；应采用完整 DN。匹配逻辑遵循 updater 6.8.11：DN 按字段匹配，不依赖字段顺序；纯显示名按 CN 匹配。未用真实证书验证签名或轮换，不关闭正式发布签名门槛，也未购买证书。
- 更新缓存目录固定为 `<appId>-updater`，区分正式与测试身份。builder 默认按共同的 package.name 生成缓存名；独立 `afterPack` hook 在其生成 app-update.yml 后，仅写入固定缓存身份。应用名、用户资料目录不改。

更新版本只支持稳定的三段 SemVer，拒绝第四段、前导零、`v` 前缀、prerelease 和 build metadata。各段不超过 Windows 的 65535。版本不自动递增，显式选择新版本；禁止同号覆盖。

## 稳定依赖与实际 API

锁定 npm `electron-updater@6.8.11`，registry 的 latest/v26 均为该版本；next 为 `7.0.0-alpha.11`，未使用。它与 builder 26.15.3 使用相同 `builder-util-runtime@9.7.0`，无原生 updater 模块或 Electron peer 约束。当前 Electron 为 43.4.0。这里只证明已安装、实际源码和构建相容，实际 Electron 更新生命周期留待 U03–U08 验证。

来源为安装包实际 `node_modules/electron-updater/out`，不是 master；包完整性、相关源码 SHA256 见 [source evidence](implementation/u01-u02/updater-source-evidence.json)。

| 已核实的 6.8.11 能力 | 下一批使用约束 |
| --- | --- |
| `checkForUpdates()`、`downloadUpdate()`、`quitAndInstall(isSilent?, isForceRunAfter?)` | 仅主进程调用，IPC 不接收任意 URL/路径。 |
| `autoDownload` 默认 true；`autoInstallOnAppQuit` 默认 true | 初始化即分别设为 false；不调用会触发下载的 checkForUpdatesAndNotify。普通退出不安装。 |
| `autoRunAppAfterInstall` 默认 true；`disableWebInstaller` 默认 false | 本项目是完整 NSIS，设 `disableWebInstaller=true`。重启语义须结合资料 override 另测。 |
| `disableDifferentialDownload` 默认 false | 保留差分尝试和原生全量回退，不能承诺每次差分或固定节省率。 |
| `checking-for-update`、`update-available`、`update-not-available`、`download-progress`、`update-downloaded`、`error` | 事件脱敏后再传受信 renderer；库事件本身不能证明安全安装或真实传输节省。 |
| BaseUpdater.quitAndInstall 先 install()/启动安装器，然后 setImmediate 发原生 `electron.autoUpdater` 的 `before-quit-for-update` 并 app.quit() | 先完成 U04 门闩、保存及清理，再显式调用；不是可 await 的安装完成 Promise。现 before-quit/app.exit 必须协调，不能在已有退出流程末尾随意追加。6.8.11 无 master 7 的 autoInstallEvent。 |
| 差分用当前旧安装器缓存、缓存或下载的旧 blockmap、新 blockmap 重建完整 exe；失败可全量下载 | bootstrap 手动安装不保证缓存齐备，必要时第三版验证差分。不要释放 unknown/paused 任务占位或重发 POST。 |
| GitHubProvider 设置 `isUseMultipleRangeRequest=false` | 可用多次单 Range；需后续对重定向来源、206/Content-Range、网络字节实测。 |
| NsisUpdater 在 app-update.yml 无 publisherName 时跳过发布者校验 | 仅本地未签名测试允许该边界；正式版必须具备发布者配置及有效 Authenticode，SHA512 不能替代签名。 |

运行时读取契约：打包后从受信 `app.getAppPath()/package.json` 的 `novaUpdate` 读取 schemaVersion/profile/version/windowsVersion/appId/productName/updaterCacheDirName/minimumUpdatableVersion/feed/signature/runtimeReady，并与 app.getVersion()、resources/app-update.yml 和安装形态核对。无 novaUpdate、runtimeReady=false、非 NSIS/portable 或不支持资料模式时禁止更新操作。不要从 renderer 接收 feed，也不要根据用户输入调用 setFeedURL。开发工作区的根 package 没有 novaUpdate，正常视为未启用。全局 runtimeReady 继续 false；新 local-test 测试包使用下述显式构建参数，不解锁正式签名或发布。

## 构建入口

依赖需先单独准备好；入口不安装依赖。要求 Windows、Node/npm、当前锁定 builder/Electron、前端构建工具与审计过的 Windows FFmpeg。先只读检查：

```powershell
npm run update:build:win -- --profile local-test --version 3.5.2 --test-feed-url http://127.0.0.1:18888/ --check-only
```

本地真实构建（选择尚不存在的 SemVer）：

```powershell
npm run update:build:win -- --profile local-test --version 3.5.2 --test-feed-url http://127.0.0.1:18888/
```

上述 3.5.2 示例现已占用，不可重跑覆盖。新建启用运行时的本地包需选择未用版本并附加 `--enable-test-runtime`，仅 local-test 且版本 >=3.5.2 接受。省略参数仍构建 runtimeReady=false；release 禁止此参数。已经生成 3.5.2、3.5.3（真实传输对）和 3.5.4（包含中文安装注册路径修正），不覆盖任一目录。

本地 generic 只能在明确 local-test 构建中使用，必须显式传 HTTP 的 `127.0.0.1` 或 `[::1]`、端口和以 `/` 结束的路径；拒绝远端 URL、凭据、查询和 fragment。构建时无须运行更新服务器。服务器需把该路径映射到选定新版本的 latest.yml 和 basename 文件，同时保留受支持旧版本 exe/blockmap；不能只把所有版本目录原样放上去便假定发现最新版本。真实本地单 Range 与原生回退证据见 [U06–U08](implementation/u06-u08/implementation.md)，真实 GitHub 分发仍待验。

正式构建入口为 `--profile release --version <新版本>`，禁止 test-feed-url；在签名待决时明确失败。未来还要求含未跟踪文件在内的干净已提交工作区；构建前与前端构建后核对相同 source commit，将 `{commit,clean:true}` 写入 update-plan、summary 及受安装器包含的 package.novaBuild。local-test 继续允许工作区未提交，旧包记录不加字段。今后即使满足构建门槛，该入口也始终 `--publish never`，不提供发布开关。

成功目录为 `release-updates/local-test/<SemVer>/`，含完整 exe、`.exe.blockmap`、builder 原生 `latest.yml`、`win-unpacked`、生成配置、update-plan.json、update-summary.json、build.log。这些大产物已由现有 `/release*/` 忽略规则排除。`update-summary.json` 是复验记录，不能替代三件更新资产。

真实构建先持有 `release-updates/.build.lock`，写入同一父目录唯一 `.attempt-*`，运行前端生产构建，再运行 builder 的 `--win nsis --x64 --publish never`。完整验证成功才原子提升至最终版本目录；目标存在即失败，不清空、不覆盖。失败 attempt 和日志保留、锁释放，重试使用新 attempt。若进程崩溃留下锁，先核实原进程已退出，再人工仅处理该锁文件。不要与旧本地脚本同时打包，共享前端构建目录不支持并行打包。

复验成功目录：

```powershell
npm run update:verify:win -- release-updates/local-test/3.5.0
npm run update:verify:win -- release-updates/local-test/3.5.1
```

复验仍从当前固定 policy 生成身份/feed/签名/工具规则，只允许保存记录中已知 runtimeReady 布尔历史差异，且 enabled local-test 必须>=3.5.2；其他 metadata 必须逐字段完全一致。实际 package/novaUpdate、app-update.yml 与完整重算 summary 仍须匹配，不直接信任记录自证。正式包额外逐字段核对包内 novaBuild 与 clean source 记录。没有每版硬编码白名单，也不重写旧 plan、summary 或安装器。继续校验不同安装身份缓存、完整 NSIS basename/version/size/SHA512、锁定 updater 解析结果、gzip blockmap 格式与每块 BLAKE2b 校验和覆盖总字节。当前锁定 builder 输出 version 2、单 file/offset=0、每块不超过 32768。最后检查 installer/app 的 Windows 版本资源与 Authenticode 状态。本地明确要求 NotSigned；正式要求 Valid 且发布者匹配。检查子进程清空 PSModulePath，避免 PS7 父进程让 PS5 Security 模块加载失败，不改持久环境。

## 本批验证与边界

定向测试：`npm run test:update:build`，34/34 通过。测试使用隔离临时目录和惰性字节 fixture，不执行安装器；fixture 的 blockmap/latest.yml 仍由锁定 builder 的实际生成函数产生。覆盖版本/feed限制、两版解析、缺失/篡改/混搭、manifest 路径、签名异常、PE版本、包内来源/凭据字段、零写入检查、并发锁、失败日志与禁止覆盖。模拟签名不等于证书验证。

真实构建/复验证据另见 [本批实施记录](implementation/u01-u02/implementation.md)。本批没有安装、启动应用、运行生成服务、读取真实 Key、使用付费调用、修改 APPDATA、迁移资料或发布。真实 GitHub 下载、Range/字节节省、已安装版本读取、三种资料模式、退出安装协作、草稿/任务恢复和签名证书轮换都未验证。U03–U08 和 T15/T16 最终、M5、FFmpeg 完整对应源码等门槛不因此通过；全量 tsc 已知错误和 lint 基线未重跑或宣称通过。

## U06–U08 本地补充

最新记录见 [U06–U08 本地实施与证据](implementation/u06-u08/implementation.md)，独立发布命令与故障处理见 [Windows 更新发布与验证](Windows更新发布与验证.md)。上述 34/34 和未验范围是 U01–U02 历史结果；后批 79/79 定向与 12 个真实本地网络场景另列，不回写原历史证据。
