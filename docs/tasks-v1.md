# 持久任务服务与恢复接口 v1

## 统一访问线路补充（2026-10-26）

第一批后端源码与离线范围已主审；第二批界面与离线整体验收主审通过，见[第二批记录](implementation/R06-R08-统一线路界面与整体验收.md)。本节补充现有生命周期，不增加创建重试或改绑凭据。

- 任务HTTP/WS/历史DTO新增 `transportRoute:{route:'cn'|'com',revision:number}|null`，表示生成请求冻结线路。服务端创建任务时冻结，页面不提交该字段；排队期间切线不改写已冻结生成意图。同 localRequestId 重放仍返回原任务，线路改变不产生第二次POST。
- 历史已派发任务缺记录返回null/未记录，不倒推为cn或com；旧未派发任务首次派发前固定一次，保留历史输入、Key、能力、目录及上游ID。
- 每次新的原ID查询读取原任务所属稳定connectionId的当前线路，凭据仍来自原connectionVersionId。已发出请求继续按原尝试处理，切线不中断、不重发生成；不能仅因当前线路已改而丢弃原生成结果。
- `downloadAttempt.transportRoute` 冻结每次下载入队时的线路，多文件、临时链接刷新和重定向共用本次快照。下一次手动重新下载才读取新线路；本次进度、预算、验证保存与旧生命周期兼容保持。
- 设置/模型清单按当前route/revision防迟到；提交前检查出现线路冲突时停止于本地意图/生成POST之前。型号拒绝的前端刷新仅匹配同一原连接版本和明确线路快照；新线路不消费旧线路失败的退避或同步回执。

模型检查和既有原ID查询直连证据不等于cn真实生成/下载通过；真实生成、下载速度及Range续传仍未验证，无新增授权。

> 2026-10-26 当前下载体验：D01–D03 已主审；D04–D10 已实现并完成离线验收，源码与离线范围主审通过。图片下载默认30秒、视频180秒可配置；生成与下载独立预算，原卡片/详情显示进度并可重新下载。用户选择保持原来源存储，不新增加密；无ID临时链接重启后不可恢复时明确提示。见[实施记录](implementation/D04-D10-下载恢复与工作台体验.md)。未提交、打包或发布，已发布3.6.5仍执行旧规则。

## 最新补充（2026-10-25）

模型清单与参数费用联动已实现并完成本轮返修复测，见[实施报告](implementation/模型清单与参数费用联动实施报告.md)。型号明确拒绝时任务失败并刷新清单，不自动重新生成；已有远端 ID、旧任务连接和能力快照仍按原生命周期规则处理。清单刷新不会取消任务或释放未知远端任务的占位。

本轮后端 163/163、前端 90/90 及完整 TypeScript 检查通过；不代表真实生成、安装包或发布验收完成。交付操作统一见[脚本使用说明](统一交付脚本使用说明.md)，任务与 UI 的新增规范见[工作台契约](contracts/workbench-v1.md)。以下阶段描述保留为历史基础，后续补充优先。


B4/T11–T13 已把工作台接入上述任务服务，本批离线实现范围已由主会话复审接受。额外允许用户对 completed 且受管输出确已 missing 的任务明确执行 retry-download：转入原下载队列，保留原连接、ID、结果源及目录，不重新 POST 生成。其他 completed 状态转换仍拒绝；下载完整校验后才再次 completed。图片/视频工作台先持久本地意图、仅创建一次，回执丢失或重启只做本地关联核对，详见 [B4](implementation/B4-T11-T13-图片视频工作台与作品库.md)。原有保守占位、单次付费创建、有界 GET 和凭据版本规则保持。

B2/T08 已安装生产下载worker，只有完整解码/正式文件/输出关联事务成功才completed；签名URL采用瞬时交接、有ID只读刷新、无ID重启明确不可恢复。基础范围已由主会话审核接受并明确批准提交推送，详见[B2审核](implementation/b2-evidence/approval-review.json)及[B2媒体契约](b2-media-v1.md)；下文保留T05当时的阶段边界。

本页记录 T05 的桌面基础，不代表 T06/T07 新模型协议、T08 下载媒体或后续工作台 UI 已完成。Web 继续原队列/TTL；桌面不清历史、不把 ACK 当删除、不做旧安装数据扫描。所有验证使用假 Key 和本地合成服务。

## 提交与去重

桌面原 POST `/api/nova/tasks`（图片）和 `/api/nova/plugin-tasks`（现有插件）现要求 `localRequestId` UUID 及不可变 `connectionVersionId`，不接收 Key/地址覆盖。新客户端在网络前产生本地请求 ID；调用方可显式传入并保存该 ID，用于丢失本地 ACK 后查询/重传同一意图。复用同一输入对象也会复用该 ID 和首次绑定的连接版本，连接修改不改变重传目标。未来工作台应持久保存该意图，不从旧浏览器存储导入。

本地 ID 不区分 UUID 大小写，同 ID 同规范快照返回原 `taskId`（即使原凭据后来已被清除）；不同快照返回 409 `LOCAL_REQUEST_CONFLICT`。对象键顺序不影响相等性，提示词和有序数组仍原样比较。数据库唯一索引跨重启保留记录。没有供应商幂等假设，不向上游添加 Idempotency-Key。

入队事务保存任务、不可变输入/连接/能力/输出引用快照、有序素材关联及事件。首次调度先完成凭据/素材/适配器预检，再将 `dispatch_started_at` 和 `submitting` 事务提交，之后才调用一次 POST。派发边界写库失败会停止后台调度，不调用网络。适配器一旦解析出合法 ID，通过 `onAccepted` 同步提交 `upstream_task_id`，再处理其余候选结果；后续解析异常保留 ID 并暂停，仅允许原 ID 查询。ID、派发时间和既有快照有不可变数据库约束。

桌面首版每任务一个自动创建请求；旧图片 `parallelCount` 仅允许 1，避免在同一本地意图中隐式创建多笔请求。未来多任务由显式的多个本地意图排队，不能把多 POST 的旧并发实现带回桌面路径。此处复用已有图片请求构造和插件映射，只用于生命周期接入；不新增或验证 flare/OpenSosen 协议，不将 mock 通过当作上游能力。

## 状态、占位与重启

规范状态以 [工作台契约](contracts/workbench-v1.md) 为准，`status` 直接返回规范值。`remoteState/rawStatus/progress` 单独存储。未知状态保留有界安全原文，暂停而不猜测失败/完成。GET 401/403、凭据缺失/坏密文和网络故障不是远端失败。响应详情只生成固定安全错误 DTO；HTTP、WS、历史和事件均不返回原始资源 URL、Base64、Key、密文或真实路径。

用户于 T05 明确批准保守规则：已派发的 `submission_unknown` 或 `polling_paused` 继续占用唯一生成名额，后续未派发任务等待同一上游任务明确完成、失败或取消。停止查询只暂停本地，远端可能仍在生成或计费，不代表取消/退款。DTO 提供 `generationReserved`、`remoteMayContinue`、`pauseReason`、`schedulingNotice`，后续界面必须显示。未派发的凭据暂停不占远端名额，可取消本地排队。

| 持久记录 | 启动行为 |
| --- | --- |
| 无派发标记、无 ID 的队列 | `local_queued`、`requiresContinue=true`，等待显式继续 |
| 已派发、无可靠 ID/同步结果 | `submission_unknown`，不自动 POST，保留占位 |
| 已有 ID 的远端排队/生成或兼容 processing | 仅按原版本 GET；保存的 nextPollAt/notBeforeAt 仍生效 |
| 已暂停查询 | 保留暂停和原因，不因重启自动恢复或释放占位 |
| 候选结果/下载中 | 只恢复持久下载队列；不重新生成 |
| completed/failed/已取消 | 保留历史、文件与输入关联，不 TTL 删除 |

已存在的本应用旧记录按可靠信息保守映射；旧插件 request_json 的 ID 补入统一列。有旧 completed 历史只保留，不把其旧状态视作 T08 媒体验证证据。没有扫描原版 exe/data 或浏览器历史。

图片创建默认 REQUEST_TIMEOUT_MS 为应用自定 30 分钟，覆盖 headers、完整响应正文和解析；headers 到达不会提前结束该期限。正文挂起/超时且无可靠 ID/同步结果时进入 submission_unknown、保留生成占位，不自动重发 POST。图片非 2xx 的正文只读一次，完整明确拒绝与不明传输仍按上述规则分类。这不改变供应商协议或 T08 下载策略。

## 查询策略

默认 GET 间隔 20 秒。临时网络、429/5xx 采用有界指数退避和抖动；单轮最多 5 次自动重试，或累计 10 分钟，先到即暂停；最长本地退避 120 秒。重试次数、轮次开始时间及下次时间入库，重启不会刷新预算。一次成功识别的 queued/generating 响应结束该故障轮。

可信 Retry-After 支持秒数和 HTTP 日期。在预算内按要求等待；超 120 秒/剩余预算直接暂停并存 `notBeforeAt`，不截短后提前请求。允许时间到达前，显式恢复返回 409 `POLL_NOT_BEFORE` 与 `notBeforeAt`。恢复开启新的人工确认查询轮，仍只 GET 原 ID。POST 不用这套重试，429 明确拒绝可记录 REMOTE_REJECTED，不明确则 submission_unknown。

所有桌面任务 GET/WS 订阅只读本地状态，不触发上游请求，也不绕过停止查询、预算或 Retry-After。声明式查询把 opaque ID 编码为一个路径段；不允许插件查询改用 POST、越过原服务源或突破原主机/内网限制。driver 仍须正确构造具体查询协议，T07 不得猜测未知端点。

## 动作接口

以下 POST 端点复用 T02 会话鉴权，也支持 `/api/nova/plugin-tasks/:id/…` 别名。除补 ID 外请求体都是 `{}`，未知字段拒绝。成功返回 `{task}`；失败返回稳定 code。没有远端取消或收费重建接口。

| POST /api/nova/tasks/:id/动作 | 条件和行为 |
| --- | --- |
| cancel-queued | 无派发标记/ID 的本地排队或凭据暂停 → local_cancelled；已派发返回 409 |
| continue-queued | 重启后的 local_queued；明确清除 requiresContinue，但不能越过已有生成占位 |
| stop-polling | 有 ID 且正在查询 → polling_paused；晚到 GET 不覆盖暂停，保留占位 |
| resume-polling | 有 ID 的暂停任务；检查原版本凭据、原适配器和 notBeforeAt，只恢复 GET |
| attach-upstream-id | submission_unknown 且尚无 ID；仅接收 `{upstreamTaskId}`，检查非空、长度、控制字符及编码凭据回显，持久化为暂停；后续显式 resume 才 GET，附加本身不请求网络 |
| retry-download | download_failed 且有可恢复候选 → 下载队列；无可恢复源返回 RESULT_REFRESH_REQUIRED，绝不 POST |

补 ID 是用户核对记录后提供的 opaque ID，不宣称仅凭格式就验证了上游存在、归属或内容。语义核对通过原适配器的 GET 完成；失败继续保留占位，没有改写既有上游 ID、丢弃不明任务或绕过占位的入口。旧版本坏密文/被撤销凭据不会自动改绑新版本；无法访问原版本时保持暂停，后续重认证交互仍由 T10 明确。

## 下载与后续接入

remote_completed 与下载任务在同一 SQLite 事务登记。生成与下载名额分离，下载并发为 1；T05 没有安装生产下载 worker，因此候选停在 remote_completed，而不是伪造本地完成。inline 字节写入受管对象但保持 validationState=unverified，只作为内部候选资产；没有原始 Base64 广播。可持久化 URL 不含 userinfo、片段、凭据或查询参数；查询/签名 URL 目前不落库，转 download_failed/DOWNLOAD_EXPIRED，T08 必须通过原 ID 的只读刷新或受控瞬时交接处理，不能重新生成。无 ID 的同步签名 URL 刷新尚不支持，不冒称可恢复。

下载 worker 只在验证过的受管资产存在并返回证明后，才可绑定输出和 completed。T05 用本地替身测试该门槛和下载失败重试，不实现 .part、媒体解码、Range、CDN 重定向或实际重下载；这些在 B2/T08 继续，需补端到端下载恢复。T06/T07 新适配器也必须延续单次 POST、onAccepted 早持久化、原连接和有界 GET 规则。

schema v4 是追加迁移；v1–v3 SQL 与 checksum 不变，仍执行升级前一致 SQLite 备份、完整事务和失败回滚。未对 APPDATA/nova-image 做清理，测试均为新建隔离目录。

## B1 适配接入说明

上文保留 T05 原始阶段边界。B1 新增桌面 POST /api/nova/workbench/tasks，精确连接/能力版本、参数、模式和有序 assetId 随快照冻结；继续使用本页全部去重、派发、onAccepted、恢复、GET 预算与单生成占位规则。flare 文生为仅离线的候选，参考编辑、两个视频文生等缺证据组合在 POST 前返回 CAPABILITY_UNVERIFIED；1.5 单/双参考按历史 multipart 接入。新接口及旧入口保护见 [B1 接口](b1-adapters-v1.md)。

视频完成给 B2 的候选使用同 ID、同服务源 /content；不保存返回的临时 CDN URL。图片适配器允许瞬时 URL/inline 结果源，签名 URL 的瞬时交接及无 ID 同步结果恢复仍待 B2；本批不实现或宣称下载/媒体闭环。remote_completed 仍只登记下载队列，没有本地验证文件就不 completed。

## B1 审核修复：上游 ID 的纯点段

统一 upstream-id 边界用于接收ID、手动补ID、原ID查询、恢复与 content 描述。当前单路径段协议拒绝仅为 . 或 .. 的 ID；encodeURIComponent 不编码点，%2E 也会被 WHATWG 当点段规范化，因此不以改成 %2E 绕过。正常含点、斜杠、百分号和中文的 opaque ID 保留原值，仅在 URL 中编码一次。空值、控制字符、过长及无法编码的孤立 UTF-16 代理项也不接受；这是客户端可查询表示约束，不宣称供应商的ID规则。

新收到不可查询ID时保持 submission_unknown、派发标记与生成占位，不自动POST或GET；补入非法ID返回 INVALID_UPSTREAM_ID，不改ID/事件、不请求上游。既有持久不可查询ID在恢复/直接查询时暂停，保留原ID和占位，resume被拒绝；不清空、改写或换任务绕过占位。声明式插件查询及其content fallback使用相同编码/检查。详见[B1审核修复](implementation/B1-T06-T07-图片视频适配.md)。

## I01 图片/视频生命周期数据契约（2026-10-25，主审通过；分批历史）

本节记录 I01 完成时的数据边界，供兼容与历史证据查阅。当前 I02–I04 已主审通过，已启用独立并发、120/300 秒整任务截止、本地取消和恢复规则；以文末 I02–I04 当前运行契约覆盖相应历史行为，I05–I08 仍待后续批次。

- 配置使用现有 GET/PUT `/api/nova/storage/settings/taskExecution`，值为完整对象 `{imageConcurrency:3,videoConcurrency:3,imageTimeoutSeconds:120,videoTimeoutSeconds:300}`。两类并发分别为整数 1–5，时限分别为整数 30–1800 秒；拒绝缺项、未知字段、字符串、布尔、非整数和非有限数，不强制转换或钳制。沿用 `expectedRevision` 冲突检查。未保存时只读返回默认值、revision=0，不写入数据库。并发设置从 I02 接入后续入场，时限在本批只保存新建快照，I03 才执行截止。
- 公共模式分类：image.text/reference 属图片；video.text/single_reference/dual_reference/multi_reference 属视频；旧 text-to-image/image-to-image 属图片，plugin/legacy.plugin 属视频。不按任意前缀猜新模式。
- 新任务在创建事务的独立列保存 `execution_media_kind` 与 `execution_timeout_seconds`，数据库拒绝后改；不把运行配置塞进原不可变输入。相同 localRequestId 重传优先关联旧任务，即使设置已改或原凭据已清除，也不改旧快照或增加派发。
- 首次实际派发在原提交边界同一事务保存 `execution_attempt_id`（UUID）、原 `dispatch_started_at` 与 `execution_deadline_at=派发时间+快照秒数`。排队不消耗时限，后续查询/阶段切换不重置这些不可变字段。此 ID 供 I03 的异步执行 fence 使用；本批没有启用迟到回调保护或计时器。单调计时及跨重启预算核验由 I03/I04 实施。
- `local_outcome` 表达 completed/failed/timed_out/cancelled；`local_finished_at` 表达本地结束。独立的 `remote_outcome` 表达 not_dispatched/unknown/confirmed_result/confirmed_rejected/confirmed_failed/confirmed_cancelled。保留实际 upstreamTaskId 和 remoteState，不能仅因本地取消、超时、通信或下载失败断言远端失败/取消。
- `execution_phase`、`execution_phase_started_at` 为可观测阶段预留（reference_upload/submitting/receiving/parsing/remote_waiting/downloading/validating/saving）。完整多阶段边界沿用 task_events，I06 才采集与导出。无证据返回 null，不能补造 0 耗时或模型内部进度。
- service 的 GET/WS/动作与 history 共用同一投影：mode、mediaKind、localOutcome、remoteOutcome、executionAttemptId、timeoutSeconds、dispatchStartedAt、deadlineAt、localFinishedAt、phase、phaseStartedAt、progress、nextPollAt、generationReserved、remoteMayContinue、schedulingNotice 的含义一致。旧终态可按已知 status 投影本地结论，远端结论只来自已知 remoteState/明确拒绝证据；仅有 failed 不推断远端 failed。
- download_failed 的本地结论为 failed、生成占位为 false；显式下载重试必须在 I03 设计为独立下载尝试/预算，保留原生成尝试与取消/超时结论，不发生成 POST。本批保留现有 retry-download 行为，不将其改造伪装成已完成。
- v7 只追加 nullable 列和独立的 `workbench_removed_tasks(task_id,removed_at)` 展示范围；旧行的时限、派发尝试和截止时间保持 null，禁止 UPDATE 补造时限。旧 `workbench_hidden_tasks` 内容和作品库过滤不变，不批量复现已隐藏记录。I05 才接入新移除入口与任务列表过滤；其不得删除任务、去重凭据或作品关联。

迁移继续使用原一致 SQLite 备份、quick_check、SHA256 清单与完整事务回滚，v1–v6 SQL/checksum 保持原样。测试以临时隔离的 v6/A 形态合成数据库证明兼容，不打开用户资料，不代表真实 A→B 安装验收。I04 负责旧活动记录的一次性恢复，不在迁移里发请求或改写旧本地状态。

后续故障边界：当前 background 的任何 rejection 都会关闭全队列并中止全部请求；I02/I03 必须将单任务取消、超时与终态竞争和真正存储故障分开。逻辑名额与真实 IO/清理分别追踪，更新关闭仍等待所有操作安全结束。

## I02–I04 当前运行契约（2026-10-25，主审通过）

本节覆盖下方 T05 / B1 / I01 原始阶段中唯一占位、串行下载、无总截止和自动恢复 GET 的历史行为；保留其他仍适用的去重、原连接 / 适配器、结果验证与安全边界。详细实现和命令见 [I02–I04 实施与验证](implementation/I02-I04-独立并发截止与恢复.md)。

- 图片 / 视频分别默认 3 名额，覆盖真实派发到验证保存，分别默认 120 / 300 秒总预算。创建保存时限快照，派发保存不可变 attempt / deadline；队列时间另算，阶段 / 退避 / 查询暂停不续期。
- cancel 停止本地等待，原子终态、释放逻辑名额并保留未知远端与已持久 ID；取消 / 超时不自动 POST，迟到响应 / 保存不绑定输出。真实 IO 单独追踪，更新仍等待它们和清理退出。
- 每视频同 ID 最多一条在途 GET，stop-polling 保留原名额和截止；resume-polling 仅同 ID 未结束 / 未过期任务，遵守 Retry-After 与原查询预算。重启后有 ID 新任务需要用户显式恢复，剩余时限不重置。
- 旧无 deadline 活动记录一次性本地结束，保留远端未知、真实 ID 与原快照；不补造旧预算，不静默 POST / GET。未派发队列保留 requiresContinue；新任务安全结果下载恢复也须显式 continue-queued，签名来源丢失且无 ID 明确不可恢复。
- retry-download 是独立预算 / 独立 attempt，只重取原结果，不重新生成。原 localOutcome / localFinishedAt 和生成 deadline 不改；downloadAttempt.{active,outcome,startedAt,deadlineAt,timeoutSeconds,finishedAt} 表达新下载活动和结论。localExecutionActive / downloadAttempt.active 用于取消和移除保护，不可只看原 localOutcome。名额已满返回 TASK_CAPACITY_BUSY。
- v8 追加下载尝试表和本地终态不可变约束，复用原备份 / 事务体系，v1–v7 checksum 不改。I05 移除、I06 完整诊断、I07 界面和 I08 真实交付仍未完成。

## I05–I07 任务展示、诊断与交互（2026-10-25，待主审）

本批实现与离线验证完成，尚未主审验收；详见 [实施报告](implementation/I05-I07-任务移除阶段诊断与交互.md)。沿用已通过 I01–I04 的调度、截止和恢复，不授权 I08 打包、安装、真实生成或发布。

- GET /api/nova/storage/tasks 显式支持 scope=workbench（默认）与 scope=library。两者继续过滤旧 workbench_hidden_tasks，只有 workbench 过滤 workbench_removed_tasks；旧隐藏不恢复。工作台最近图片/视频与任务卡片使用前者，作品库显式使用后者。
- POST /api/nova/storage/tasks/:id/remove 只接受 {}，服务确认结束后新增展示移除标记，返回 {removed:true,worksRetained:true}。活跃生成、排队和独立下载尝试均返回 TASK_ACTIVE，必须先取消并等待确认。不会删除任务、localRequestId、输入快照、输出关联或物理文件；GET 单条仍可读，DTO 的 removedFromWorkbench 只表达展示移除。
- 原 DELETE /api/nova/storage/tasks/:id 的 {deleteOutputs:boolean} 仍是作品库隐藏/可选独占文件删除入口，继续保留物理别名和共享引用保护，与新的任务展示移除区分。
- 设置页的“任务控制”独立于连接配置显示。图片/视频并发各默认 3（1–5）；时限默认 120/300 秒（30–1800）。保存完整对象和 expectedRevision；读取/保存失败保留输入，修订冲突要求明确重新读取，未保存输入或保存中阻挡更新安装。并发只影响后续入场，时限只影响新任务快照。
- 卡片与详情按 phase/remoteState 显示观察到的阶段，无虚构百分比。排队与生成执行时间分列；生成结束按 localFinishedAt 冻结，下载重试另按 downloadAttempt 计时。原 localOutcome 不充当当前下载的终态；取消与移除使用 localExecutionActive/downloadAttempt.active。
- stop-polling 只暂停同 ID 查询，保留原时限/名额；resume-polling 仅未结束且未过期任务。cancel 停止本地等待。旧无 ID 图片无需补造 ID 或轮询能力；远端可能继续生成或计费。
- 创建收到本地 ACK 即释放创建锁，详情读取和意图清理可继续。提交指纹/持久意图保持；未知 ACK 不重发。提交序号与核对序号避免旧 finally、迟到列表或详情干扰下一次提交和另一模式的选择。展示移除后清理选择/详情，迟到 GET 或旧列表不能复活它；从作品库仍可打开作品。
- 阶段诊断按白名单采集与导出，生成和最新下载独立摘要，最多 96 条诊断边界加两条摘要；视频查询只累计有限计数/错误分类，不逐次添加接收/解析阶段。阶段时长使用单调观察值，未知为 null；重启未观察区间不从墙钟推算。排队时长明确为 wall_timestamp_estimate。详见 [诊断契约](diagnostics-v1.md)。


## D01–D03 下载体验增量（2026-10-25，本批离线范围主审通过）

已实施新任务 lifecycleVersion=2：生成默认120/300秒，结果下载默认图片30/视频180秒，均可配置；生成成功且来源登记后结束生成计时，实际开始下载时再启动完整下载预算。旧任务保持版本1预算和历史结论。所有文件、来源刷新、验证和保存共享下载绝对截止，不在阶段切换续期。

新增 generationOutcome/generationFinishedAt 只表示生成完成，完整文件验证保存关联前不表示任务 completed。downloadAttempt.attemptNumber 区分首次与重试；waiting 的 startedAt/deadlineAt 为 null。进度 downloadProgress 与 remote progress 分离，字节/毫秒/字节每秒，未知总大小/比例为 null；普通采样500ms、3秒速度窗口、5秒停滞观察。来源URL/凭据不进入进度。

v9迁移保持旧checksum；旧四字段配置写入保留当前下载值且继续revision检查。原下载失败后显式重试使用新下载配置与attempt，不更改原生成事实和首次localOutcome，不重复生成POST。无ID签名链接加密未授权，保持旧限制。完整文件检查点、WS版本、卡片进度、配置输入、诊断导出尚在D04–D10。

实现与验证见 [D01–D03实施记录](implementation/D01-D03-独立下载预算与真实进度.md)。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。


## G01–G03 分组与保存事实补充（2026-10-27）

新提交接受groupId（省略为未分组），服务冻结groupId/groupName/groupDirectoryVersionId及根目录版本；服务生成字段纳入持久提交意图与localRequestId比较，旧快照字节保持。当前groupId/groupName/groupRevision、完整outputLocation与submittedGroupId/submittedGroupName分开投影。组重命名/归组不触碰原输入或生成记录，不创建上游生成请求。

v13保存不可擦除saved_at：只在正式成品已完整保存关联后登记；旧可信保存迁移登记。任务类别active/unfinished/completed以当前重下活动和保存事实区分，首次localOutcome不作成品库唯一条件。修改分组前必须排除真实在途IO（包含逻辑取消后未退出的IO），下载重试入队、执行和落盘前均按当前归属检查受阻整理，不能因旧快照名称重建旧目录。

详见[G01](implementation/G01-分组目录基础.md)、[G02查询](implementation/G02-成品查询与任务入口后端.md)及[G03实现记录](implementation/G03-归组迁移.md)；本节不授权真实生成或发布。
