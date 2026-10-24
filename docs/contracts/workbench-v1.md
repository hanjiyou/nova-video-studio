# 工作台边界契约 v1

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
