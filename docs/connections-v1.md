# 连接、凭据与能力接口 v1

T05 已接入原版本凭据闸门、完整查询暂停和保守占位，动作语义见[任务服务契约](tasks-v1.md)；不会把旧损坏/撤销版本重绑到新凭据。下文保留 T04 的原始阶段边界。

T04提供宿主服务和接口基础，图片、视频使用同一个默认连接。完整设置表单和首次启动界面由T10接入；生成适配、完整队列与恢复由T05–T08接入。本阶段不读取、导入或迁移旧版exe/data、localStorage或IndexedDB中的凭据。

## 存储与凭据

schema v3在T03的升级前一致备份/单事务机制上增加credential_entries、connection_preferences、connection_defaults、connection_checks和model_capabilities；v1/v2 SQL及checksum保持不变。凭据表只保存Electron safeStorage密文，不保存Key明文；真实Windows检查覆盖加密、重启解密及损坏密文。系统加密不可用、Linux basic_text或加密失败时拒绝保存，没有明文回退。其他系统的原生安全存储尚未实际验收。

页面只通过窄preload方法瞬时传入Key。ConnectionSummary不返回Key、密文或credentialRef；后端通过宿主注入的内部vault读取临时凭据，没有环境开关、HTTP或IPC读Key方法。Node HTTP测试注入的AES测试替身只存在于backend/test/support，不进入安装包；实际Electron使用真实safeStorage。

每次保存创建新connectionVersionId，固定规范化地址、provider、credentialRef、协议和图片/视频默认模型；版本、偏好和能力记录都有不可变约束。稳定connectionId只指向当前版本。省略apiKey可在同一地址沿用原凭据，空字符串不作为掩码或清除操作；改地址必须重新输入凭据。不同Key保存为独立密文引用，旧任务不会读取当前默认连接或新Key。地址只接受不含userinfo、查询和片段的HTTP(S)基础URL，去掉已粘贴的models/images/videos端点和末尾斜线，空路径补/v1。

清除操作撤销该connectionId全部版本的凭据密文，并创建无凭据的新当前版本；不删除任务、上游ID或素材。已派发请求不能靠清除来证明远端取消；下一次派发/查询前重新读原版本，缺失/解密失败则停下，记credential_access_paused并保留polling_paused记录。完整恢复操作和状态协调仍由T05实现。重新保存可修复当前连接并创建新版本，但不会把旧损坏版本自动重定向到新凭据；旧任务仍明确暂停。

## 桌面方法与HTTP

preload只开放saveConnection(input)、clearConnectionCredential(input)、selectConnection(input)。IPC验证实际主webContents和主frame，参数数量及字段白名单；不接受文件路径、任意方法或读取凭据引用。

saveConnection接收connectionId?、expectedVersionId?、displayName?、baseUrl?、provider?、apiKey?、defaultImageModel?、defaultVideoModel?。更新必须提供精确旧版本，冲突返回CONNECTION_VERSION_CONFLICT。clear/select只接收connectionId和expectedVersionId。返回{ok,connection?,code?}，保存客户端只保留脱敏结果并释放自己的瞬时Key副本；T10表单必须在完成后清空输入状态。

| 方法/路径 | 行为 |
| --- | --- |
| GET /api/nova/connections | 脱敏连接列表及共享默认连接 |
| GET /api/nova/connections/current | 当前脱敏连接，未配置为null |
| GET /api/nova/connections/:id | 该连接当前版本的脱敏摘要 |
| GET /api/nova/connections/:id/models | 缓存的可见性和独立能力记录，不发请求 |
| POST /api/nova/connections/:id/check | 只收connectionVersionId和force?，仅GET上游/models |

没有HTTP保存或清除凭据接口。桌面任务只接收connectionVersionId；客户端去掉apiKey/baseUrl/protocol，服务端也拒绝原始Key、地址覆盖和旧proxy入口。原Web模式继续其旧路径，未升级为此桌面凭据模型。桌面旧provider/plugin浏览器凭据读写停用，不探测已有值；旧设置面板不是T04完成的产品界面，T10接入统一表单。

图片任务在入队前保存连接版本；执行时从该版本重新取地址和凭据，旧图片适配器仍处理其/v1拼接。原声明式插件模板已自带/v1时只做一次兼容拼接，脚本driver不据此猜测新协议；插件原有主机清单/内网拒绝仍有效，绑定版本后另限制同一服务源并拒绝凭据进入URL和自动重定向。插件每次查询重新获得原版本凭据，清除后不继续使用捕获的旧查询上下文。绑定版本的上游响应在解析/记录前检查已知凭据回显，任务ID/错误/成功资产不得携带Key；图片资源URL含Key则在下载前拒绝。桌面图片/插件错误在normalizeError截断前共用已知凭据检测；命中后隐藏整条上游详情，避免编码Key进入HTTP/WS和SQLite错误字段。检测覆盖原文及最多两轮百分号字节解码（含全字节/混合编码），无关非法百分号或非法UTF-8字节不会中断检测；图片成功URL和插件响应复用该检查。原Web错误路径保持既有行为。T07仍负责新OpenSosen视频适配器。

## 只读检查和缓存

检查只发GET {canonicalBaseUrl}/models，不创建图片/视频、不要求文本模型，不跟随重定向。应用预算为8秒、1MiB响应、最多5000条列表记录；这些不是供应商限制。默认5分钟缓存，只在显式调用check时使用/刷新，启动和浏览页面不自动检查。相同版本的并发检查共用一次请求；当前版本在检查期间变化时丢弃旧结果，返回stale=true。缓存按不可变版本持久化，更换端口不会改变其身份。

状态区分unverified、verified（仅只读检查）、unconfigured、credential_unavailable、offline、auth_rejected、models_unsupported、models_invalid、unavailable及redirect_rejected。401/403与404/405/501列表不支持分别记录；错误不保存上游原始正文。失败保留上次成功时间和旧模型可见性，同时明确当前检查失败，不能把旧可见性当成当前在线。模型缺失不会悄悄替换用户默认型号。

## 精确型号和证据

三个预设固定为gpt-image-2.5-flare、grok-imagine-video-6s、grok-imagine-video-1.5-6s。上游列表只决定visible/absent/unknown，不创建或升级能力证据；未知可见型号没有自动生成的能力组合。

能力记录绑定provider、精确baseUrl、完整型号、模式、协议、精确参数和evidenceVersion。仅https://newapi.opensosen.com/v1的1.5单图/双图记录为historically_verified，参数限定6秒、1280x720、multipart、有序重复input_reference和1/2个参考文件，证据H01/H02/H03/H06；applicationVerified仍false。其他服务源不继承这项历史证据。flare文生/编辑、两个视频型号的文生、普通型号参考图及其他组合仍为unverified；没有从mock或模型可见性声称真实生成通过。默认模型选择不代表该模式已经可生成。

T04未调用真实供应商模型接口或付费生成，没有在本阶段验收完整生成、下载或设置UI。使用假Key和loopback进行真实传输；实际公共插件主机只通过fetch替身验证，无网络放宽。

## B1 能力使用边界

B1 新创建必须携带 capabilityVersionId，宿主核对其服务源、provider、精确模型、模式、协议和精确参数，不用模型可见性代替能力证据。当前仍只有原 OpenSosen 1.5 单/双参考保留 historically_verified，所有未验证记录不因离线/原生合成测试而升级。缺证据返回 CAPABILITY_UNVERIFIED，保留原产品需求供 T15 验证；不存在自动换型号或改绑新凭据。新接口见 [B1 适配契约](b1-adapters-v1.md)。
## B3 首次引导与设置补充

B3/T10 已接入共享表单，实施/验证记录见 [B3](implementation/B3-T09-T10-四页框架与首次引导.md)，已由主会话审核接受本批T09/T10范围，见[主审记录](implementation/b3-evidence/approval-review.json)。原已保存版本的 HTTP check 保留；新增以下窄 preload/IPC：

| 方法 | 输入与行为 |
| --- | --- |
| validateAndSaveConnection | 原 save 字段 + UUID operationId + 可选 expectedOnboardingRevision；先在宿主用瞬时凭据做相同 GET /models，只读成功后才事务保存密文、连接版本、检查和 defaults 步骤；失败不新增连接或凭据 |
| cancelConnectionValidation | 仅 operationId；作废并中止候选；编辑/取消/新检查/其他配置写入后，旧响应不得晚到保存 |
| completeWorkbenchSetup | connectionId、expectedVersionId、两个完整默认型号、可选 expectedOnboardingRevision；目录复查后事务保存默认型号与 completed/dismissed；旧任务不改绑 |
| checkOutputDirectory | 无输入；宿主复查当前目录可写，返回受控名称和 opaque 引用 |

候选检查没有 HTTP Key 保存/读取入口；复用原 8 秒/1 MiB/5000 条、禁止重定向与固定错误边界。只有主 webContents+主 frame 可调用。无新 Key 时只能在宿主读取同一已保存版本；改地址仍必须新填 Key。检查失败区分 auth_rejected（并保留本次 HTTP401/403 分类）、models_unsupported、models_invalid、offline、unavailable，不将其当成生成可用性。

宿主在写入前核对 operation 身份与 expectedVersionId，且检查通过到同步事务间没有异步间隙；仅 UI 丢弃返回不作为竞态保证。未修改的已保存连接检查不新建版本；该配置检查失败时更新健康状态、保留上次成功/模型缓存。编辑候选失败不污染原连接。型号默认项变更沿用同一地址和凭据的检查记录，但创建新不可变版本；已有任务仍引用旧版本。成功检查的 defaults 步骤、最终完成状态均通过事务保证重启分流正确。

renderer 只在当前表单保存瞬时输入；保存成功清空，离页/取消引导/Esc 不把 Key 写入草稿或浏览器存储。离线/过期缓存与生成能力证据分别显示，未验证模式不因列表可见而启用。
