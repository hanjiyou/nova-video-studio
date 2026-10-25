# Windows 更新发布与验证

> 更新安装启动修复（待新版打包）：已为 GitHub 测试版及正式更新包恢复完成页默认勾选的“运行应用”选项，点击“完成”后启动。现有 3.6.5 不变，尚未进行真实安装验收。详见[修复记录](implementation/更新安装完成页启动修复.md)。

> 最新开发状态（2026-10-25）：交付网络完善已审核通过，本次仅提交推送源码，不重新打包或发布；新增统一代理、分级超时、进度和同次校验复用。见[完善记录](implementation/交付网络完善记录.md)与[操作说明](统一交付脚本使用说明.md)。下方 3.6.5 发布记录描述此前交付。

> 2026-10-25 发布更新：本轮功能已提交推送、打包并公开发布为 GitHub Test 3.6.5，远端资产与更新清单校验通过。详见[发布记录](implementation/3.6.5-交付记录.md)。下方未提交/未打包/未发布描述保留为对应阶段的历史记录；真实服务及安装验收范围保持。

## 当前交付入口（2026-10-25）

审核后的提交、推送、打包及发布统一使用[统一交付脚本](统一交付脚本使用说明.md)。可以仅提交推送，也可包含打包或完整发布；默认预览，显式执行后才产生交付动作。审核记录绑定选定文件和源码，构建使用对应提交的独立目录，支持失败续跑。

当前脚本支持 github-test 未签名测试包：固定 nova-test 更新清单，发布要求干净的已提交源码绑定。旧的无源码测试记录不能直接通过新发布门槛。release 正式包的签名、发布者及其他正式门槛保持；local-test 不因此获得远端发布资格。desktop-release 工作流已改为仅手动构建并保存 Actions 产物，不再由标签自动发布。

本轮交付及 Windows 构建/发布相关测试 71/71 通过（临时本地 Git 仓库、模拟 GitHub）。本轮新增功能尚未实际提交推送、构建新安装包或发布；真实完整流水线待下一次交付验证。历史 3.6.4 包不包含本轮未提交功能。

以下日期、阶段状态与版本实例属于历史实施记录；以本节及统一脚本说明作为当前交付入口。历史“本轮未发布”仅描述对应阶段，正式发布模板的门槛仍有效。


日期：2026-10-24。固定公开仓库为 `hanjiyou/nova-video-studio`。此文交付可审查的发布流程；本轮未创建 tag/Release、上传资产或发布。实际远端操作需届时明确授权。

## 当前可执行的本地准备

```powershell
npm run update:verify:win -- release-updates/local-test/3.5.4
npm run update:release:win -- --directory release-updates/local-test/3.5.4
```

默认 phase=prepare，所有 phase 省略 `--execute` 都仅作本地 dry-run，不读取 Token、不访问远端、不写本地包。输出固定仓库/version/tag、三资产大小/SHA512、签名与缺项。当前 local-test 是明确未签名测试，不能作为正式资产上传。全局 runtimeReady=false、正式发布者 pending，许可/源码、FFmpeg 完整对应源码、T15 其他模式、M5 与隔离安装验收均未完成；不能通过此脚本绕过。

签名/发布者决策冻结并审查后才可采用 release profile。正式构建要求干净的已提交工作区，构建前/前端构建后 source commit 相同，包内 package.novaBuild 与 update-plan/summary 的 `{commit,clean:true}` 一致，exe/app 均 Authenticode Valid 且发布者匹配。工具、固定身份/feed/最低版本/缓存、完整 exe/blockmap/latest.yml/PE 版本均需复验。local-test 工作区可保留未提交，不拿测试构建记录冒充已提交正式源码。

`config/windows-update-release-gates.json` 记录现有交付缺项。未来各必需项只有在实际完成、有可读证据并审查后改为 complete；这不是用字符串代替验收。T16 的 33 pass / 7 pending 用户接受为非阻断，历史 NSIS 0xc0000409 根因仍未明，既有状态不能改写为全通过。

## 未来发布者操作顺序（本轮不执行）

下面是模板，`<...>` 须替换为届时已审核值，不能直接执行。发布者只在自己的进程显式提供 `NOVA_RELEASE_TOKEN`；脚本不读取 gh 凭据库、用户配置或客户端 Key，不回显 Token。当前 gh CLI 不可用，本流程使用固定 GitHub REST endpoint。

```powershell
# 1. 准备：核对正式新版本输出，所有缺项必须解决
npm run update:release:win -- --directory release-updates/release/<新版本>

# 2. 明确授权后创建稳定 draft 并上传；--commit 必须等于签名包内 source
npm run update:release:win -- --directory release-updates/release/<新版本> --phase draft --commit <40位审核提交SHA> --notes-file <审核说明文件> --confirm-tag v<新版本> --execute

# 3. 如果上传中断，保留 draft ID；补齐缺件，既有资产先按完整字节核对，不覆盖
npm run update:release:win -- --directory release-updates/release/<新版本> --phase upload --release-id <draftID> --commit <相同SHA> --confirm-tag v<新版本> --execute

# 4. 单独重新下载远端三资产核验，仍保持 draft
npm run update:release:win -- --directory release-updates/release/<新版本> --phase verify --release-id <draftID> --commit <相同SHA> --execute

# 5. 主审确认上述具体 draft 和资产、且明确授权公开后才发布
npm run update:release:win -- --directory release-updates/release/<新版本> --phase publish --release-id <draftID> --commit <相同SHA> --confirm-tag v<新版本> --execute
```

创建前核对固定仓库为 public，并检查所有历史 draft/release 与 tag。相同 tag/version 已存在即拒绝新建，不能拿新包替换同号。draft 的 target_commitish 必须等于包内 source SHA；已有 tag（含 annotated tag）必须解引用到相同 SHA。upload 只接受稳定 draft，先检查所有已有资产名/状态/大小/完整远端 SHA512，再仅上传缺件；异常/重复/坏资产时停止并保留 draft，交审后选择更高版本，脚本没有删除或覆盖操作。

verify/publish 都重新核对本地完整性/签名/门槛、draft身份/source/tag 和三件远端资产完整字节。由此远端 exe 与本地刚验证的签名 exe 必须完全相同。下载 GitHub 资产重定向时不向重定向主机转发发布 Token，且只接受 HTTPS GitHub 资产域。半套资产始终留在 draft，publish 不接受缺失/多余/重复资产。发布失败保留已有状态，先读取并人工核对，不盲目重跑。

## 保留与故障恢复

最低支持范围仍从 3.5.0 开始；保留支持范围内的完整 exe、对应 blockmap 与版本 Release，本期脚本不提供清理功能。缓存可能缺失、不匹配或损坏；锁定库可原生全量回退，不承诺每次差分或固定节省比例。故障版本用更高版本修复；不删除旧包、不覆盖同号 latest 资产、不声称自动回滚。暂不把 latest.yml 单独暴露到公开可发现的有效更新源。

下载/校验失败时不安装，旧版可继续使用。安装启动异常保留下载与任务记录，按应用的明确恢复提示重开或手动修复；spawn 仅证明安装器启动。system 模式必须是已安装 Windows x64 NSIS；override 只能检查和下载，手动更新仍须沿用原启动方式；portable、unpacked、开发运行不支持自动更新。

## 本地验证与安装前提

真实传输命令使用锁定 Electron 执行独立 harness，绕开 Nova 主入口，不修改生产门槛；输出目录必须全新：

```powershell
.\node_modules\electron\dist\electron.exe .\scripts\test-windows-update-transfer.cjs .\release-updates\local-test\3.5.2 .\release-updates\local-test\3.5.3 .\release-updates\local-verification\<全新运行目录>
npm run update:preflight:win -- release-updates/local-test/3.5.4
```

harness 为真实 updater 下载器提供独立 app adapter、真实 ElectronHttpExecutor 与 loopback HTTP；会话/缓存/下载均在新证据目录。它验证 downloader，不能证明生产安装策略已通过、真实 GitHub provider 已分发或安装成功。Windows GUI 程序直接启动可能立即返回；检查 summary.json（或 failure.txt）及其断言，不根据启动命令退出码判定完成。

本批 12 场景包括实际单 Range/206/Content-Range、302后Range、重建完整文件、无/坏缓存与回退、断流/离线/坏哈希/坏清单/HTTP 429、服务器立即 HTTP 408 处理。**客户端 socket 挂起超时尚未实际验证**，408不等价该能力。真实 GitHub URL/重定向/Range、签名证书/轮换、完整安装重启与 app.getVersion/任务草稿资料保持仍待条件。

预检仅读取固定测试安装身份的 HKCU/HKLM 64位键和同名进程；不扫描用户资料。当前有历史注册安装与 exe/卸载器，但未建立独立 Windows 账户/system 资料隔离，所以保持 REAL_END_TO_END_INSTALL_PENDING。不得用当前已有 nova-image、override、便携或 unpacked 替代真实隔离安装，不为验收新建系统账户、改路径或开安装开关。完整证据和结果见 [本批实施](implementation/u06-u08/implementation.md)。


## 本轮 GitHub 未签名测试 A（用户已批准）

本轮在 dev / b4f7ffc45a5362717282a76dea7b26dbc2849379 上新增独立 github-test profile，制作 3.6.1 测试 A。用户明确批准未签名 GitHub 更新测试、不购买证书；本轮仅本地构建，不安装、不创建 tag/Release、不上传、不提交或推送，不读取真实 Key 或发起生成。该批准是本轮测试例外，不把正式 signing.pending 改为 approved，也不以 T15/M5/FFmpeg 完整对应源码等正式门槛阻止本地测试包制作。原 T16 33 pass/7 pending 用户接受非阻断、历史 NSIS 根因和其他待验状态保留。

固定身份为 com.novaimage.studio.github-test / Nova Studio GitHub Test，缓存为 com.novaimage.studio.github-test-updater；资料使用 system 的 AppData/Roaming/Nova Studio GitHub Test，启动前由完整受信测试包元数据选定，安装器重启后仍选同一路径，不依赖 NOVA_DATA_DIR。不会扫描、迁移或删除旧 nova-image 资料。override 仍只能检查/下载，portable、unpacked 和开发形态仍不能走安装更新门闩。

测试源固定公开 hanjiyou/nova-video-studio，使用稳定 GitHub provider 和独立 nova-test.yml，不生成/投喂正式 latest.yml；保留整包 SHA512、blockmap 每块与总覆盖验证。electron-updater 6.8.11 在 allowPrerelease=false 时先查仓库的最新稳定 Release，再在该 Release 读取 nova-test.yml；这只是清单隔离，不是独立完整的 Release channel。如果后续最新正式 Release 不带 nova-test.yml，测试客户端会检查失败，不回退到 latest.yml。正式客户端不会读取 nova-test.yml；未来测试发布时不能同时上传测试 latest.yml。

3.6.0 首个候选的两份复制旧说明与新更新行为矛盾，原字节保留为不交付候选；修复后使用新版本 3.6.1 作为最终 A，后续 B 为 3.6.2 或更高。

A 安装版每个主进程启动自动检查一次；不轮询、不自动下载或安装，手动检查保留。未来 B 必须高于 3.6.1，沿用同一测试身份、feed/channel、system 资料路径和未签名策略；发布 B 仍需单独授权。首次手动安装未建立旧安装器缓存时可能全量，不能承诺首轮差分。

实际结果：最终 3.6.1 A 本地构建及严格包内核验通过，104/104 定向与12/12前端通过，旧3.5.0–3.5.4严格复验兼容；两个独立packaged Electron进程确认相同测试名、版本和system路径。主审独立83/83及最终包核验接受，详情见 [本轮实施](implementation/github-test-a/implementation.md)。实际安装、跨网络GitHub下载/重定向/Range、A→B重启和草稿/凭据/任务保持仍未验证，不能冒充正式发布或端到端通过。


## 2026-10-25：3.6.2 测试更新已发布

用户明确授权直接发布后，已将审核代码/测试修复与打包所需说明提交并推送 origin/dev：7e070e6fcf735198d0b02ddbed313acba4a00163。未修改 main、未强推、未上传原始 docs/验收 资料。旧 desktop-release 工作流仅排除 v3.6.2 标签，防止旧构建配置混入本次已校验的测试包。

Release：https://github.com/hanjiyou/nova-video-studio/releases/tag/v3.6.2 ，ID 423131872，已公开且为 latest。仅三项更新资产：exe、对应 blockmap、nova-test.yml；GitHub 计算的 SHA256 均与本地一致。标签对应上述 dev 提交。安装包保持原字节（SHA256 a9267028f629ea9e071a509fa2a93100c041dfa94ddf07bfa3b1fd224c0eac95）；测试类型清理及标签工作流保护不改变包内运行代码。

使用客户端实际采用的匿名 github.com/releases/latest（Accept application/json）、releases.atom、v3.6.2/nova-test.yml 均成功，远端清单逐字节匹配本地。匿名 api.github.com 预检曾返回403，未以它冒充客户端失败；实际客户端使用 github.com 端点。最终查询该提交的 Actions runs 为空，没有旧构建上传。

发布及匿名发现已完成；B电脑实际下载、差分流量、安装重启与资料保持仍需实测。此为已授权未签名测试发布，不关闭正式签名/源码许可及其他历史待验门槛。证据保存在 docs/implementation/github-test-b-release/，无凭据。既有构建报告保留“当时未发布”的历史事实。
