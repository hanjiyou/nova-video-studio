# 脱敏诊断导出 v1

## 统一线路诊断补充（2026-10-26）

任务生成和下载尝试分别输出 `transportRoute:{route:'cn'|'com',revision:number}|null`；历史缺记录保留null，不由当前设置推断。请求点白名单增加 operation=models/submit/poll/download、route=cn/com、正整数routeRevision及精确targetHost=`newapi.opensosen.cn`/`newapi.opensosen.com`。这两个白名单host是下文“省略连接地址”的窄例外，不接受任意域名或完整URL。

模型目录日志记录线路保存切换前后route/revision，保留既有有界数量；尝试ID、阶段和真实字节帮助区分生成、查询与重新下载使用的线路。Key、凭据引用、原始响应、查询串、签名链接、原图和任意路径继续排除。`direct`不证明用户没有VPN；线路选择不改变VPN。源码与离线证据见[第一批](implementation/R01-R05-统一线路后端实施记录.md)和[第二批](implementation/R06-R08-统一线路界面与整体验收.md)，真实下载/速度仍未验收。

> 2026-10-26 当前下载体验：D01–D03 已主审；D04–D10 已实现并完成离线验收，源码与离线范围主审通过。图片下载默认30秒、视频180秒可配置；生成与下载独立预算，原卡片/详情显示进度并可重新下载。用户选择保持原来源存储，不新增加密；无ID临时链接重启后不可恢复时明确提示。见[实施记录](implementation/D04-D10-下载恢复与工作台体验.md)。未提交、打包或发布，已发布3.6.5仍执行旧规则。

T14/B5 离线范围已由主会话审查接受，见 B5 审核记录。设置 → 诊断与支持 → 导出脱敏诊断 → 选择应用数据/作品目录之外的位置。保存为本地 JSON，不上传，不调用供应商。取消正常返回；失败不改变任务或自动重新生成。

格式 `nova-diagnostics-v1` 只用正向字段投影：应用清单版本/Electron/Node/系统架构、schema 版本、总数/导出数/省略数、本地 UUID、已知模型/模式/状态、有限规格枚举、提示词字符数、时间、是否派发/是否收到 ID、HTTP 状态及错误分类、素材 UUID/哈希/类型/尺寸/时长/可用性、事件数量。未知自由字符串只显示 `other`；不复制数据库、日志或原始响应再做正则替换。

省略提示词原文、上游 ID 原文、连接名称/地址、任意资源/签名 URL、Key/编码 Key/密文/credentialRef、响应/错误原文、事件 payload、任意文件名/绝对路径、图片/Base64/媒体字节。任务参数仅允许有界整数 seconds、像素 size 和已知 quality。诊断仍包含本地关联 ID、时间和资产摘要，便于用户自愿提供给支持人员。

最近 1000 条任务（含隐藏记录）在单一只读事务中投影；更早任务只计 omitted，界面和文件均说明省略数量。没有导出上限外任务正文、全部历史打包或筛选 UI。提交意图仅统计数量，原输入不输出。元数据损坏降为安全空值/分类，不读受管文件，不受失效旧输出卷阻碍。

无参 `novaDesktop.exportDiagnostics()` 经受信主 webContents/主 frame IPC 到系统 SaveDialog；不提供 HTTP 下载、任意路径/任务参数输入或 renderer 读取整份诊断接口。返回仅成功/取消、安全 code 与记录数。原生保存目标、覆盖确认由系统对话框产生；应用数据和任何受管输出根禁止作为目标，包含 Windows 短/长路径别名和已离线的旧根。先写同目录独占临时文件、fsync，再次核对既有目标元数据后 rename；错误清理临时文件，保留旧目标。与已有另存一致，不宣称跨进程 compare-and-swap。

测试见 `backend/test/workbench-b5-diagnostics.test.js`、前端 B5 测试及实际 Electron `scripts/verify-desktop-b5.cjs`。对话框和定位目标在自动脚本中是受控替身；没有将其写为人工系统对话框或安装包验收。

## I06 阶段诊断增量（2026-10-25，待主审）

格式仍为 nova-diagnostics-v1，原字段保留，新增 execution 和 removedFromWorkbench 正向投影。原始事件 payload 仍不导出；下列仅为再次白名单投影后的安全字段。

execution 包括 queueMs/queueClock、终态可知的 executionMs、时限/截止、generation、latestDownload、受限 timeline 和 limited 标记。阶段枚举限定 reference_upload/submitting/receiving/parsing/remote_waiting/downloading/validating/saving；阶段时长单位毫秒。参考图阶段表示可观察的本地准备，提交与等待响应阶段包含上传、网络及未知远端处理，不能细分成模型内部耗时。

- 观察边界：排队、派发后的阶段切换、响应头到达、完整正文接收、解析、inline/URL/asset/mixed 结果来源分类、已获 ID（只记边界）、远端状态变更、下载字节、验证/保存和完成/失败/取消/超时。
- responseBytes 是已解码文本的 UTF-8 字节数，不宣称网络传输字节；downloadBytes 是受管读取或完成下载的已知字节数。未知字节/时长为 null，不补 0。
- 阶段汇总用运行上下文只读 elapsedMs() 的单调毫秒观察值，不改变原截止逻辑。未关闭的进行中阶段不通过 wall 时间补齐，executionMs 在尚未结束或重启出现观察缺口时为 null；unknownDurationPhases/elapsedUnknown 明确缺失区间。queueMs 仅来自持久时间戳差，queueClock=wall_timestamp_estimate；墙钟异常不能被解释为准确排队或模型耗时。
- 最多保留每任务 96 条 execution_diagnostic，保留早期 16 条和最新尾部，终态总能进入尾部。汇总独立于边界上限累计，limited/omittedEvents 标示省略。生成摘要与最新一次独立下载摘要各一条；更早下载尝试实体保留，但不承诺导出其全部时间线。
- 视频查询保持 remote_waiting，不为每次成功 GET 增加 receiving/parsing 事件；queryCount/queryFailureCount 饱和上限 1000000，保存最后安全分类与时间。相同远端状态的成功查询不重复添加 task_transition。轮询暂停、退避均包含在原执行预算和远端等待内。
- 采集和导出两道白名单只接收允许的阶段/终态/错误分类、有限计数、HTTP 状态、字节数、UUID、时间及来源类别。忽略未知字段；自由错误字符串为 other。禁止请求 header/body、Key/编码 Key、prompt、URL/query、路径、媒体/Base64、原始 error 与上游 ID 原文。

离线专项覆盖慢响应头/正文/下载/保存、inline 与 URL、成功/失败/取消/超时、有界查询和事件尾部、合成秘密挑战、墙钟前跳/回拨、跨重启未知及第二次下载新尝试。无法据此确认 VPN/TUN 原因或供应商内部瓶颈，亦未读取真实用户诊断或调用真实生成服务。见 [I05–I07 实施报告](implementation/I05-I07-任务移除阶段诊断与交互.md)。


## 2026-10-25：更新与生成阶段诊断补强（本批待发布）

保持 `nova-diagnostics-v1` 向后兼容，增加可选 `updates`；没有该字段的旧包不能追溯此前安装过程。新字段来自主进程自身资料目录的 `update-diagnostics.json`，独立于 SQLite，所以保存确认/数据库关闭后仍可同步写入并在下次启动导出。

### 生成任务

复用 `tasks[].execution`：每任务最多 96 个事件，保留前 16 个边界和滚动尾部，完整阶段摘要仍在；最新 1000 个任务的原导出上限不变。新增事件为 `dispatched/request_started/request_failed/query_response/query_body/download_started/download_headers/download_redirect/download_progress/media_validated/file_saved/recovery_observed`。既有排队、阶段变化、收到结果、上游接收、远端状态、取消/超时/完成事件保留。恢复观察每会话每任务最多一次，不破坏恢复幂等性。

新增安全字段：`sessionId`（进程随机 UUID）、`elapsedMs`（尝试内单调观测）、`durationMs`（本次 HTTP 请求开始后的单调耗时）、`operation`（submit/poll/download）、`networkMode`（direct/system/direct-first，仅本应用生成传输选择）、`redirectHop`、`errorCategory`。任务/尝试关联继续使用本地 UUID，不导出远端 ID。下载每持续 5 秒收到数据时记录已收字节，不为每个 chunk 写日志。响应头、正文完成、解码通过、文件发布分别有独立事件。

固定错误类别包括 DNS、拒绝连接、连接重置、TLS、超时、中止、HTTP、磁盘满、权限、文件占用、校验、签名、未知。仅从错误 code/name/statusCode/httpStatus 及最多四层 cause 识别，不解析原始 message。已知业务 reason 白名单包含下载错误。`diagnosticWriteFailuresThisSession` 表明本进程任务诊断写入失败；诊断存储异常不应改变生成业务结果。

`reference_upload` 观测的是本地参考资料/请求准备，fetch 提交到响应头的时间同时可能包含请求上传、网络等待和上游处理，不能拆成真实服务器生成耗时。请求没有明确失败码时保留 unknown，不能仅凭长等待判断 VPN。网络模式不是 VPN 检测，也不是 electron-updater 的传输配置。

### 更新流程

`updates.events` 最多保留最近 400 条；启动读取上限 512 KiB，超限/损坏标 unreadable，不导出原文。`omitted` 是淘汰数，`health` 含 readState、本次与可持久保存的历史写入失败次数。采用独占随机临时文件、fsync、原子替换；拒绝符号链接目标，不依赖已关闭的任务数据库。成功写入前不能保证异常断电后的记录可用。

每条包含安全时间、会话 UUID、当前版本；检查开始生成关联 attemptId，后续下载与安装保持关联。记录检查、可用版本、下载开始/每 10% 进度/完成/失败、准备、后端准入、页面保存确认、数据库关闭、交互安装请求、安装器启动请求/实际 spawn、可观察的退出码、父进程退出请求。下次启动记录目标版本已启动或未确认，并分别记录 backend_ready/window_loaded/startup_failed/window_failed。版本已启动不等于页面成功加载，更不证明该版本一定由自动安装完成。

只对锁定 electron-updater 6.8.11 的三类日志前缀投影固定事件：differential_started（尝试差分）、differential_fallback（回退全量）、differential_checksum_mismatch。原日志立即丢弃，不保存其中地址/路径/异常栈。没有 fallback 事件不能当作差分成功；没有这类事件时下载方式仍为未知。原始 updater logger 其他输出仍不记录。

父进程退出后不能继续收集安装器退出信息；`installer_spawned` 只证明启动成功，不证明安装完成。Windows 安装器后续崩溃/权限交互根因可能仍需系统事件或安装器证据，不能承诺一次 JSON 能确定所有外部根因。历史 B 电脑隐藏安装器现象仍为待真实新版验证的假设。

隐私：不保存 Key/地址/提示词/参考图名/签名链接/原始响应/任意异常消息/真实路径；磁盘收集与导出均白名单投影。应用不上传诊断，只有用户主动导出。


协议错误额外投影 `parseOutcome`：invalid_json/missing_task_id/invalid_task_id/no_result/unexpected_schema，用于区分 HTTP 成功但响应不可用与传输失败；不包含字段名、响应片段。下载工作流的外层 `operation_failed` 带 `phase`，区分下载、媒体验证和文件保存，不能将所有下载工作流失败都解释为网络问题。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。
