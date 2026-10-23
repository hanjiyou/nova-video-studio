# 持久任务服务与恢复接口 v1

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
