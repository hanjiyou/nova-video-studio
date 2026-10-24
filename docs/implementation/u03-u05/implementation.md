# U03–U05 运行时更新、安全安装与设置页实施记录

日期：2026-10-24。基线：dev / `8a14f9ef6210bce55a8a937914d68867404a9459`，叠加保留的 U01–U02 未提交工作。本批保留未提交差异交主审，不 commit、push、发布、运行安装器或发起真实生成。

## 本批交付

- `desktop/update-policy.cjs` 从受信包内 `package.novaUpdate` 和 `resources/app-update.yml` 核对精确版本、Windows x64、profile、appId/productName、缓存名、固定 feed 和签名模式。正式源固定 `hanjiyou/nova-video-studio`，仅 local-test 接受构建时写入的 loopback generic；没有运行时 feed/env/renderer URL 开关。旧包、metadata 缺失、`runtimeReady=false`、非已安装 NSIS 和 portable 均禁止更新。检查 NSIS 时只读取当前安装身份对应的 builder GUID 注册表键，并要求 InstallLocation 与当前 exe 目录及固定卸载器一致，不扫描或迁移资料。
- `desktop/update-service.cjs` 维护检查、可用、下载、已下载、安装准备、安装中和不可恢复关闭失败状态。主实例在后端就绪并创建窗口后异步调用 startup，一次进程只调用一次，窗口重开、页面切换和 second-instance 不参与。自动与手动在途检查合并；无轮询、无自动失败重试。新版提示按本次进程的版本去重，晚订阅可通过快照补取，关闭后同版本不再自动提示。无新版和自动检查失败不弹提示。
- 初始化锁定 updater 6.8.11 的 `autoDownload=false`、`autoInstallOnAppQuit=false`、`disableWebInstaller=true`，保留原生差分与全量回退。UI 仅显示可靠的库下载进度，不展示推测的下载模式、节省率或回退原因。下载完成只进入已下载状态。
- 更新 IPC 延用 `session-policy.isTrustedSender`，只接受窄无参操作及当前 flush 请求 ID/布尔回执，不接受 URL、安装器路径或 feed。状态/flush 仅发给当前可信主窗口；异常使用固定文案，路径、原始异常、下载地址不进入事件。版本说明经过长度/敏感片段限制并作为 React 普通文本显示，没有 HTML 或可点击任意链接。
- 设置页增加应用更新，保留四页布局与既有深紫样式；展示版本、检查、可关闭提示、下载/重试、进度、稍后及明确的重启安装。初始未配置服务、未填写 Key 不阻止更新；真实未保存连接/默认项、进行中设置/导入或未完成本地提交意图会阻止安装。传输拒绝被吸收并显示固定可重试提示。

## 安装门闩与退出契约

1. `backend/storage/update-gate.js` 原子跟踪 HTTP 和非更新 IPC 的活动生命周期，包含原生文件选择/复制/导出与异步连接保存。准备时拒绝新写入和任务操作，只允许受控草稿/设置 PUT 与本机只读请求。最终 commit 再次要求活动集合为空；关闭后所有 API 都被门闩拒绝。
2. `taskService.prepareUpdate()` 同步冻结派发、查询和媒体下载启动。已有创建、查询或媒体落盘仍在运行即拒绝本次准备，不为安装中止它们。仅内存的带查询参数结果来源尚未保存时也拒绝，避免丢掉本次可重试的结果；没有对应任务的持久化提交意图同样拒绝。
3. 主进程发独立 flush 请求；renderer 先同步冻结创作入口，等待四种草稿的在途保存与后续编辑版本全部回执，再等待设置队列，并重新检查本地未完成操作。`useWorkbenchDrafts.flush()` 保存失败会拒绝，保留最新草稿与 dirty 状态；不是原先 running 时的早退。回执不匹配、额外字段、失败或 15 秒无确认均不安装，超时不算成功。
4. 后端 `shutdownForUpdate()` 在门闩 commit 后持久化远端暂停和本地 queued 的明确继续语义，再执行严格 WAL TRUNCATE checkpoint 和同步关闭，返回 `{databaseClosed:true, checkpointComplete:true}`。busy、空结果、异常或 db.open 仍为 true 都失败。没有数据库成功关闭证明就不调用安装器。关闭资源超过 5 秒同样失败，不把截止时间当成功。关闭前失败可解除门闩；已经持久化为 paused 的远端任务保持暂停，提示在任务详情继续查询。数据库已经关闭的部分失败保持冻结，并通过原生对话框提供重新打开/关闭应用路径。
5. `submission_unknown`、`polling_paused` 的 ID、连接版本、不可变输入快照、dispatch 记录与生成占位保留，不改为完成/取消、不重新 POST。更新停止查询不代表远端取消，界面在明确重启前说明远端可能继续生成或计费。
6. 严格关闭成功后才调用 6.8.11 的 `quitAndInstall(false,true)`。该库先调用 install/doInstall，再 setImmediate 发原生 before-quit-for-update 并 app.quit；返回值不能证明安装完成。`update-launcher.cjs` 仅在固定版本的 NsisUpdater 实例上替换内部 spawnLog，保留固定安装器和参数、env/stdio/detached 行为，但等待真实 child `spawn` 事件而非仅相信 pid。失败改用固定错误码，防止内部 ENOENT 分支转为无法证明启动的 shell.openPath。此适配不跳过库下载校验、发布者验证或安装路径选择，依赖内部 API，升级 updater 必须重新审查。
7. `update-quit.cjs` 拦截更新退出，等待最多 10 秒的真实进程启动证明后清理 host 会话并允许 `app.quit()`；不进入原普通退出的 `app.exit`。同步 throw、异步 error、超时或部分关闭失败均不假称恢复创作。异步安装错误保持 `closed-error`，检查/下载无法覆盖此状态；renderer 保持冻结直到原生明确重开或关闭。spawn 成功只证明安装程序已启动，不能证明安装完成。普通退出仍使用既有清理路径，并因 autoInstallOnAppQuit=false 永不顺带安装。

## 资料模式与后批调用约定

| 模式 | 本期行为 |
| --- | --- |
| system + 已安装 Windows x64 NSIS + 有效启用 metadata | 支持检查/明确下载/明确重启安装；真实安装与重启留待 U08。 |
| override | 可检查和明确下载，但安装始终拒绝。尚未证明 NSIS 重启继承原 NOVA_DATA_DIR，不允许为了测试放开或改回 system；UI 要求按原启动方式手动更新。 |
| portable / 未安装 win-unpacked / 开发工作区 / 历史 metadata 未启用包 | 不创建 updater，不检查、不下载、不安装，设置显示不支持。 |

`config/windows-update.json.runtimeReady` 保持 **false**，本批不启用默认更新 metadata。原 3.5.0、3.5.1 产物原字节与历史校验规则保持，不把它们当 bootstrap。U06 在本批主审后协调 runtimeReady 与历史包复验兼容；新的可运行测试包必须选择新 SemVer，不覆盖旧目录。正式签名仍 pending，固定 GitHub 源选择不代表发布授权。

后批真实安装应使用同一测试身份、独立的 Windows 用户/system 资料环境，不得使用现用户已有 `nova-image` 目录，也不得用 override 绕开本期安装限制。没有该隔离条件就登记待验。无需为后批测试新增生产任意 feed、任意路径或凭据入口。

## 执行记录

以下命令均从仓库执行；前端命令的工作目录是 `frontend/`。测试只使用 mock updater/Electron bridge、临时 SQLite、合成凭据与 loopback HTTP，未调用真实生成服务。

| 验证 | 实际结果 |
| --- | --- |
| `node --test desktop/update.test.cjs backend/test/update-safe-install.test.js`（最终定向） | 27/27 通过，0 失败/跳过。21 项主进程/IPC/退出、6 项门闩/SQLite/实际 HTTP。包含异步安装 error 保持 closed-error、检查下载拒绝覆盖、普通退出不走安装、真实草稿 PUT 后严格关闭并重新打开 SQLite 核对内容、unknown/paused/queued 保留、媒体/内存结果/提交意图拒绝。 |
| `node --test desktop/update.test.cjs backend/test/update-safe-install.test.js backend/test/workbench-tasks.test.js backend/test/workbench-storage-http.test.js backend/test/desktop-boundary.test.js backend/test/workbench-downloads.test.js backend/test/workbench-downloads-http.test.js backend/test/workbench-b3.test.js backend/test/workbench-b4.test.js backend/test/workbench-b5-diagnostics.test.js` | 138/138 通过，0 失败/跳过；运行于最后增加异步安装 error 用例及实际关库断言前。后续修改由上述最终定向覆盖，未重复未改的回归套件。 |
| `npm run test:run -- src/components/workbench/__tests__ src/lib/__tests__/workbench-generation.test.ts` | 实际匹配 7 个文件，50/50 通过，0 失败/跳过；其中当时新增更新测试为9项。没有匹配的额外路径不计算成测试文件。 |
| `npm run test:run -- src/components/workbench/__tests__/app-update.test.tsx`（最终定向） | 11/11 通过，覆盖后加的异步 closed-error 冻结与 IPC 传输拒绝提示。 |
| `npm run build` | Next.js 16.2.6 静态生产构建通过，webpack/构建 TypeScript/静态页生成均成功；最后 UI 传输提示改动后再次执行。不是仓库全量 tsc/lint 通过声明。 |
| `git -c safe.directory=E:/Learn/AI/nova-image-studio diff --check` | 通过；仅 Git 的 LF/CRLF 提示。 |

开发中暴露并修复了两项测试问题：新增退出模块在 VM 启动失败 fixture 中过早初始化，调整为仅正常主实例创建，原启动错误回归恢复通过；临时目录 hook 清理顺序曾早于 SQLite/子进程关闭，改为先关闭再清理，挂起的本批测试子进程已按精确 PID/父 PID/命令核实后终止，不涉及用户应用。实际关库内容断言初次使用了错误表名，按现有 `drafts` schema 修正后最终27项通过。

## 未验与未提升的门槛

本批未构建新 NSIS、未启动真实 updater 网络下载/安装、未通过真实 Electron app 运行验证安装注册表判定、未做实际 NSIS 安装/卸载/重启、真实 GitHub 重定向/Range/传输字节/差分节省、签名证书或轮换、真实 Windows system 数据环境升级。未用单测宣称这些完成。U06–U08、T15/T16 最终、M5 和 FFmpeg 对应源码等原门槛保持待验。没有自动回滚承诺，部分关闭或安装失败只提供明确重开/手动修复路径。

未读取真实 Key、未修改任何现有用户资料目录、未迁移旧数据、未覆盖先前产物/原始验收、未 commit/push/publish。首次批量同步曾被自动审批以可能覆盖他人未提交为由拒绝；随后逐项目标证明是 HEAD 原文件或不存在的新文件，并在每次同步前核对上次写入 SHA256，任何并发改动即整体拒绝；前批构建/文档/依赖与产物均保留。
