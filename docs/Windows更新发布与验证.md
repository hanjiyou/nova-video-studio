# Windows 更新发布与验证

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
