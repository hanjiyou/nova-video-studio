# 持久存储与资产接口 v1

## 2026-10-27 视频最近任务显示设置（已实现，待主审）

workspace窄结构增加可选 recentVideoTaskLimit，仅接受数值型1–100整数；旧记录缺字段由界面默认6，不改写历史数据。复用app_settings及expectedRevision，无schema迁移；保存替换语义保持，Shell与导航共用串行队列、合并最新workspace，保留导航及宽度字段。此字段仅影响视频最近列表读取/展示和统计，不影响图片最近6条、作品库分页或taskExecution执行配置。非法值400、过期revision409，失败不写入；SQLite重新打开及loopback HTTP重启验证见[实施记录](implementation/视频最近任务数量设置实施记录.md)。

B4/T11–T13 追加 schema v6（旧迁移 SQL/checksum 保持），接入完整工作台和作品库，本批离线实现范围已由主会话复审接受，见 [B4 实施记录](implementation/B4-T11-T13-图片视频工作台与作品库.md)。历史按提示词/模型关键词、类型、状态分页；GET `/api/nova/storage/tasks/:id` 返回不可变快照详情。DELETE 同一路径只接 `{deleteOutputs:boolean}`，默认隐藏记录、保留去重事实和文件；明确选择清理时仅删除事务内复查后独占、可校验的 generated 输出。输入/草稿/其他任务/下载候选/旧别名引用及用户源文件受保护，非明确终态禁止移除。主审发现的跨 root_ref/assetId 同实体别名已修复：删除时解析全部现存受管文件的规范路径并归并资产别名，再检查该组所有引用；不靠新导入去重掩盖既有别名。同一实体只删/计数一次，独立目录里的相同字节不被错误视为同一文件。无法安全解析时保守保留。

窄提交意图 POST/GET `/api/nova/storage/submissions`、POST `/:localRequestId/attempt`、DELETE `/:localRequestId` 只保存/核对本地冻结输入与发送阶段，不调度或发送供应商请求。创建输入必须与持久意图相同；缺本地回执只读核对，不自动重发。重启不会自行继续未知意图。完整协议见 B4 记录；不把离线 fixture 升为真实能力。

B2/T08 已实现 schema v5、冻结输出目录、生产下载/完整解码与受管发布、Range、assetId另存定位；基础范围已由主会话审核接受并明确批准提交推送，见[B2审核](implementation/b2-evidence/approval-review.json)及[B2媒体契约](b2-media-v1.md)。本页下文保留T03/T05历史阶段说明，不再把“Range/验证待T08”当作当前实现状态。

T05 已以 schema v4 接入持久任务去重、派发/上游ID、查询预算和下载队列，当前任务接口见[任务服务契约](tasks-v1.md)。下文保留 T03 阶段边界；T04的schema v3及实际连接/凭据服务见[连接契约](connections-v1.md)。

T03只提供数据结构、宿主服务和受信接口。用户确认从未使用过原版Nova，本产品按全新安装处理；没有旧exe/data或浏览器资料的检测、导入、自动复制和提示。以下schema升级保护针对本定制应用自身，不是原版资料迁移功能。现有APPDATA测试目录保留，测试全部用隔离配置目录。

## 布局和升级

以桌面userData为根：nova-tasks.sqlite保存事实元数据，backups/schema-时间-UUID.sqlite及其JSON摘要保存升级前一致备份，storage/assets/摘要前两位/SHA256.扩展名保存对象。路径不随HTTP端口改变。NOVA_DATA_DIR/便携模式仍遵循T02优先级；没有新增用户备份或去重UI。

未版本化但可识别的本应用tasks结构被登记为v1，v2添加连接/连接版本占位、不可变任务快照字段、事件、资产与有序关联、草稿和设置。升级先使用SQLite在线backup API捕获已提交WAL页面，独立quick_check和SHA-256确认后，全部待迁移DDL、数据及版本登记在同一事务提交。备份失败不执行升级；SQL失败完整回滚；未知来源、未知更高版本或历史checksum不匹配拒绝启动，不清空/覆盖原库。没有待迁移版本时不重复备份或改版本。

这不是整个用户目录的备份管理功能。备份覆盖数据库；当前v2是加法式schema变化，不移动或删除已有对象。文件发布和SQLite不是跨介质事务：事务失败/进程崩溃可能留下未引用的受管对象，本阶段宁可保留它们，也不自动删除可能共享的文件。

## 元数据边界

| 数据 | T03行为 |
| --- | --- |
| connections / connection_versions | 结构和外键；版本不可更新/删除；不提供凭据服务或连接保存UI，T04接入 |
| tasks | 保留现有id/status/request_json兼容字段；增加local_request_id唯一约束、连接版本/能力/适配器/上游ID/输出引用和不可变input_snapshot_json |
| task_events | 有序追加；记录旧接口创建/状态观察和ACK，尚不是T05调度状态机 |
| assets | UUID、内容摘要、字节数、MIME、相对受管键、来源及可用性；路径仅宿主可读 |
| task_assets / draft_assets | 按position有序，同一资产可被多个任务/草稿引用，也可在同一序列重复出现 |
| drafts | image.text、image.reference及三个video模式分别保存原提示词、model、parameters、引用和revision |
| app_settings | 只接受theme/workspace/onboarding的窄结构，不接受Key、任意路径或原始响应 |

相同SHA-256/MIME/kind复用资产身份和物理字节，这是内部存储策略；没有增加用户去重功能。提示词不trim或改换行。草稿移除/排序只改引用。任务快照固定后不能再改变输入、连接版本或输出引用；更改草稿/当前连接不影响旧快照。T03未实现localRequestId重传去重返回语义、safeStorage、凭据读取、连接选择、能力验证或可靠任务恢复，分别由T04/T05接入。

## 受管文件

原PNG/JPEG字节直接复制，先写唯一.part并fsync，再用不覆盖的原子发布，最后登记元数据。新桌面生成结果和插件上传也进入受管对象；旧接口URL通过asset_legacy_links解析别名，不再写/覆盖同名相邻兼容文件。不搜索外部旧安装目录。Web继续使用原存储与TTL路径。

assetId必须是UUID，数据库中的storage_key也必须匹配受管格式。读取前验证realpath仍在管理根内，拒绝越界/符号链接，并核对长度与SHA-256；文件缺失/损坏保留元数据和引用，返回ASSET_MISSING/ASSET_CORRUPT。未知既有对象不被覆盖。公开AssetSummary只给相对previewUrl、摘要和媒体元数据，不返回真实路径。

availability=available表示文件存在，不表示媒体格式验证完成。validationState当前为unverified；PNG只读取基础尺寸，JPEG/视频时长等完整解码和下载验证由T08实现，不能把本阶段摘要检查当成合法MP4或完整本地completed证明。对象预算为应用自定100MiB、单个引用序列最多32项，不代表上游限制或首版模式允许张数；提交预检在后续阶段完成。

## 桌面HTTP接口

以下端点经过T02同一HTTP会话边界，Web不启用这些存储API。没有任意路径参数，也没有删除源文件操作。

| 方法/路径 | 输入/输出 |
| --- | --- |
| POST /api/nova/assets/import | 原PNG/JPEG二进制，Content-Type及可选x-nova-filename；返回AssetSummary |
| GET /api/nova/assets/:assetId | 元数据；缺失文件保留记录 |
| GET/HEAD /api/nova/assets/:assetId/content | 摘要核对后的字节，nosniff、private/no-store；Range/流式媒体服务留T08 |
| GET/PUT /api/nova/storage/drafts/:mode | PUT接收prompt、model、parameters、有序inputAssets及可选expectedRevision；GET返回草稿和素材摘要 |
| GET/PUT /api/nova/storage/settings/:key | 窄设置结构与revision；过期revision返回409 |
| GET /api/nova/storage/tasks?limit=50&offset=0 | 上限100的历史分页和total；没有原始request_json、Key或路径 |
| GET /api/nova/storage/tasks/:taskId/events | 有序事件观察记录 |

PUT的inputAssets是最小引用数组：每项只有assetId、role:'reference'和连续position。GET的素材摘要额外提供预览信息；保存时按上述最小引用字段构造DTO。参数/事件拒绝凭据、Base64、路径与原始URL字段，并限制JSON体积；这不是T04凭据实现。

preload新增importReferenceAssets()：无参数，宿主系统文件选择只接受PNG/JPEG，最多32项；批次元数据在事务中保存，只返回不透明资产摘要。每次IPC校验主webContents与主frame。源文件移动不影响受管副本。另存与定位仍明确返回ASSET_SERVICE_NOT_READY，留T08/T13，不假装已完成。

现有桌面图片任务可提交inputAssets引用，也兼容旧images瞬时输入，二者不能同时非空；正式inputAssets先从受管对象校验并读取；兼容images中的assetId不可信且不决定身份。两种入口都按实际上游字节导入/复用资产，入队前保存原字节、有序关联和不可变快照，Key仍只在旧兼容流程内存中临时持有。后续T04替换凭据入口，T05负责去重/调度/恢复。

## 保留规则和后续接入

桌面跳过原启动判失败/删图、任务TTL清理和插件素材TTL清理；ACK只记一次事件，不缩短历史；失败只改变旧任务状态，不删除共享输入。重启保留原状态和ID，当前不会自动恢复队列或补发POST；T05定义恢复动作。upstream_task_id及历史摘要upstreamTaskId目前是结构占位，旧插件ID仍在request_json，T05统一这些字段；不承诺旧摘要已补全。显式移除历史也不删除共享对象。Web原有启动失败标记、TTL和ACK语义通过单独回归保留。

旧工作台UI尚未全面改用这些API，不把原IndexedDB状态、导航草稿或作品库交互当成本阶段已验收。T09/T11/T12/T13接入实际界面。没有读取旧浏览器存储或真实Key，没有付费调用。
## B3 桌面草稿/导航接入

B3/T09 使用现有真实草稿/素材/设置服务，阶段记录见 [B3](implementation/B3-T09-T10-四页框架与首次引导.md)。桌面产品采用图片与视频三模式共四个草稿槽位；图片槽位保留可选参考图，提交模式由后续 T11 判定，API 原有 image.reference 槽位兼容保持。

workspace 窄结构追加 activePage（image/video/library/settings）和 returnPage（image/video/library）；仍拒绝任意字段、Key 或路径，没有 schema 迁移或历史数据扫描。持久化返回上下文用于设置页重启后返回原工作区；每模式 revision 串行保存，冲突显示错误并提供显式重读，不静默覆盖。

onboarding 继续只使用 dismissed/step。连接只读检查成功后的 defaults 及最终默认型号/完成状态在宿主事务中保存，见连接契约 B3 补充。B2 已提供正式 Range、另存与定位能力；本文件前段“留 T08”是 T03 原始阶段边界，不再描述当前实现状态。B3 仅接入四页骨架，不把完整作品库及生成/播放动作计作验收完成。


## D01–D03 下载体验增量（2026-10-25，本批离线范围主审通过）

已实施新任务 lifecycleVersion=2：生成默认120/300秒，结果下载默认图片30/视频180秒，均可配置；生成成功且来源登记后结束生成计时，实际开始下载时再启动完整下载预算。旧任务保持版本1预算和历史结论。所有文件、来源刷新、验证和保存共享下载绝对截止，不在阶段切换续期。

新增 generationOutcome/generationFinishedAt 只表示生成完成，完整文件验证保存关联前不表示任务 completed。downloadAttempt.attemptNumber 区分首次与重试；waiting 的 startedAt/deadlineAt 为 null。进度 downloadProgress 与 remote progress 分离，字节/毫秒/字节每秒，未知总大小/比例为 null；普通采样500ms、3秒速度窗口、5秒停滞观察。来源URL/凭据不进入进度。

v9迁移保持旧checksum；旧四字段配置写入保留当前下载值且继续revision检查。原下载失败后显式重试使用新下载配置与attempt，不更改原生成事实和首次localOutcome，不重复生成POST。无ID签名链接加密未授权，保持旧限制。完整文件检查点、WS版本、卡片进度、配置输入、诊断导出尚在D04–D10。

实现与验证见 [D01–D03实施记录](implementation/D01-D03-独立下载预算与真实进度.md)。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。


## 2026-10-27 分组目录最终设计补充（待实施）

存储目标：保存根目录/assets/剧本名/{图片,视频}/可读文件名；未分组为系统默认目录。新正式成品不采用摘要分片目录，校验摘要仍存记录。旧路径兼容、历史迁移显式发起；config/logs仅预留，不迁移现有数据或凭据。中文路径、Windows名称/长度/受管边界、文件引用及移动恢复按专项设计实施后验收。当前存储实现尚未切换。

详见[整体规划]( 剧本分组与作品任务管理整体规划.md)“最终目录设计与中文路径兼容”。


## G01–G03 分组存储当前实现（2026-10-27）

本节替代上方同题“待实施”阶段描述。G01–G03后端及跨层集成已通过主会话源码与定向离线审核，详见[整体主审记录](implementation/G01-G04-主审与整体验收.md)。组身份稳定，目录按根版本登记；默认未分组不可改名/删。新成品在`根/assets/剧本名/{图片,视频}/可读文件名`，内部导入/候选仍用摘要；老文件原地兼容读取，升级不搬迁。完整路径上限240 UTF-16单位，组名48，描述24，文件名100；实际文件IO及解码证据见[G01记录](implementation/G01-分组目录基础.md)。任务提交的根和名称冻结，当前归属/文件定位独立；根设置只影响新意图，显式归组仍留原任务根。

追加v12/v13，旧SQL/checksum保持。分组草稿与默认草稿兼容，所有清理纳入组内引用。曾完整保存事实saved_at不随首次失败或后续重下改变，作品查询与任务展示分别过滤。移动/重命名使用窄操作日志、完整校验、原子逻辑重绑与引用保护；恢复不覆盖用户替换文件，涉及组受阻时无关组/只读历史仍可用。诊断仅投影操作ID/类型/状态/组和任务ID/错误/时间，不导出计划、路径或组名。
