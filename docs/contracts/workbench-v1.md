# 工作台边界契约 v1

## 2026-10-31 作品库增强（源码与所列验证审核通过）

本轮用户批准悬浮预览、独立管理多选及日期筛选；本补充替代此前首版单项拖拽限制，保留整任务全部输出归组、共享引用及本地成品边界。详见[实施计划](../作品库增强实施计划.md)。

日期默认全部，今天/自定义自然日按操作者本地时区，以任务创建时间过滤；前端转换为包含开始、不包含结束的UTC createdFrom/createdBefore，后端分页前联合其他条件筛选。切换条件回首页且清空管理选择；参考图选择顺序继续保留。

管理多选按本页localTaskId，不借用最多7张参考图限制。全选当前页、清空、退出、批量按钮和整批拖拽共用处理；固定范围、目标及归属版本，逐项复用幂等归组。处理时锁定会改变操作范围的控件，按项显示结果；部分失败保留已完成项，未知回执保留原请求核对。全部作品/归档/待恢复组不可投放，同组跳过。卸载后停止派发后续项。

视频封面约250ms停留后原位静音循环，全库最多一个；离开/失焦/隐藏/视口外/筛选翻页/拖拽/多选/弹窗/卸载停止，移动前释放媒体源。迟到加载不得重新开始，缺失/解码失败保留提示与原操作。双击和键盘大预览继续使用原生控件。

开发及验收状态以[主会话审核](../implementation/作品库增强主会话审核.md)为准，本节不代表已经发布。

## 2026-10-28 模型显示配置（开发中）

设置“连接与模型”采用图片/视频双列勾选管理，搜索不影响勾选统计，保存/取消明确区分。当前连接可见目录按分类显示候选；新型号默认未勾选。默认型号来自显示配置，只作用未保存新草稿。显示名单为空时提示配置，不擅自回退预置型号。

当前草稿型号被隐藏时保留原值并标“已隐藏”，不再作为可选项；模型下方显示原因和选择操作，保留提示词/参考图/历史结果，用户明确换型后才恢复正常提交检查。历史任务和下载恢复不因隐藏改变。并发修改/切连接/刷新迟到响应不得覆盖已保存新状态或当前输入。

视觉、接口、报价组和通用图片协议详见[实施计划](../模型显示配置与通用图片接入计划.md)。本节替代旧全目录自动进入生成下拉的行为，不代表已经发布或完成真实生成验收。

## 2026-10-27 视频最近任务数量设置（已实现，待主审）

应用设置的“工作台显示”提供最近视频任务数量，保存到 workspace.recentVideoTaskLimit，默认6，允许1–100整数；旧配置缺字段按6读取。保存后视频列表、处理中和等待处理统计立即使用同一数值并跨重启保留，读取limit覆盖所设数量（20不被原12条截断）。图片仍显示最近6条，作品库分页与预览保持。本补充替代此前视频固定最近6条的行为；下方前轮预览契约中的“最近6个规则保持”是当时阶段记录。

显示设置与导航共用原workspace串行队列，按最新值合并patch并携带expectedRevision，不覆盖activePage / activeMode / returnPage / wideMode；不混入taskExecution。非法值前后端拒绝，失败保留输入、不显示成功；revision冲突须显式重读，未保存和保存中阻塞更新安装。配置改变及时刷新，旧kind / limit回执不覆盖新列表，在途读取结束立即补读；原手动选中较旧任务保留。见[实施记录](../implementation/视频最近任务数量设置实施记录.md)。

## 2026-10-27 作品库预览与独立详情

作品库卡片封面 / 内容区鼠标单击不再打开详情；双击在当前页面上方打开首个输出的预览，聚焦后 Enter / Space 同样打开。卡片下方“任务详情”单独调用原详情入口，与选图 / 移除操作独立。现有类型 / 状态下拉、搜索、分页、图片选择顺序、删除及最近 6 个规则保持。

图片按原比例 contain；视频使用原生 controls，不自动播放。仅使用受管本地资产的 previewUrl，不展示远端结果源，不扩展多文件画廊。预览复用现有 WorkbenchDialog / AssetActions；X、Esc、遮罩关闭后停止视频并释放播放源，关闭不重置底层筛选、页码或选择顺序，兼容 StrictMode effect 重放。

无输出、未保存、下载失败、文件缺失 / 损坏及媒体加载 / 播放失败必须显示中文原因，不保留空播放器；独立详情保留现有恢复入口，预览不触发生成或自动重下载。实现、离线验证与实际播放验收边界见[实施记录](../implementation/作品库预览与详情实施记录.md)。

## 2026-10-26 时长与生成条件引导（已实现并主审）

原时长输入旁使用紧凑同高次级操作，显示当前连接/型号真实默认值；修改本次时长不自动持久化默认，保存成功才显示“已设为默认”，失败和迟到回执按当前身份隔离。禁止将无效值保存或重复提交保存。

生成按钮的禁用状态与可见原因共用条件来源，保留原模型能力与提交保护。单图1张、多图2–7张；缺图和空描述可同时说明；数量符合不绕过连接/模型/参数/素材检查。忙状态及父级提交限制也必须有可读说明，原footer内与按钮相邻，不依赖悬停提示。

原因右侧操作按钮复用导入、设置、保存重试或滚动聚焦输入；它们不触发生成、不自动删引用、不重发请求。处理后自动更新说明，只有用户明确点击生成才创建任务。详细任务与验收见[实施计划](../模型清单与参数费用联动实施计划.md)。


## 2026-10-26 中质量参考价（已实现，源码与定向验证主审通过）

图片页原费用位置显示“中质量参考价”、动态数字“0.12/张”、“本次 1 张 · 参考费用 0.12”及“按中质量分组报价，实际扣费以服务结算为准。”示例数字来自当前公开基础价1×中质量倍率0.12，不能写死。无币符、无汇率换算、无分组区间；保留合理精度和合法0。

仅精确flare中质量分组报价，不查询Key归属或历史账单，不改变生成分组及图片质量参数。尺寸/质量不参与计价。首次初始化或实际模型刷新时更新；页面重挂载/提示词/参数变化不触发重复外呼。切连接/Key/线路/型号隐藏不适用价格并忽略旧回执。缺资料显示不可用并引导刷新模型，不用0或其他组替代；不阻止原生成。视频现有计价保持。见[需求与任务](../模型清单与参数费用联动实施计划.md)。


## 统一访问线路与界面补充（2026-10-26）

内置OpenSosen设置新增国内cn默认、国际com线路；使用不可变原连接身份，切线不换connectionVersionId、不重输Key。仅精确内置HTTPS源支持，显示实际所选只读地址与 `/models` 目标；自定义源保留可编辑地址且改地址需Key。旧宿主摘要缺线路字段时保留原baseUrl与目标，不伪报cn支持。

ConnectionSummary/models增加routeSupported、route、routeRevision，任务与downloadAttempt增加可空transportRoute快照。前端保存/候选验证携带route及现有连接expectedRouteRevision；只读check携带已知修订。线路改变参与dirty、更新安装阻止、候选取消及首次引导修订保护。设置表单绑定稳定connectionId；冲突重新读取同步外层当前连接并保留输入，须再次明确保存，不因版本更新重建表单而丢失Key/名称/线路。

模型清单仅接受匹配当前connectionVersionId和已知route/revision的回执；缺新字段的旧摘要按兼容路径处理。旧线路明确型号拒绝不得刷新新线路。该判陈旧规则只用于设置/清单，不能丢弃已发出生成请求的结果。

线路保存后用于新建任务和后续查询、新的下载尝试；已发出请求保持原线路，不中断、不重复生成，旧任务仍用原版本Key。cn的 `transportEvidence=generation_unverified`，com的 `see_capability_evidence` 仍需看具体模式证据，不能宣称全部验证。线路不控制VPN、不保证速度；真实cn生成与媒体下载仍待验证。第一批已主审、第二批源码与离线范围主审通过，详见[实施记录](../implementation/R06-R08-统一线路界面与整体验收.md)。

## 模型清单与参数费用补充（2026-10-25）

本节补充本轮已实现规则，原任务标识、凭据和不可变快照约束继续有效；详细证据见[实施报告](../implementation/模型清单与参数费用联动实施报告.md)。

- 型号可见性、图片/视频分类和实际生成能力分别管理。分类优先用户覆盖、明确端点、严格型号规则；手动添加/分类不赋予生成能力，工作台与默认设置共用分类结果。
- 缓存按连接版本隔离，成功有效期 10 分钟，失败退避 30 秒。同版本刷新合并；已有刷新先等待，最近失败不沿用旧成功有效期阻止恢复。畸形响应整次拒绝并保留缓存，合法空列表仍可表示型号缺失；切换连接后丢弃迟到结果。
- 明确型号拒绝使任务失败并触发清单同步，不重发生成请求。前端同步成功才标记该拒绝已处理，失败后借已有任务列表更新按退避规则重试。旧任务保留原连接、能力与输入快照。
- grok-imagine-video-1.5-6s 支持 1–6 整数秒、默认 6 秒，所有模式不发送 size，配置估价为每秒 0.05 元。Preview 参数预备支持 1–15 整数秒、默认 10 秒及候选/自定义尺寸，估价每秒 0.20 元；真实生成仍关闭。
- 支持直接输入时长、保存型号默认时长及实时估价；价格来自配置，图片价格未知，不把估价视为实际账单。保留原工作台布局；旧草稿的冲突参数提示用户处理，不静默改写。

离线验证通过不代表所有新参数已有真实服务证据，也不代表本轮已经打包发布。


日期：2026-10-23。状态：T01 已由主会话审阅冻结；本文件描述规范边界，具体接口实现进度以各阶段记录为准，不表示全部业务接口已完成。

## 1. 标识、所有权和不可变快照

| 字段 | 语义与责任 |
| --- | --- |
| connectionId | 本地 UUID，稳定连接档案标识，不随编辑地址/Key 改变 |
| connectionVersionId | 本地 UUID，每次保存有效配置创建不可变版本；包含规范化 baseUrl、provider、credentialRef、时间，旧任务始终引用原版本 |
| credentialRef | 主进程受控凭据库内的 opaque 引用，既不是 Key，也不是可由 UI 任意解引用的文件路径 |
| localRequestId | UI 在创建一个新任务意图前生成的 UUID；持久化本地唯一约束用于双击/重传去重。同 ID 同快照返回原任务，不同快照返回 LOCAL_REQUEST_CONFLICT；用户明确新建任务才换 ID |
| localTaskId | 后端持久化生成的 UUID，是库、事件、输入/输出和诊断的主标识；不使用远端 ID 作为主键 |
| upstreamTaskId | 上游创建后返回的 opaque 非空字符串，可以缺失；必须可安全表示为单一路径段，纯 . / .. 不接受；必须与 connectionVersionId 一起使用，不能拼接成任意 URL |
| assetId | 本地 UUID，只指向受管理素材/结果；UI 和插件提交资产引用，不能提交任意磁盘路径 |
| capabilityVersionId | 每次任务快照引用的能力记录版本，作用域至少包括服务源、完整模型、模式、协议和参数组合 |

`localRequestId` 只提供应用本地去重，不是服务端幂等键。当前线路上游幂等未验证，不自动添加或依赖 Idempotency-Key；进程崩溃或 POST 传输失败仍可能导致结果不明。去重记录随任务持久化，不能像响应缓存一样在 ACK 后删除。

任务快照至少包含 contractVersion、localRequestId、connectionVersionId、capabilityVersionId、类型/模式、完整 model、prompt、规格、按顺序排列的 inputAssets、adapterId/adapterVersion、outputDirectoryVersionId/outputRootRef。输出目录版本/根引用随任务快照冻结，绝对路径仅宿主可见，修改保存目录不改变旧任务或旧下载目标。输入快照在入队前保存，后续修改草稿、默认模型或连接不改变它。

## 2. UI、桌面与凭据

UI 读取 ConnectionSummary：connectionId、connectionVersionId、displayName、baseUrl、hasCredential、credentialState、validationState、lastCheckedAt、lastSuccessAt、modelsFetchedAt。不得返回 Key、密文、credentialRef 的存储路径或包含 Authorization 的原始请求。

保存连接时 Key 仅作为窄桌面方法的瞬时输入，在主进程用 safeStorage 加密；保存完成清空 UI 输入，不进入 localStorage、IndexedDB、草稿、任务快照、HTTP/WS广播或诊断。已有凭据使用 hasCredential 显示，不以掩码回写。后端只通过可信内部服务获得受限的临时凭据访问；适配器构造安全请求描述，鉴权由宿主注入，不能让页面长期持有 Key。

连接检查只调用适配器支持的只读接口。检查结果绑定内存配置修订号；地址/Key/预设变化后丢弃旧结果。模型可见性、连接检查、某模式能力证据分开记录。草稿创建和进入工作台不发付费请求。

文件动作只接收 assetId 或由系统对话框产生的导入句柄：导入后复制到管理目录；另存、定位、预览由宿主解析。草稿移除引用不删除源文件。输出目录变更只影响新任务。

本地 HTTP/WS 的会话授权、来源限制、IPC 实际方法/路由由 T02 实现；本阶段没有开放新生产端点，也不弱化现有插件的内网访问限制。

## 3. 模式、输入和资产

规范模式：image.text（0 图）、image.reference（至少 1 图，具体能力待验证）、video.text（0 图）、video.single_reference（恰好 1 图）、video.dual_reference（首版恰好 2 图）。切模式分别保存草稿，不能为了适配新模式静默裁掉参考素材。

2026-10-24 用户授权扩展：UI 将原双图入口改名“多图参考”，继续使用原 `video.dual_reference` 草稿槽；2 张仍提交原模式与已验证能力，3 至应用预算张数在提交时解析为新增 `video.multi_reference`，不改写历史“双图恰好 2 张”证据。视频多图预算独立集中于 `backend/storage/application-limits.json` 的 `maxVideoReferenceAssets`，按用户要求设为 7，允许配置范围 3..7；通用素材导入/存储的 `maxReferenceAssets` 保持原 32，不裁减历史素材。7 张是应用限制，供应商最大张数仍未知。

新模式仅允许 `opensosen` / `https://newapi.opensosen.com/v1` / `openai` / `grok-imagine-video-1.5-6s` / 插件 1.1.0 下，独立版本 `opensosen-multi-reference-unverified-2026-10-24-v1` 的明确用户操作提交；能力继续标记 unverified、applicationVerified=false，显示未实测与可能失败/计费提示。此窄例外不放宽通用证据判定。原图按顺序使用同名 `input_reference` multipart 文件部件。

1.0.0 旧任务仅原文生/单图/双图模式允许精确兼容恢复和同 localRequestId 重放，保存的快照字节不变；1.0.0 不支持新增多图模式。实现与离线验证见 [多图参考扩展记录](../implementation/多图参考扩展-离线实现与验证.md)。

`inputAssets` 是有序数组：`{assetId, role:'reference', position:0..n-1}`，position 连续且不重复。界面序号为 position+1，数据库、请求部件和预览使用同一顺序。草稿/快照的提示词保留原始文本。WHATWG FormData 的普通文本字段按 multipart 规则将行结束符规范为 CRLF，传输测试核对这一表示及逻辑换行/中文/引号；不得丢行、删改对白，协议规范化不回写草稿。原始 JPEG/PNG 字节直接进入 multipart；缩略图不代替原图，不能自动压 WebP。张数/字节/像素限制明确属于 applicationLimits，不能假称供应商上限。

AssetSummary 返回 assetId、kind、mimeType、byteLength、sha256、width/height、durationSeconds（视频可选）、availability 和受控 previewUrl。真实路径只在宿主/库层保存。媒体缺失保留任务和元数据，标记 missing，不能假装任务从未存在。

## 4. 本地任务状态与恢复

2026-10-25 I01 已新增图片/视频生命周期数据契约（待主审），详见 [任务契约 I01](../tasks-v1.md)。新增配置/DTO/时限快照与 v7 迁移不表示 I02–I07 的并发、整任务中止、取消、恢复或展示移除已启用；下文保留当前 T05 运行基线。

以下是规范本地 state 值；旧文档中的 succeeded 与此处 completed 表示同一本地完成语义，后续存储/API 使用本表，原版旧状态需在迁移边界映射。

| local state | 意义 | 恢复/后续操作 |
| --- | --- | --- |
| local_queued | 快照已持久化，尚未开始创建 | 首次重启恢复等待用户继续；可 local_cancelled |
| submitting | 已持久化调度占位，正在创建 | 先持久化 dispatch_started，再调用传输；未知结果不自动创建第二次 |
| submission_unknown | POST 可能到达上游，但没有可可靠使用的 ID/同步结果 | reconcile_submission；支持核对记录、用户提供已知ID、明确新建；禁止自动 POST |
| remote_queued | 已持久化上游 ID，远端排队 | GET 同一 ID |
| generating | 远端生成中，或原同步图片请求仍在等待 | 有 ID 只 GET；同步图片中断且无 ID 转 submission_unknown |
| polling_paused | 本地停止查询，或鉴权/断网/未知状态导致查询暂停 | 保留 ID、rawStatus、原因；恢复查询同一 ID，不 POST |
| remote_completed | 上游报告完成且返回候选结果 | 进入下载队列，不能显示为本地已完成 |
| downloading | 写入 .part、校验、原子落盘进行中 | 下载独立低并发，可重启恢复，不重新生成 |
| download_failed | 结果未成功保存/验证 | retry_download；必要时 GET 原任务刷新资源，不能 POST |
| completed | 受管理正式文件存在，类型/图像或媒体可读性验证通过，元数据已持久化 | 可离线预览、另存、定位和复用；仅 HTTP200/进度100/远端completed 不足以到达此状态 |
| failed | 输入/能力预检被拒、明确创建拒绝、远端明确失败等已有确定结论 | 错误分类决定编辑/核对；用户重建是新任务 |
| local_cancelled | 尚未派发的本地队列取消 | 没有上游生成请求 |
| remote_cancelled | 上游明确返回取消状态 | 不推断退款或已停止计费；本客户端未验证主动取消接口 |

RemoteStatus 单独保存 rawStatus 及规范 remoteState：queued、generating、completed、failed、cancelled、unknown。未知状态保留原文并暂停/有界查询，不能猜成 failed 或 completed。

T05 期间用户明确批准的调度规则：已派发且处于 submission_unknown 或 polling_paused、远端可能仍生成时，继续保留唯一生成占位。后续未派发队列等待同一上游任务明确完成、失败或取消；不得以本地超时、断网、鉴权失败或停止查询自动释放占位并派发下一收费 POST。DTO 提供 generationReserved、remoteMayContinue、pauseReason、schedulingNotice；后续界面说明远端可能仍生成或计费。已确认 remote_completed/download_failed 可释放生成占位，下载队列独立。尚未派发的凭据暂停不占远端生成名额，可取消本地排队。

“停止查询”仅将本地查询置为 polling_paused，远端可能继续；它与“取消远端”不是同一操作。当前不定义远端取消端点，也不承诺费用退还。排队取消必须在持久化派发检查前确认，不能把已 dispatch 的任务伪装为 local_cancelled。

恢复判据：没有 dispatch_started 的队列可手动继续；已 dispatch 且无可用 ID 为 submission_unknown；有 ID 的远端任务仅 GET；下载中的结果仅恢复下载；completed 保留原文件和历史。任意通信异常不能凭空证明 POST 没有发送。

## 5. 错误与重试

错误 DTO：`{code, phase, message, httpStatus?, retryAction, transmission, localTaskId?, upstreamTaskId?, providerRequestId?}`。phase 为 validation、credential、submit、poll、download、storage、media。transmission 为 not_dispatched、may_have_reached_upstream、response_received、not_applicable。

| code | 语义 | retryAction |
| --- | --- | --- |
| INPUT_INVALID / CAPABILITY_UNVERIFIED | 提交前验证失败，未调用网络 | edit_input |
| LOCAL_REQUEST_CONFLICT | 相同本地请求ID对应不同快照 | none |
| CREDENTIAL_REQUIRED / CREDENTIAL_UNAVAILABLE / AUTH_REJECTED | 缺失、解密失败、401/403；已有ID保留 | reauthenticate |
| SUBMISSION_UNKNOWN | POST传输异常、超时、断流或可能已创建的5xx | reconcile_submission |
| REMOTE_REJECTED | 有完整明确拒绝响应、无任务ID | edit_input |
| POLL_TRANSIENT / RATE_LIMITED | GET网络/临时错误，保留ID；429可读取可信Retry-After | retry_poll |
| REMOTE_STATUS_UNKNOWN | 未识别远端状态/响应格式，保留原文 | retry_poll |
| REMOTE_FAILED / REMOTE_CANCELLED | 上游明确结果，不推断退款 | none |
| DOWNLOAD_FAILED / DOWNLOAD_EXPIRED | 下载网络/资源错误 | retry_download |
| FILESYSTEM_ERROR / MEDIA_INVALID | 磁盘、占用、不可写或文件不合法 | retry_download |

GET 查询默认约20秒间隔；临时网络/429重试使用有界指数退避和抖动，建议上限120秒、单轮最多5次重试或累计10分钟（先到即暂停）。可信Retry-After按秒数或HTTP日期解析；在本地等待预算内遵守该时间，缺失/无效时使用本地退避。有效Retry-After超过120秒或剩余预算时，不截短后提前请求，而是转 polling_paused，保存notBeforeAt和等待原因。其他超出重试预算的情况也暂停并保留ID，用户可在允许时间恢复同一ID查询。以上为客户端可配置策略，不是供应商承诺；429/失败样本在mock中为合成数据。

POST 429 与 GET 策略分开：不按 Retry-After 自动重新创建。有完整明确拒绝且无ID时保留REMOTE_REJECTED；任何响应/提交结论不明则SUBMISSION_UNKNOWN，交给用户核对。retryAction 是可执行操作类别，不等于自动立即重试；创建请求始终默认不自动重发。调用 fetch 前的受控预检异常可证明 not_dispatched；fetch 抛错、连接被断开或超时默认 may_have_reached_upstream。不能把 ECONNRESET/DNS/TLS 等客户端异常统一当成未发送并重建任务。

响应摘要只保留允许字段、HTTP状态、有限长度脱敏错误和追踪ID。嵌套JSON错误按有界层数解析；不保存/导出Key、Authorization、完整Base64、输入原图或带敏感查询参数的资源URL。诊断可包含资产ID/哈希和脱敏参数。

## 6. 适配器边界

| 接口 | 输入 | 输出与约束 |
| --- | --- | --- |
| buildSubmit | 不可变任务/能力快照、按序资产描述 | `{method:'POST', url, encoding:'json'或'multipart', json?或parts?, auth:{connectionVersionId}}`；不自动执行网络 |
| multipart parts | 有序 `{kind:'field',name,value}` 或 `{kind:'file',name,assetId,fileName,mimeType}` | 宿主读受管资产，按顺序append，由FormData生成boundary；禁止任意文件路径 |
| parseSubmit | HTTP状态、脱敏前的临时响应及任务上下文 | accepted + 非空upstreamTaskId，或同步image的immediate结果源；空ID/空结果不代表成功 |
| buildPoll / parsePoll | 连接版本、原upstreamTaskId / 响应 | `{remoteState,rawStatus,progress?,resultSources?,error?}`；不改变local completed |
| ResultSource | `{kind:'url',url,authScope}` 或临时 `{kind:'inline',bytes,mimeType}` | 给下载/资产服务，不把远端URL当永久作品，不广播原始Base64 |
| completeLocalAsset | 原子落盘证明、sha256、类型、宽高/时长和assetId | 只有该证明完成后任务才可 local completed；具体服务由T08实现 |

创建、查询、下载鉴权范围分别定义。只向连接允许的精确服务源注入Key；CDN和每一跳重定向重新判断，不将中转Key转发到任意资源域名。插件 JSON 路径保持兼容，multipart 在 T07 扩展；此处尚未实现新插件或生产传输。

## 7. 协议证据等级

见 [OpenSosen 协议证据](opensosen-evidence-v1.md)。historically_verified 表示历史成功记录，unverified 表示无原始成功证据，rejected_combination 只表示该请求组合被拒绝。mock_passed 仅证明测试支撑有效，不能把上游能力升级成已验证。

所有能力绑定 provider/baseUrl + 完整model + 模式 + 协议 + 精确参数 + 证据版本；切换服务源不继承别处的验证。flare参考图、两个型号的文生原始请求等缺口保持 unverified，T15执行真实线路验收后才能记录本应用链路通过。


## 8. 图片规格与单图编辑（2026-10-24 增量）

图片适配器为 `opensosen-flare-image@1.1.0`。无参考图、`parameters={}` 仍绑定原已验证最小生图能力，只提交 `model/prompt/n=1`。指定尺寸或质量时选择新增独立能力；有一张参考图时选择单图编辑能力。新增能力限定 `opensosen` / `https://newapi.opensosen.com/v1` / `openai` / `gpt-image-2.5-flare`，版本为 `opensosen-image-controls-unverified-2026-10-24-v1`，始终为 unverified、applicationVerified=false；通用证据判定及原最小能力排序不变。

尺寸仅支持 1024x1024、1536x1024、1024x1536，质量提供自动、low、medium、high、xhigh、max。自动在任务参数中省略；比例按钮与尺寸共用同一个 size。文生图为 JSON `/images/generations`，参考图编辑为 multipart `/images/edits`，固定一个 `image` 原始 PNG/JPEG 文件部件，不重编码、不缩图、不尝试 `image[]` 或其他格式回退。未知参数、额外参考图、错误参数组合在派发前拒绝，草稿不静默删改。

只对精确 1.0.0 最小图片快照兼容恢复；同 localRequestId、同输入返回原任务，不修改已保存快照，不因升级重发。请求结果未知时保留占位；图片同步结果不虚构上游 ID。结果沿用原 Base64/URL 安全落盘和媒体校验链路，可预览、另存并带入图片编辑草稿。详细验证见 [图片参数与单图编辑记录](../implementation/图片参数与单图编辑-离线实现与验证.md)。

## I02–I04 当前运行契约（2026-10-25，主审通过）

本节覆盖下方 T05 / B1 / I01 原始阶段中唯一占位、串行下载、无总截止和自动恢复 GET 的历史行为；保留其他仍适用的去重、原连接 / 适配器、结果验证与安全边界。详细实现和命令见 [I02–I04 实施与验证](../implementation/I02-I04-独立并发截止与恢复.md)。

- 图片 / 视频分别默认 3 名额，覆盖真实派发到验证保存，分别默认 120 / 300 秒总预算。创建保存时限快照，派发保存不可变 attempt / deadline；队列时间另算，阶段 / 退避 / 查询暂停不续期。
- cancel 停止本地等待，原子终态、释放逻辑名额并保留未知远端与已持久 ID；取消 / 超时不自动 POST，迟到响应 / 保存不绑定输出。真实 IO 单独追踪，更新仍等待它们和清理退出。
- 每视频同 ID 最多一条在途 GET，stop-polling 保留原名额和截止；resume-polling 仅同 ID 未结束 / 未过期任务，遵守 Retry-After 与原查询预算。重启后有 ID 新任务需要用户显式恢复，剩余时限不重置。
- 旧无 deadline 活动记录一次性本地结束，保留远端未知、真实 ID 与原快照；不补造旧预算，不静默 POST / GET。未派发队列保留 requiresContinue；新任务安全结果下载恢复也须显式 continue-queued，签名来源丢失且无 ID 明确不可恢复。
- retry-download 是独立预算 / 独立 attempt，只重取原结果，不重新生成。原 localOutcome / localFinishedAt 和生成 deadline 不改；downloadAttempt.{active,outcome,startedAt,deadlineAt,timeoutSeconds,finishedAt} 表达新下载活动和结论。localExecutionActive / downloadAttempt.active 用于取消和移除保护，不可只看原 localOutcome。名额已满返回 TASK_CAPACITY_BUSY。
- v8 追加下载尝试表和本地终态不可变约束，复用原备份 / 事务体系，v1–v7 checksum 不改。I05 移除、I06 完整诊断、I07 界面和 I08 真实交付仍未完成。

## I05–I07 任务展示、诊断与交互（2026-10-25，待主审）

本批实现与离线验证完成，尚未主审验收；详见 [实施报告](../implementation/I05-I07-任务移除阶段诊断与交互.md)。沿用已通过 I01–I04 的调度、截止和恢复，不授权 I08 打包、安装、真实生成或发布。

- GET /api/nova/storage/tasks 显式支持 scope=workbench（默认）与 scope=library。两者继续过滤旧 workbench_hidden_tasks，只有 workbench 过滤 workbench_removed_tasks；旧隐藏不恢复。工作台最近图片/视频与任务卡片使用前者，作品库显式使用后者。
- POST /api/nova/storage/tasks/:id/remove 只接受 {}，服务确认结束后新增展示移除标记，返回 {removed:true,worksRetained:true}。活跃生成、排队和独立下载尝试均返回 TASK_ACTIVE，必须先取消并等待确认。不会删除任务、localRequestId、输入快照、输出关联或物理文件；GET 单条仍可读，DTO 的 removedFromWorkbench 只表达展示移除。
- 原 DELETE /api/nova/storage/tasks/:id 的 {deleteOutputs:boolean} 仍是作品库隐藏/可选独占文件删除入口，继续保留物理别名和共享引用保护，与新的任务展示移除区分。
- 设置页的“任务控制”独立于连接配置显示。图片/视频并发各默认 3（1–5）；时限默认 120/300 秒（30–1800）。保存完整对象和 expectedRevision；读取/保存失败保留输入，修订冲突要求明确重新读取，未保存输入或保存中阻挡更新安装。并发只影响后续入场，时限只影响新任务快照。
- 卡片与详情按 phase/remoteState 显示观察到的阶段，无虚构百分比。排队与生成执行时间分列；生成结束按 localFinishedAt 冻结，下载重试另按 downloadAttempt 计时。原 localOutcome 不充当当前下载的终态；取消与移除使用 localExecutionActive/downloadAttempt.active。
- stop-polling 只暂停同 ID 查询，保留原时限/名额；resume-polling 仅未结束且未过期任务。cancel 停止本地等待。旧无 ID 图片无需补造 ID 或轮询能力；远端可能继续生成或计费。
- 创建收到本地 ACK 即释放创建锁，详情读取和意图清理可继续。提交指纹/持久意图保持；未知 ACK 不重发。提交序号与核对序号避免旧 finally、迟到列表或详情干扰下一次提交和另一模式的选择。展示移除后清理选择/详情，迟到 GET 或旧列表不能复活它；从作品库仍可打开作品。
- 阶段诊断按白名单采集与导出，生成和最新下载独立摘要，最多 96 条诊断边界加两条摘要；视频查询只累计有限计数/错误分类，不逐次添加接收/解析阶段。阶段时长使用单调观察值，未知为 null；重启未观察区间不从墙钟推算。排队时长明确为 wall_timestamp_estimate。详见 [诊断契约](../diagnostics-v1.md)。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](../implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。


## 2026-10-27 分组目录最终设计补充（待实施）

界面目标：剧本保存位置与分组管理显示“保存根目录/assets/剧本名/图片或视频”；中文名与磁盘对应，可读文件名不暴露摘要分片。作品改组同步移动结果文件与引用；历史文件整理需用户显式发起。config/logs只预留，不新增配置或日志页面。本项为待实施设计，不改变当前版本状态。

详见[整体规划]( ../剧本分组与作品任务管理整体规划.md)“最终目录设计与中文路径兼容”。


## 分组接口与库/任务范围（G01–G03，2026-10-27）

GET/POST `/api/nova/storage/groups`读取/创建（仅name）；GET/PUT `/groups/:id/drafts/:mode`隔离草稿，旧`/storage/drafts/:mode`为未分组别名。workspace.activeGroupId持久选择仅接受已登记groupId。组返回groupId/name/isDefault/archived/outputLocation/workCount/taskCount/recoveryRequired；默认ID固定为`00000000-0000-4000-8000-000000000002`。

`GET /storage/tasks`的scope=library只查正式输出+保存事实，workbench保留全部可见任务；groupId与category=active/unfinished/completed在SQL分页前生效。library隐藏与任务展示移除相互独立。task提供groupRevision（归属乐观锁）、当前与提交时组名、savedAt、taskCategory；当前task.revision在归组/重命名后递增。

POST `/storage/tasks/:id/group`接收groupId/requestId/可选expectedRevision（groupRevision），返回当前task及操作回执。POST `/groups/:id/rename`接收name/requestId；POST `/groups/:id/archive`接收archived；DELETE `/groups/:id`只删空自建组（逻辑墓碑保留历史，名称可重新使用）。GET `/groups/history-preview?groupId=`返回明确taskId、source/target及冲突；POST `/groups/organize-history`仅处理已选taskIds/requestId并逐任务报告成功/失败。历史整理与菜单/拖拽复用同一安全服务。

GET groups为纯状态读，含安全recovery摘要；POST `/groups/recover`仅接收{}显式重试整理恢复。未恢复只阻止涉及组/任务的提交及变更，无关库/任务可读。上述均为本机受保护接口，页面不传任意路径；完整路径仅作本地展示/明确历史预览，不进入诊断。

## G04 当前界面行为（2026-10-27）

作品库采用分组导航及媒体类型/搜索联合筛选，移除任务状态筛选；保留已保存后缺失/损坏记录。生成页最近任务按当前组与创建时间倒序展示全部状态，视频数量设置默认6、范围1–100；查看全部任务支持分页、当前/全部组及进行中/未完成/已完成分类。分组切换须先保存草稿，失败不切换，迟到响应不覆盖新组。

整任务卡片采用cover封面，媒体预览contain；双击预览，独立任务详情按钮。单卡拖拽与菜单改组共用服务和操作身份，移动期间防重复；被选参考图片归组成功后重映射资产ID且保留顺序。归档组保留历史且禁止新提交，删除当前组后回到未分组/合法筛选。

下载阶段在卡片集中呈现，可信总量才显示百分比，停滞速度归零，100%字节不代表校验保存完成。历史整理预览后显式执行，受阻恢复只影响相关组。见[使用说明](../剧本分组与作品整理使用说明.md)与[主审记录](../implementation/G01-G04-主审与整体验收.md)。
