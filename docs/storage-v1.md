# 持久存储与资产接口 v1

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
