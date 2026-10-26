# B2 下载与本地媒体接口 v1

## 统一线路替代固定cn映射（2026-10-26）

当前工作区按设置选择内置OpenSosen cn/com；此前“仅content无条件转cn”的实现由统一路由替代，历史原始记录保留。第一批源码与离线范围已主审，第二批源码与离线范围主审通过；未提交、打包或发布，现有3.6.6安装包不因此改变。

下载入队冻结 `downloadAttempt.transportRoute:{route:'cn'|'com',revision:number}|null`。同次多文件、链接刷新、重定向及worker重入共用线路；下一次手动重新下载读取原任务所属连接的当前线路，已在途请求不中断。原com content来源仍按身份存储，仅实际请求映射，保持原编码ID、原版本Key和原目录；不借用新连接或新Key。自定义源、CDN、签名链接不映射，inline结果不发网络下载。

只有已校验的内置精确受管目标可带原Key；离开该下载目标剥离Key，跳回不恢复。线路不绕过URL/DNS/重定向检查，不自动fallback，不重发生成。历史缺快照为null/未记录，不猜线路。真实字节、校验保存、原下载预算和提示修复保持；无远端Range续传、真实cn下载/速度验证。详见[实施规划](OpenSosen线路切换实施规划.md)和[第二批记录](implementation/R06-R08-统一线路界面与整体验收.md)。

> 2026-10-26 当前下载体验：D01–D03 已主审；D04–D10 已实现并完成离线验收，源码与离线范围主审通过。图片下载默认30秒、视频180秒可配置；生成与下载独立预算，原卡片/详情显示进度并可重新下载。用户选择保持原来源存储，不新增加密；无ID临时链接重启后不可恢复时明确提示。见[实施记录](implementation/D04-D10-下载恢复与工作台体验.md)。未提交、打包或发布，已发布3.6.5仍执行旧规则。

日期：2026-10-23。B2=T08，基础范围已由主会话审核接受，明确批准本批提交推送origin/dev，见[审核记录](implementation/b2-evidence/approval-review.json)。独立检查为105项中104通过、1项因Windows缺symlink权限跳过、0失败；没有新增完整工作台UI、真实供应商能力证据或发布。61项要求与17个任务编号保持。

## 完成门槛与下载队列

远端 completed 与下载 waiting 同一 SQLite 事务登记。生产 worker 的独立并发为1；远端已完成即可释放生成占位，下载不阻塞后续生成。相同 createdAt 的队列按 SQLite rowid 保留插入顺序，避免随机 UUID 改变 FIFO。T05 的 submission_unknown/polling_paused 保守占位和单次 POST 规则保持。

下载使用冻结输出根下的随机 `.nova-parts/UUID.part`，以 wx 创建、流式写入、字节预算/Content-Length 检查、fsync。实际解码后再次比对 SHA-256，再通过受管对象的独占原子发布（同文件系统 link + 移除临时名，不覆盖冲突对象）。经过验证的资产关联与 completed 在同一事务提交；事务失败没有部分输出关联。可能留下无引用的完整受管对象，沿用 T03 保留策略。

每次下载创建新临时文件，恢复从资源起点重新下载，不保存或复用临时路径。崩溃或文件被锁时可能留下未引用 `.part`；它不会成为输出或被再次采用。本批不增加垃圾清理/备份管理界面。

inline 候选沿用 T05 的持久受管 unverified 对象，保持 Base64 不进公开状态；worker 将其复制到临时文件并完整验证，验证之前不绑定任务输出。图片和视频使用相同完成门槛。

## 实际媒体解码

锁定 ffmpeg-static **5.3.0**；实际 Windows x64 二进制是 **FFmpeg 6.1.1-essentials_build-www.gyan.dev**，不是5.3.0。二进制摘要及来源见 [运行清单](../desktop/ffmpeg-runtime.json)，实际打包字节/版本见 [包审计](implementation/b2-evidence/package-audit.json)。产品不依赖本机 PATH/FFMPEG_BIN，也不调用 shell。

签名只用于选择固定 demuxer：PNG、JPEG、WebP、GIF、MP4/MOV 的 ftyp 容器、WebM。解码使用 -xerror、严格 err_detect、固定本地文件输入、file 协议白名单；MOV 明确禁用外部 data references。完整视频与音频帧通过 framehash 输出，必须有实际视频帧、有效尺寸和视频时长。文件扩展名、MIME、HTTP200、远端状态或可读 header 均不足以验证；JSON 伪 MP4、截断 PNG/MP4 均失败。没有转码用户输入/结果。

应用预算为100MiB/文件、120秒下载总期限、90秒解码期限、2个输入解码线程/1个输出线程、单次分配256MiB、最多67108864像素、250000帧/1800秒、32MiB解码输出及65536字节错误输出；这些是应用限制，不是上游能力。它们不等于操作系统总 RSS 硬配额。解码 stderr 不进入错误 DTO/日志，避免路径/媒体标签回显。

FFmpeg 实际构建为 --enable-gpl --enable-version3；完整实际 GPL 文本及上游构建 README 随本地测试包放入 resources/licenses，见 [声明](../desktop/third-party/FFmpeg-NOTICE.md)。**公开分发仍须按 GPL 第6条提供对应 FFmpeg、链接库源码及构建材料；仅提供上游链接不宣称履约。** 该要求列为T16发布门槛。本批只创建本地 Windows x64 测试包；其他目标需另做二进制/许可证审计，打包钩子拒绝未审计目标，避免误装构建宿主的二进制。

## 资源、鉴权与恢复

原连接版本是唯一可用凭据来源；authScope=connection 的初始资源必须是该服务源及 baseUrl 路径内。OpenSosen 视频仍使用原 encodedId 的 /v1/videos/{id}/content。原版本清除或坏密文保持 download_failed/credential 错误，不读取新默认连接。

每跳重定向均手动解析和检查协议/目标、拒绝内网地址、已知 Key 原文与两轮百分号编码污染；最多5跳，HTTPS 不降级。DNS 返回地址也先检查；沿用桌面选定网络传输，此检查不是 DNS 连接固定机制。每跳重算鉴权；仅授权的原服务路径可注入 Key，离开服务后即使重定向回来也不会重新获得 Key。CDN 不携带原 Authorization，不能让 fetch 自动重定向处理凭据。

查询/签名 URL 只存在适配器→任务服务→worker 内存交接，SQLite 只保留 ephemeral 标记；不进入日志、HTTP/WS、事件或公共历史。无查询的受控资源描述可持久化。重定向 Location 同样不持久化。

| 情况 | 恢复行为 |
| --- | --- |
| 可持久描述或 inline 资产、下载中崩溃 | 下载重新排队，重新创建临时文件；不重新生成 |
| ephemeral 丢失但有可查询原 ID | 使用原适配器、连接版本、同一 ID 做只读 GET 刷新，随后下载 |
| 同步签名结果没有上游 ID、重启后内存丢失 | RESULT_NOT_RECOVERABLE，明确说明临时链接未持久保存、无法恢复；不会 POST |
| 资源403/404/410（无连接鉴权）或410（原服务） | 最多一次同 ID 刷新后再下载；仍不可用则 DOWNLOAD_EXPIRED |
| 连接鉴权401/403 | AUTH_REJECTED，保留原资源/任务，不自动改绑凭据 |
| 刷新429/Retry-After | 持久 refresh_not_before_at；人工 retry-download 也不能提前 GET |

刷新单轮沿用5次/10分钟预算上限，本次 worker 最多一个刷新；不在循环内无界重试。没有重新创建入口。GET `/tasks` 与 WS/历史读取仍不触发上游请求。

## 目录与系统文件动作

schema v5 追加 storage_roots、不可变 output_directory_versions、当前默认引用及下载刷新预算。v1–v4 SQL/checksum保持。升级前一致备份和全事务回滚保持；资产/引用表以事务内暂存重建保留所有 ID、引用及外键，默认根仍有唯一摘要/键约束。没有扫描、导入或搬移旧原版/浏览器资料。

默认根是本应用原 storage 目录。系统目录选择成功后立即保存新的目录版本与默认引用；新任务在入队前冻结 outputDirectoryVersionId/outputRootRef。重复 localRequestId 即使默认目录变化仍返回原任务。旧任务/资产不会重定向或搬迁；旧目录丢失时明确 DIRECTORY_NOT_WRITABLE/missing，不在其他位置重建替代目录。同一字节在不同输出根使用各自资产身份；素材导入仍使用原默认受管目录。

preload `getOutputDirectory()` 返回 opaque 版本/根引用与 displayName；`chooseOutputDirectory()` 无参数，只使用系统选择路径。没有 HTTP 或渲染器任意路径输入。B3/T10接设置界面。

`saveAssetCopy(assetId)` / `revealAsset(assetId)` 只接UUID，复用主 webContents+主frame验证。主进程按资产ID校验摘要并解析真实文件。另存通过系统 SaveDialog（含重名确认）取得目标，临时文件在同目录写完/fsync，再检查目标未在确认后变化，原子替换；不先截断/删除原目标。不允许另存覆盖自身受管源或符号链接目标。取消返回 `{ok:true,cancelled:true}`；文件锁、磁盘满等只影响另存，不改变已完成生成任务。并发本地写入仍受操作系统 rename 原子性和目标快照检查约束，不宣称具备跨进程 compare-and-swap。

定位前同样检查文件存在/摘要；缺失/损坏不调用 shell。结果只返回 assetId/成功或固定安全 code，不返回源/目标路径。B4再接按钮与完整作品库。

## 本地资源与错误

GET/HEAD `/api/nova/assets/:assetId/content` 延续会话鉴权、真实路径边界和每次长度/SHA核对，支持完整200、单一bytes范围206、无效/多段/越界416（Content-Range: bytes */size）、suffix/open-end、Accept-Ranges、ETag/If-Range。HEAD返回完整元数据不传正文。图片和视频均可离线读取；Range返回精确本地字节，不代理远端 URL。

固定安全错误包括 DOWNLOAD_FAILED、DOWNLOAD_INCOMPLETE、DOWNLOAD_TOO_LARGE、DOWNLOAD_FORBIDDEN、DOWNLOAD_EXPIRED、RESULT_NOT_RECOVERABLE、MEDIA_INVALID、MEDIA_VALIDATOR_UNAVAILABLE、DISK_FULL、FILE_BUSY、DIRECTORY_NOT_WRITABLE、PATH_TOO_LONG、FILESYSTEM_ERROR、ASSET_MISSING、ASSET_CORRUPT、SAVE_TARGET_CHANGED；凭据错误延续原分类。错误不会保存原始 HTTP正文、路径、签名URL或解码 stderr。实际测试与边界见 [B2实施记录](implementation/B2-T08-下载与本地媒体.md)。


## D01–D03 下载体验增量（2026-10-25，本批离线范围主审通过）

已实施新任务 lifecycleVersion=2：生成默认120/300秒，结果下载默认图片30/视频180秒，均可配置；生成成功且来源登记后结束生成计时，实际开始下载时再启动完整下载预算。旧任务保持版本1预算和历史结论。所有文件、来源刷新、验证和保存共享下载绝对截止，不在阶段切换续期。

新增 generationOutcome/generationFinishedAt 只表示生成完成，完整文件验证保存关联前不表示任务 completed。downloadAttempt.attemptNumber 区分首次与重试；waiting 的 startedAt/deadlineAt 为 null。进度 downloadProgress 与 remote progress 分离，字节/毫秒/字节每秒，未知总大小/比例为 null；普通采样500ms、3秒速度窗口、5秒停滞观察。来源URL/凭据不进入进度。

v9迁移保持旧checksum；旧四字段配置写入保留当前下载值且继续revision检查。原下载失败后显式重试使用新下载配置与attempt，不更改原生成事实和首次localOutcome，不重复生成POST。无ID签名链接加密未授权，保持旧限制。完整文件检查点、WS版本、卡片进度、配置输入、诊断导出尚在D04–D10。

实现与验证见 [D01–D03实施记录](implementation/D01-D03-独立下载预算与真实进度.md)。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。

## 2026-10-26 OpenSosen 视频下载域名受控映射（历史方案，已由统一线路替代）

仅原连接 baseUrl 精确为 https://newapi.opensosen.com/v1、结果为 video、authScope=connection，且原URL为该.com源的 /v1/videos/{单个编码ID段}/content（无query/hash/userinfo）时，下载器发起GET到 https://newapi.opensosen.cn 的相同路径。编码ID含%2F允许。生成、状态查询与持久化来源继续保持.com；历史任务重试同样走此下载入口。

只有本次映射得到的精确cn URL可携带原连接Key；每跳重新检查URL，离开该URL后永久剥离Key，包括同cn域其他路径、另一任务content、查询串及返回原目标。不新增通用跨域认证，不自动回退.com，不重新生成。显式cn来源配.com连接仍按跨域来源拒绝。公共URL检查、完整下载/校验/保存与原时限保持。无凭据HEAD返回401仅证明TLS可达，不证明实际同Key兼容、速度或未被TUN接管。
