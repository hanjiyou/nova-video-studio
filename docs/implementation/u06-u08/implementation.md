# U06–U08 发布准备、真实本地传输与安装预检

日期：2026-10-24。基线 dev / `8a14f9ef6210bce55a8a937914d68867404a9459`，叠加保留的前批未提交工作。此批只完成本地范围，保留未提交差异交主审；未 commit/push/upload/release，未运行安装器、未修改现有 nova-image 或原始验收证据、未读取真实 Key 或调用生成/付费接口。

## 交付和边界

- U06：独立 `release-windows-update.cjs`，默认 prepare dry-run；draft 创建/完整上传、upload 仅补缺件续传、verify 完整远端字节核验、publish 明确公开。所有 phase 省略 execute 都不联网、不读 Token。固定公开 owner/repo 和三资产/version/tag；相同版本/tag 已存在即拒绝新建，不删除/覆盖资产。上传中断保留 draft ID；续传前先校验已有全部资产，不替换不符资产。verify/publish 要求同一稳定 draft、完整三资产及相同字节。正式 signing/publisher/runtime 与原许可、FFmpeg、T15、M5、隔离安装门槛仍阻断。实际远端流程仅用模拟 API 测试，未在 GitHub 执行。
- 正式构建新增 clean source commit：构建前/前端构建后检查干净工作区和相同 SHA，写入 plan/summary/package.novaBuild；发布 --commit 与包内记录必须相同，draft target_commitish 和已有轻量/annotated tag 解引用都必须相同。测试构建仍允许 dirty workspace，无该正式证明。凭据只允许未来发布者显式环境 NOVA_RELEASE_TOKEN，错误输出不打印原始远端异常或 Token，资产重定向不转发发布凭据。当前 gh CLI 不可用，没有探测凭据库。
- 历史核验：全局 `config/windows-update.json.runtimeReady` 继续 false。仅 `--enable-test-runtime` 且 local-test >=3.5.2 才启用新测试包；此参数不批准正式签名。复验按当前固定身份/feed/签名/工具规则重建计划，仅容许保存的 runtimeReady 布尔差异，全部其他 metadata、实际包和重算 summary 仍须完全一致。没有逐版硬编码白名单，也未重写 3.5.0/3.5.1 的任一资产/plan/summary。
- U07：真实 Electron 43.4.0、真实 NsisUpdater/ElectronHttpExecutor 6.8.11 与真实 NSIS 包，经 loopback 单 Range/302/故障服务传输。独立 harness app adapter、会话和缓存只在新 release-updates/local-verification 目录，不执行 Nova 主入口，不把未安装形态伪装成生产安装验收，也不改生产任意 feed/路径/安装开关。没有 `_testOnlyOptions` 或禁用差分/哈希的做法。
- U08：精确测试注册键/同名进程只读预检与模式契约。发现 reg.exe 依活动 Windows 编码输出，旧 UTF8 解码破坏中文路径；将运行时与预检共用的读取改为固定 HKCU/HKLM 64位精确键、明确 UTF8 JSON，保留相同 GUID/InstallLocation/卸载器/当前 exe 目录要求，加中文/空格用例。没有扩大扫描范围。尚无独立 Windows 账户/system 资料隔离，真实端到端安装保持待验。

操作、保留和失败处理见 [Windows 更新发布与验证](../../Windows更新发布与验证.md)。

## 真实构建和完整复验

三个新版本均使用 `node scripts/build-windows-update.cjs --profile local-test --version <版本> --test-feed-url http://127.0.0.1:18888/ --enable-test-runtime`，每版 Next 静态生产构建、NSIS x64、完整验证、原子提升均成功，publish never。旧目录保留；三个新目录现也不得覆盖。

| 版本/状态 | installer bytes | blockmap chunks | 证据 |
| --- | ---: | ---: | --- |
| 3.5.0，历史 runtimeReady=false | 133744924 | 6376 | [当前严格复验](verified-3.5.0.json)，原 U01–U02 证据未动 |
| 3.5.1，历史 runtimeReady=false | 133744956 | 6370 | [当前严格复验](verified-3.5.1.json)，原 U01–U02 证据未动 |
| 3.5.2，runtimeReady=true | 133755842 | 6362 | [复验](verified-3.5.2.json)、[构建日志](build-3.5.2.log) |
| 3.5.3，runtimeReady=true | 133755858 | 6371 | [复验](verified-3.5.3.json)、[构建日志](build-3.5.3.log) |
| 3.5.4，runtimeReady=true，含中文注册路径修正 | 133756533 | 6373 | [复验](verified-3.5.4.json)、[构建日志](build-3.5.4.log) |

所有 installer/app 均明确 NotSigned。本地版本不构成正式签名、真实 app.getVersion() 运行或已安装应用更新的证明。3.5.2/3.5.3 下载证据原包未改；3.5.4 是后加注册表编码修正的当前源码构建，未重复未改下载器的 12 场景。三资产本体和 win-unpacked 位于 `release-updates/local-test/<版本>/`（被忽略），文档只保留摘要/日志。

最终复验命令：`node scripts/verify-windows-update.cjs release-updates/local-test/<版本>`，3.5.0、3.5.1、3.5.2、3.5.3、3.5.4 全部退出 0。每次完整重算 exe SHA512、清单大小/path/version、blockmap 每块 BLAKE2b/总覆盖、package metadata、app-update.yml、PE资源及签名，summary 完全相同。

最终 dry-run：`node scripts/release-windows-update.cjs --directory release-updates/local-test/3.5.4`，退出 0，报告 [release-dry-run.json](release-dry-run.json) 明确 8 个阻断（测试资产/签名/runtime及5项交付条件），无远端调用。

## 真实本地传输结果

实际运行使用 Electron 可执行文件启动 `scripts/test-windows-update-transfer.cjs`，参数依次为 3.5.2 目录、3.5.3 目录、全新 `release-updates/local-verification/u07-transfer-20261024-b`。成功完成生成 [transfer-summary.json](transfer-summary.json)，12 个场景均满足预期断言。原请求/Content-Range/状态/字节及真实库日志见 [transfers](transfers/)。本机 b 目录保留独立缓存、下载 exe、Electron 会话及逐场景原记录。

| 场景 | 安装器端点响应 body 字节 | 单 Range 206 | 完整 200 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 无旧缓存 | 133755858 | 0 | 1 | 原生回退全量，SHA512一致 |
| 有旧安装器+blockmap缓存 | 3541011 | 10 | 0 | 差分重建，SHA512一致；新 updater 实例重读 pending 缓存不再请求 exe |
| 旧安装器缓存内容损坏 | 137296869 | 10 | 1 | 差分SHA512失败后原生全量，最终一致 |
| 安装器 302 后单 Range | 3541011 | 10 | 0 | 重定向保留 Range，最终一致 |
| Range 416 | 133755875 | 0 | 1 | 17字节错误应答+完整包；最终一致 |
| 新 blockmap 非 gzip | 133755858 | 0 | 1 | 解析失败原生全量，最终一致 |
| 离线（清单连接断开） | 0 | 0 | 0 | 检查失败，无已下载/安装 |
| HTTP 429 + Retry-After | 0 | 0 | 0 | 不自动重试，无已下载/安装 |
| HTTP 408 立即应答 | 0 | 0 | 0 | 服务器超时状态处理，无已下载/安装 |
| 清单 YAML 错误 | 0 | 0 | 0 | ERR_UPDATER_INVALID_UPDATE_INFO |
| 清单期望 SHA512 不匹配 | 133755858 | 0 | 1 | ERR_CHECKSUM_MISMATCH，installerPath仍null |
| 完整下载 65536 字节后断流 | 65536 | 0 | 0 | 拒绝完成，installerPath仍null |

此对包全量大小 133755858 字节；缓存差分安装器 body=3541011 字节（约全包2.65%），包含新 blockmap、两次 manifest（第二次为 pending 缓存重开检查）在内 allBodyBytes=3681792。`wireBytes=3684376` 是 loopback HTTP **响应** socket 实际写入字节，含响应头，不含请求/TCP/IP帧或TLS。每个响应 Connection close，记录 finished；断流 bytes 只说明已写入的部分。该比例只对应这两个包和此环境，UI不显示推测模式/节省率。

并发检查合并同一 Promise；同时下载得到同一目标且实际请求不重复启动完整传输。所有成功场景文件长度和 SHA512 均与真实目标安装器相同。失败场景均无 update-downloaded、installerPath=null；harness从不调用安装函数，生产正常退出/安装门闩由定向测试覆盖。

**HTTP 408 不是客户端 socket 挂起超时实测。客户端真实挂起超时未验**，不把库故障场景一概写成网络超时全部通过。真实 GitHub provider、CDN/资产域/重定向/Range 仍待授权后分发验证；不能用 loopback 替代。

首次 a 运行在完整产物复验时发现 Electron 虚拟 app.asar 文件系统把归档看作目录，未开始传输即失败；证据保留于 `u07-transfer-20261024-a/failure.txt`。harness显式 `process.noAsar=true`，仅使独立验证器读取归档普通字节，然后在全新 b 目录完成全12场景。未修改归档字节或生产 App。

## 安装只读预检与仍待验项

最终命令：`node scripts/preflight-windows-update-install.cjs release-updates/local-test/3.5.4`，退出 0，证据 [install-preflight.json](install-preflight.json)。精确键为 `HKCU/HKLM\Software\3e5d42e7-0190-508b-80e7-1e99104f9b23`。HKCU 有历史安装 `temp/t16-followup-install/程序 中文 空格`，当前 exe/固定卸载器存在，注册身份核对 true；HKLM 无对应注册，同名进程为空。它只证明现存测试安装注册，不证明该历史安装为本批 runtime bootstrap 或本批安装成功。

首次 reg.exe UTF8错误解码曾导致现存路径被误判不存在；最终只读预检采用 UTF8 JSON 更正该事实，初步判断不当作验收结果。生产判定与预检都只读当前测试身份对应精确键，不探测、读取或导入旧资料。

`dataModeContract` 是以已安装有效 metadata 为前提的代码契约：system允许安装、override仅检查/下载且 DATA_DIRECTORY_RESTART_UNPROVEN、portable拒绝；unpacked/development亦拒绝。此字段不是当前账号已具备隔离资料条件的证明。当前仍 `isolatedWindowsAccountAndSystemData=not-established`、`installationAllowedByThisPreflight=false`、`REAL_END_TO_END_INSTALL_PENDING`。

因此没有安装/卸载/重启，没有以override或修改开关绕开限制，不使用/删除现有 APPDATA nova-image，不创建Windows账户。真正隔离用户/system环境内的 bootstrap→应用内检查下载→明确重启安装、新版本/身份/目录、草稿/设置/合成凭据/素材/结果/unknown/paused/队列跨重启与无额外POST仍待验。安装器spawn不等于安装成功。

## 定向验证与原门槛

最终执行：

```powershell
node --test desktop/update.test.cjs backend/test/update-safe-install.test.js scripts/windows-update.test.cjs scripts/windows-release.test.cjs
```

79 tests / 79 pass / 0 fail / 0 skipped，见 [targeted-tests.log](targeted-tests.log)。组成：22项主进程/IPC/退出/中文注册路径、6项真实HTTP/SQLite门闩、40项构建/历史/包内source校验、11项隔离模拟发布API。模拟测试包含commit/target/tag不符零写入、annotated tag解引用、完整draft、断点只补缺件、坏已有资产不覆盖、同版本拒绝、完整资产与明确tag发布、许可缺项零远端调用；不代表真实证书或GitHub操作通过。

三个新包的前端生产构建通过，不等于全仓库tsc/lint通过。既有全量tsc约60错误、full lint问题不在本批声明为通过。U03–U05此前138后端/50前端相关回归和11前端更新测试已由主审接受，本批没有改前端，不无故重复或提升它们的证据范围。

T16仍为33pass/7pending用户接受非阻断；历史NSIS0xc0000409根因、T15其他资料模式、M5、FFmpeg完整对应源码交付、正式签名/证书轮换、真实GitHub分发及真正隔离安装保持原状态。无自动回滚承诺。所有源码改动和证据保留未提交交主审，原docs/验收不动。
