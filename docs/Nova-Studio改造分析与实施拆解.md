# Nova Studio 改造分析与实施拆解

> 2026-10-26 最新交付：D01–D10 下载体验及安装完成页已提交、推送、打包并公开发布为 GitHub Test 3.6.6，三项远端资产完整字节校验通过。见[3.6.6交付记录](implementation/3.6.6-交付记录.md)。下方未提交、待打包或3.6.5描述为此前阶段记录；真实安装验收仍待完成。

> 2026-10-26 当前下载体验：D01–D03 已主审；D04–D10 已实现并完成离线验收，源码与离线范围主审通过。图片下载默认30秒、视频180秒可配置；生成与下载独立预算，原卡片/详情显示进度并可重新下载。用户选择保持原来源存储，不新增加密；无ID临时链接重启后不可恢复时明确提示。见[实施记录](implementation/D04-D10-下载恢复与工作台体验.md)。未提交、打包或发布，已发布3.6.5仍执行旧规则。

日期：2026-10-23  
版本：v1.1（补充产品取舍及依赖任务清单）  
源码目录：`E:\Learn\AI\nova-image-studio`  
上游：https://github.com/tianjiangqiji/nova-image-studio  
分析版本：package.json 3.4.0，提交 `b8cd44cc083a0429f8df6a7c9fc5b935b7ae0731`  
需求基线：当前工作区《视频工作台功能规划-拆解-方案.md》v1.1，共 61 项功能。

2026-10-24 进度补充：B5/T14 离线范围已主审接受；用户暂不执行 T15 付费验收，并批准先做 T16 独立离线交付准备。当前产物为本地离线测试版，真实生成待验证，正式交付前置仍保留，详见 [T16 报告](implementation/T16-本地离线安装交付准备.md)。下文 2026-10-23 静态分析保留为原始方案。

## 1. 结论与分析边界

建议继续以 Nova 为底座。桌面壳、图片生成、插件执行、排队、SQLite、WebSocket、表单和预览组件均已有实现，可以减少基础建设。不过，要达到“本地长期保存、重启可恢复、完整三模式视频、首次启动可配置”的要求，需要改造任务和数据生命周期，不能只增加一个模型名称或 JSON 插件。

本次完成源码克隆与静态分析，未安装依赖、运行应用、构建安装包或调用生成 API。文中的“已有”表示找到了实现，不等于运行和打包验收通过；新增路径均为实施建议，并未创建业务代码。

本方案采用已有技术栈，替代原规划第 5 节的从零搭建方案。原规划的产品交互、61 项功能及验收要求保持有效。

## 2. 实际框架及复用决定

### 2.1 已确认的产品取舍

最终交付是基于 Nova 的定制 Windows 应用，四个主入口为图片生成、视频生成、作品库、设置。原有基础能力复用，关键机制改造，界面围绕已确认设计重新组织；不要求原版全部功能原样保留。

| 分类 | 决定 |
| --- | --- |
| 首版核心 | 原规划 61 项功能，包括三种视频模式、连接引导、持久作品、任务恢复和桌面文件操作 |
| 保留的基础 | Electron、Next.js/React、SQLite、队列/插件结构、组件及预览；保留多连接和适配器扩展空间 |
| 必须改造 | 自动重发、重启判死、TTL 清理主记录、明文凭据、视频仅远端 URL、分散的图片/视频数据 |
| 后续增强候选 | 提示词收藏、素材标签/备注/去重、结果比较、多供应商/插件管理界面、用户备份恢复；本轮不增加交付要求 |
| 后续可选工具 | 提示词优化、反推、无限画布、GIF；需要时再评估配置、费用与适配成本 |
| 首版关闭 | 公共提示词广场、Agent、浏览器自动化、UI 切图/网页复刻等额外入口及后台能力 |

“保留源码”“开放入口”“通过验收”分别记录，不互相替代。关闭功能优先使用产品配置，不先大规模删除模块。基础资产摘要、迁移备份不等于本轮交付完整的去重工具或用户备份功能。主流程不能依赖额外文本模型。

本次确认将新增工具留待后续，不把先前的“值得保留”建议直接转成首版需求。未来需要新增能力时，再补功能编号、依赖和验收。

### 2.2 技术复用

| 层级 | 实际实现 | 决定 |
| --- | --- | --- |
| 桌面 | Electron；`desktop/main.cjs` 内嵌 require 后端并创建窗口 | 保留，扩展文件操作、凭据、单实例和退出处理 |
| 前端 | Next.js 16、React 19、TypeScript；生产构建静态导出 | 保留，不迁移 Vite/electron-vite |
| 样式与组件 | Tailwind 4、现有 UI 组件、Lucide、部分 Radix/Base UI | 复用，以颜色变量和布局调整还原设计图，不另建 CSS Modules 体系 |
| 状态 | Zustand、组件状态、localStorage、IndexedDB | Zustand 用于交互；持久业务数据逐步迁入 SQLite/文件目录 |
| 后端 | Node.js CommonJS；主要业务集中在 `backend/server.js` | 不全面翻译 TypeScript；新增边界类型/校验，逐步抽取改造模块 |
| 数据 | better-sqlite3、任务表、插件素材表 | 复用驱动和事务，增加迁移、连接、作品、草稿及任务事件 |
| 插件 | manifest、provider、ui.schema、可选 driver、fixtures | 保留扩展机制，增加文件 multipart 传输能力 |
| 测试 | 前端 Vitest，后端 node:test | 优先复用；补本地协议模拟和 Electron 端到端测试 |
| 打包 | electron-builder、Windows NSIS | 保留，验证原生依赖与新增后端文件打包清单 |
| 包管理 | 根目录、frontend、backend 各有 npm 锁文件 | 使用 npm，不同时迁移 pnpm |

主架构保持：React 页面 → 受保护的本地 HTTP/WS → 内嵌 Node 服务 → SQLite/磁盘/远端 API；系统目录、另存、凭据等操作通过窄 preload IPC 实现。无需把所有已有 HTTP 调用重写成 IPC。

## 3. 源码发现与直接影响

以下行号仅对应本次固定提交，后续改造以函数名定位。

| 发现 | 源码证据 | 对目标产品的影响 |
| --- | --- | --- |
| 已有完整桌面启动路径 | `desktop/main.cjs`；`electron-builder.yml` | 可以复用，但尚未构建验证 |
| 全局 fetch 在直连网络失败或 HTML 错误后改走代理重试 | `desktop/main.cjs` / `installProxiedFetch` | POST 也可能被重复发送；必须优先限制自动重试 |
| Windows 安装态 userData 默认指向 exe 旁的 data | `desktop/main.cjs` / `resolveUserDataDir` | 安装到不可写目录可能失败；安装版改用系统 userData，便携版可保留显式策略 |
| 端口冲突时自动换端口 | `desktop/main.cjs` / `resolveBackendPort` | localStorage/IndexedDB 随 origin 变化；不能依赖固定端口保证业务数据存在 |
| preload 目前只暴露版本 | `desktop/preload.cjs` | 选择目录、另存副本、打开文件位置、加密凭据需要新增 IPC |
| 插件请求默认 JSON 序列化，driver 对象 body 也 JSON.stringify | `backend/plugin-runtime/executor.js` / `resolveRequest`、`submitTask` | 直接返回 FormData 不会正确发出；需扩展传输层 |
| 插件素材按本机文件→可公开访问 URL 设计 | `backend/plugin-runtime/media.js`；`frontend/src/lib/plugin-task-client.ts` | 本地 loopback URL 不能交给远端拉取；OpenSosen 应由后端读取本地字节直接上传 |
| 视频表单有缩减素材列表和 WebP 压缩路径 | `frontend/src/components/plugin/PluginWorkbench.tsx` / `truncatePending`、`compressImageToWebp` | 切模式不能静默丢图；首版 PNG/JPEG 原文件上传，超限提示而非隐式转码 |
| 重启将 queued/processing 统一改为 failed，并提示重新生成 | `backend/server.js:863` / `initDatabase` | 不满足任务恢复；已拿到上游 ID 的任务应恢复 GET 查询 |
| 插件拿到上游 ID 后会写入 request_json | `backend/server.js:2220` / `runPluginTask` | 已有恢复所需的部分基础，可升级为明确字段与状态 |
| 后端 Key 只放内存，客户端插件 Key 保存在 localStorage | `backend/server.js:2107`；`frontend/src/lib/plugin-registry-client.ts:140` | 重启无法靠后端恢复鉴权；需持久加密凭据和 connectionVersionId |
| 默认任务 TTL 12 小时，ACK 后缩为 120 秒 | `backend/server.js:125`、`:2693` / `ackTask` | 这是临时交付缓存，不能直接作为永久本地历史；桌面模式需独立保留策略 |
| 插件收到完成结果即写 completed，保存的是资产 URL | `backend/server.js:2150` / `pollPluginTaskOnce` | 必须补 downloading/download_failed；文件验证落盘后才标本地完成 |
| 视频历史在前端手动下载远端 URL | `frontend/src/components/plugin/PluginHistoryList.tsx` / `handleDownload` | 缺后台自动下载、原子落盘、独立重试和本地播放闭环 |
| 素材类型主要是 image/text；视频历史单独存储且上限 50 | `frontend/src/lib/asset-store.ts`；`plugin-job-store.ts` | 不能直接等同于统一图片/视频作品库；分页应替代静默丢弃历史 |
| 缺 Key 弹窗已有，但检查函数要求图片及文本模型都存在 | `MissingApiKeyDialog.tsx`；`settings-storage.ts` / `hasAnyApiKey` | 可复用弹窗组件，需改为按图片/视频能力判断，不能要求额外文本模型 |
| 默认界面有 Agent、画布、切图、GIF 等入口 | `WorkspaceModeTabs.tsx` | 首版产品导航聚焦图片、视频、作品库、设置；隐藏非范围功能并关闭对应后台能力 |

这些发现说明：接口扩展是局部工作，可靠的本地工作台还需要中等范围的持久化和状态改造。当前不承诺“改几行就完成”。

## 4. 模块改造清单

### A. 桌面与本地服务边界（P0）

修改 `desktop/main.cjs`、`desktop/preload.cjs`、`electron-builder.yml`，建议新增 `desktop/ipc.cjs`、`desktop/credential-vault.cjs`。

- 单实例锁，第二次启动聚焦已有窗口，避免两套内存队列并行。
- 安装版配置/数据库使用系统 userData；作品输出目录独立可配置。端口改变不影响数据库、凭据、草稿和作品。
- 生成 POST 不自动切换代理再发一次；GET 查询/下载允许有界重试。代理策略在创建前确定，不能靠创建请求试探线路。
- 窄 IPC：选择目录、探测可写、另存、定位资产、连接配置；按资产 ID 解析可信路径，不让页面直接调用任意文件操作。
- safeStorage 加密 Key；页面只获 hasCredential、脱敏标识、验证状态。保存时短暂输入明文，随后清除输入状态。
- 本地 HTTP/WS 校验会话身份/来源，限制远端导航和新窗口；不能只因为监听 127.0.0.1 就认为请求可信。
- 桌面产品关闭 CDP/Agent 浏览器能力的默认启用；退出时持久化状态并关闭服务，不把退出当作远端取消。
- 新增后端模块需要同步加入 electron-builder 的显式 files 清单。

验收：端口占用、双开、中文路径、安装目录不可写、关闭重启；创建模拟请求在网络断开后仍只有一次上游 POST。

### B. 连接档案、模型能力与首次启动（P0）

复用 `ProviderSettingsPanel.tsx`、`provider-models-client.ts`、`provider-registry.ts`、`nova-models.ts` 的表单和解析；调整 `plugin-registry-client.ts`、`settings-storage.ts`，统一图片/视频凭据来源。

建议新增 `frontend/src/components/onboarding/`、共享 ConnectionForm，后端 `services/connections.js`。

- 两步引导：连接服务 → 默认模型/保存位置；支持跳过、恢复步骤、未配置工作台和配置后回到原草稿。
- 默认地址 `https://newapi.opensosen.com/v1`；预置完整模型名 `gpt-image-2.5-flare`、`grok-imagine-video-6s`、`grok-imagine-video-1.5-6s`。
- 只读模型列表检查；区分未配置、未验证、已验证、离线、鉴权失败；不把缺少列表端点误判为全部生成能力不可用。
- 用请求版本/取消机制防止修改地址后旧检测结果覆盖新配置。进入工作台不触发生成。
- 模型列表是可见性数据，能力矩阵是按供应商/模型/模式/参数记录的独立数据。
- 普通视频模型多图、其他尺寸/时长、flare 参考图编辑继续标记待验证，不从上游项目预设自动继承能力。
- 配置变更创建不可变连接版本；旧任务绑定旧版本，新任务使用新版本。清除凭据后旧任务暂停，资产不删除。

验收：覆盖原规划 O01–O12；没有文本模型也能使用已配置的图片或视频能力；任何连接检查均不发生成请求。

### C. 图片适配（P1）

B1 当前实现见 [适配接口](b1-adapters-v1.md)：独立 flare 文生候选仅离线验证，参考编辑有明确未验证边界；尺寸/质量未补证前不开放，最终真实协议验收仍在 T15。不得将本批候选解析通过写为图片需求全部完成。

复用 `ImageGenerationWorkbench.tsx`、`TextToImageForm.tsx`、`ImageToImageForm.tsx`、结果预览；从 `backend/server.js` 的 `createGptImageRequestInit` / `requestGptImage` 抽取服务适配边界。

- 精确保留 flare 型号，先使用非流式最小请求；明确支持后才打开质量、背景、流式等附加参数。
- 上游已有编辑实现使用重复 `image`，其注释证据来自另一网关，不能当成 OpenSosen flare 的协议结论。`image`/`image[]` 等格式需单独验证后固化。
- 保留文生/参考图两条路径，不能上传了图片却悄悄退回纯文本生成。
- 禁止创建失败后自动换型号或换参数重发；同步请求中断进入待核对状态。
- 图片完成统一进入本地资产存储，提供另存、定位、复用、送往视频页。

验收：本地 fixture 验证参数、中文提示词、base64/URL 响应、空结果、图片字节；真实 flare 文生/编辑需另行做受控联网验收。

### D. OpenSosen 视频适配（P1）

B1 已按历史 1.5 单/双参考接入有序 multipart 及原 ID GET，保留两个精确型号与三模式数量校验；缺证据的文生/普通 Grok 组合继续待验证。实现与范围见 [B1 记录](implementation/B1-T06-T07-图片视频适配.md)，完整 UI、媒体下载和真实链路验收未提前完成。

建议新增 `backend/plugins/opensosen-video/`，包含 manifest、ui.schema、driver 和 fixtures；扩展 `plugin-runtime/executor.js`、`input.js`、`media.js` 及对应校验/测试。

推荐新增明确的 request encoding（json / multipart）和有序 parts 描述，由宿主根据 assetId 读取文件、创建 FormData。插件不接收任意磁盘路径；只接受与当前任务绑定的资产引用。保持旧 JSON 插件兼容。

已验证的 1.5 单图/双图请求：

```text
POST /v1/videos
multipart/form-data
model=grok-imagine-video-1.5-6s
prompt=用户原文
seconds=6
size=1280x720
input_reference=<第 1 张 PNG/JPEG 原文件>
input_reference=<第 2 张 PNG/JPEG 原文件，仅双图模式>
```

- 两个文件使用完全相同的字段名，顺序与草稿一致；不使用 reference_images、JSON 数组或图 URL 替代。
- Content-Type boundary 由 FormData 生成。不要把 manifest 的通配主机权限作为自定义 Base URL 的捷径；连接档案只授予明确服务源访问权。
- 单图/双图支持已验证的 6 秒、1280×720 组合；双图是参考图，不宣称严格首尾帧。
- 文生视频请求、查询路径、响应结构和下载鉴权范围，应从现有 OpenSosen 成功记录提取 fixtures；不套用其他供应商接口。
- API Key 仅附到指定服务源；下载 CDN URL 及重定向时重新判断鉴权范围。
- 用独立 test transport 或限定测试配置跑 loopback 模拟服务，不为了测试取消生产插件的内网访问限制。

验收：模拟服务解析 multipart，比较字段名、字段顺序、文件名/MIME、两份原始字节摘要；校验 0/1/2 图模式数量、超限拒绝、响应状态和任务 ID。模拟通过不能替代真实线路生成验收。

### E. 队列、任务状态与恢复（P0，跨图片/视频）

主要改造 `backend/server.js` 的 initDatabase、createPluginTask、runPluginTask、pollPluginTaskOnce、failPluginTask、ackTask、cleanupExpiredTasks；建议逐步抽到 `services/tasks.js`、`services/task-recovery.js`。

目标状态：

```text
draft → queued → submitting → remote_queued / generating → downloading → completed
                    └→ submission_unknown
查询鉴权/断网 → paused（保留上游 ID，可恢复）
下载失败 → download_failed（只重试下载）
本地排队 → cancelled；远端明确失败 → failed
```

- 提交前写任务/输入快照和状态，拿到上游 ID 立即事务保存；主键区分 localTaskId 与 upstreamTaskId。
- 重启：有 ID 继续查询；正在提交但无 ID 标记待核对；未提交队列待用户点击继续。
- API 请求级超时和远端任务失败分开；401/403 暂停并提示更新凭据，轮询时限耗尽允许后续恢复原 ID。
- 首版全局一个生成占位，下载队列独立；前端并发次数入口先关闭。使用客户端本地请求 ID 去重本地入队，但不宣称上游 exactly-once。
- 移除桌面任务的自动 TTL 删除和 ACK 后清理主记录行为；ACK 只确认交付状态，缓存清理与历史保留独立。
- 失败和停止查询不得立即删除参考图；引用计数为零且满足用户删除策略后才回收。
- 插件版本/连接版本/能力版本随任务保存；升级插件仍能解析旧任务或明确暂停，不能用新版默认参数覆盖旧快照。

验收：在排队、POST 发出无响应、收到 ID、远端生成、下载中分别强制结束再启动；检查 POST 计数、状态和文件，证明无自动重复创建。

### F. 本地资产、自动下载与作品库（P0/P1）

复用 AssetsWorkspace、历史卡片、缩略图/预览组件；修改 asset-store、plugin-job-store、PluginHistoryList。建议新增 `services/assets.js`、`services/downloads.js`。

- SQLite 为任务/作品元数据事实来源；前端 store 为缓存，不再各自持有永久记录。
- 资产类型扩展 image/video；输入图导入时复制到管理目录，草稿、多个任务可引用同一资产。
- 结果自动写 `.part`，校验 MIME/签名/媒体可读性后原子重命名；保存 localPath、源 URL、大小/摘要、尺寸/时长。
- 视频本地服务支持 Range 播放；统一图片预览和视频播放、暂停、拖动、音量、全屏。
- 下载失败可单独恢复；远端 URL 过期时查询原任务，不创建新任务。
- 作品按类型、模型、状态、提示词筛选和分页；取消 50 条永久历史上限。
- 另存副本走系统对话框；打开目录定位真实文件；变更输出目录只影响新任务。
- 移除记录与删除文件分离，不删除用户导入源文件；外部丢失文件时保留记录并支持重新定位/下载。
- 旧浏览器存储若有数据，提供可重复执行且不重复导入的迁移；新安装直接使用新存储。

验收：离线查看作品、跨模式引用、删除共享资产、源文件移动、磁盘满、链接过期、端口变化、重启与超过 50 条历史。

### G. 工作台交互与视觉（P1/P2）

修改 WorkspaceShell、WorkspaceModeTabs、ImageGenerationWorkbench、PluginWorkbench、SchemaMediaField、PluginHistoryList、AssetsWorkspace。

- 左侧图片/视频/作品库/设置，中间参数与参考图，右侧真实预览，下方最近任务；遵循现有深色紫色设计。
- 视频固定文生/单图/双图三种产品模式；模型与能力驱动可用项。每种模式各保存草稿。
- 导入支持文件选择、拖放、作品库；图片卡片排序同时支持拖动和键盘前移/后移。
- 模式/模型改变不能静默裁掉图片或换型号，超限时保留草稿并提示调整。
- 未配置仍可编辑草稿、导图、浏览作品；生成按钮引导设置，返回后不自动提交。
- 移除无可靠来源的费用/进度显示，状态、耗时来自真实任务数据。
- Agent、GIF、无限画布、切图、提示词广场暂不纳入交付导航；保留源码以便合并上游，但关闭不需要的服务入口。

### H. 诊断、测试与 Windows 交付（P2）

- 诊断导出记录版本、任务事件、模型参数、脱敏响应摘要；排除 Key、Authorization、原图 base64 和含凭据的 URL。
- 沿用后端 node:test 与前端 Vitest；增加协议接收测试、故障注入与 Electron 交互验收。
- 验证 Electron 43 / better-sqlite3 13 / undici 8 与锁定 Node 环境兼容；不能仅依赖打包配置中“无需 rebuild”的注释。
- NSIS 安装、升级、卸载保留数据行为要明确；验证无开发环境的 Windows 可启动和播放真实 MP4。
- 保留 AGPL-3.0 许可证、上游归属及相应源码提供要求；改名、图标、应用 ID 在交付阶段统一处理。

## 5. 建议数据增量

| 表/数据 | 关键字段与用途 |
| --- | --- |
| connections / connection_versions | 显示名、规范化 Base URL、credentialRef、配置版本、最近检查时间与结果；不存明文 Key |
| model_capabilities | 服务标识、完整 modelId、mode、参数范围、验证级别、证据来源/日期 |
| tasks（迁移扩展） | local ID、upstream ID、connectionVersionId、adapterVersion、状态、提交时间、输出根目录快照、输入快照 |
| task_events | 状态变化、提交/查询/下载尝试和脱敏错误，支持诊断 |
| assets | image/video、管理路径、MIME、摘要、尺寸/时长、来源、缺失/删除状态 |
| task_assets | 任务与输入/输出资产、有序 position；不随单个失败任务删除共享文件 |
| drafts / app_settings | 图片及三种视频草稿、引导步骤、默认模型、输出目录 |
| schema_migrations | 可回溯的版本迁移；升级前备份，禁止直接清空原库 |

加密凭据只由桌面主进程解密并通过内部服务注入。HTTP/WS/UI 读接口不返回明文 Key。引用过期连接版本的任务保留恢复入口。

## 6. 61 项需求映射

下表每个原功能编号均被覆盖；这是实现责任映射，不表示已经验收。

| 功能编号 | 主要落点 | 改造性质 |
| --- | --- | --- |
| G01 | A 桌面窗口 | 复用并验收 |
| G02、G07 | G 导航、草稿、视觉 | 布局改造 |
| G03、G06 | F 本地作品/目录 | 数据改造 |
| G04、G05 | B 连接与状态 | 扩展 |
| I01–I06 | B/C/G 模型、参数、参考图 | 复用表单，适配线路 |
| I07 | E 队列与去重 | 改造 |
| I08、I09、I13 | F/G 预览、完成、最近结果 | 改造完成语义 |
| I10、I11 | A/F 另存与定位 | 新增桌面 IPC |
| I12、I14 | F/G 跨模式、复用详情 | 扩展 |
| V01–V09 | B/D/G 模式、模型、顺序和参数 | 专用模式交互及适配 |
| V10、V15、V16 | D/E/F 提交、任务、恢复下载 | 核心改造 |
| V11–V14 | A/F/G 播放、另存、定位、复用 | 扩展 |
| L01–L06 | F 统一图片/视频库 | 数据与界面改造 |
| S01–S04 | B 连接与默认项 | 扩展 |
| S05 | A/F 目录 | 新增 |
| S06 | H 诊断 | 新增 |
| O01–O12 | A/B/G 首次启动及未配置态 | 新增流程、复用表单组件 |

## 7. 实施顺序与阶段门槛

本节保留阶段概览，实际派工以 [Nova Studio 落地任务清单](./Nova-Studio落地任务清单.md) 的 T00–T16 为准。任务清单补充了本地测试支撑、接口契约、基础资产存储等更细前置依赖；两份文档冲突时，以最新任务清单的顺序为准，产品范围仍以 61 项基线为准。

| 顺序 | 工作包 | 前置 | 完成条件 |
| --- | --- | --- | --- |
| 0 | 建立运行基线 | 当前源码快照 | 锁文件安装、现有测试、前端构建、Electron 启动、Windows 打包，记录原有失败 |
| 1 | 桌面可靠性基础 | 0 | 单实例、系统数据目录、窄 IPC；模拟证明生成 POST 不自动重试 |
| 2 | 连接/凭据/数据迁移骨架 | 1 | safeStorage、连接版本、能力表、持久草稿；无 Key 可进入 |
| 3 | 任务状态、恢复和资产生命周期 | 2 | 不再重启判死/ACK 删历史；故障注入证明 ID 恢复及待核对逻辑 |
| 4 | 图片与视频适配最小闭环 | 3 | 图片响应、视频三模式请求、双图字节顺序通过本地 fixture；原插件回归通过 |
| 5 | 下载与作品库闭环 | 4 | 自动下载、验证、落盘、离线播放、另存定位、跨模式复用 |
| 6 | 首次引导与设计图对齐 | 2–5 | 三模式草稿、配置返回、排序、全部 61 项交互逐条检查 |
| 7 | 受控真实线路验收 | 4–6 | 使用用户提供的有效配置，核实待验证图片编辑及文生视频协议；记录真实结果 |
| 8 | 安装交付 | 7 | Windows 安装/升级/退出重启/视频播放/诊断、许可证和使用说明 |

用户于 T05 实施期间批准按批交付：T05 单独完成；之后 B1=T06+T07、B2=T08、B3=T09+T10、B4=T11+T12+T13、B5=T14、B6=T15、B7=T16。保留 T00–T16 共 17 个原编号、61 项需求及逐项验收要求。批内依赖依次满足，不并行多代理；每批由主会话新开 gpt-6.1-sol/xhigh 代理，开发测试后先保留未提交差异供审，获明确批准才提交推送 origin/dev，确认后下一批。受影响部分按需回归，批次收尾进行必要整体验证；不因合批放宽真实线路费用授权或 Windows 发布门槛。详见任务清单的批次表；T05 基础范围及审核修复现已由主会话验收并明确批准收尾提交推送；本代理不开始 B1，下一批由主会话另派新代理。

阶段 0 若暴露严重打包问题，应先解决或重评底座，避免在不可交付基础上投入 UI 改造。阶段 7 涉及实际生成费用，不能与本地模拟测试混为一谈；本次没有执行。

首个实施里程碑建议是阶段 0–4：拿到能启动的桌面壳、可保存的连接、可恢复的任务，以及被模拟服务验证过的单图/双图协议。它用于确认底座扩展路径，不是最终全功能交付。

## 8. 风险与当前未决项

- flare 文生图有既往成功信息，但参考图编辑的字段和参数尚未验证；若线路不支持，必须明确调整范围，不能隐藏图片输入被忽略的问题。
- 文生视频、查询与下载协议需要从既往成功记录补齐 fixtures；不凭名称猜测端点。
- 普通 Grok 型号的多图能力、超过两图、其他分辨率尚无同等证据。
- 本次没有性能测量、依赖安装和打包证据，不提供“可直接发布”或精确工期承诺。
- server.js 集中程度较高，按连接/任务/下载边界逐步抽取；避免一边重构全部架构一边做协议接入。
- 不拼接两个项目的整套运行时。FlyReq 可作协议结构参考，只有必要时引入局部代码并保留许可证归属。

最终建议：保留 Nova 的桌面与页面基础，优先修正自动重试、持久化和任务恢复，再增加 OpenSosen 传输适配及三模式工作台。这个顺序能使后续界面建立在真实可靠的任务和文件数据上。


## 2026-10-26 下载体验 D04–D10 当前实现补充

已实现原任务内下载进度、重新下载、文件检查点、原来源恢复、HTTP/WS 版本同步和有界诊断，离线验收完成、源码与离线范围主审通过；未提交/打包/发布。详见[实施及验证记录](implementation/D04-D10-下载恢复与工作台体验.md)。本补充替代上文同主题“待开发”的旧阶段描述，原签名 URL 仅内存规则保持，历史证据保留。

新任务生成/下载独立预算：图片 120/30 秒、视频 300/180 秒；设置页各时限 30–1800 整数秒。下载排队不计时，刷新、多文件、校验与保存共用一次尝试截止；重试读取新配置，不重新生成。卡片/详情显示真实进度，未知总量不显示百分比，只有验证保存关联成功才完成。网络改善后点击“重新下载”，复用已验证完整文件，未保存文件从头下载，不宣称 Range 续传。

用户最终确认保持原来源存储规则，不新增恢复信息加密：安全持久源/内联资产/可原 ID 查询结果可跨重启恢复；无 ID 临时签名链接仅本次运行可用，重启或过期后无法恢复时明确提示，绝不重新生成。全部已验证检查点可恢复最终关联。task.revision 持久递增，HTTP/WS 与动作共享投影；requestId 重放回传 acceptedAttemptId 和当前状态。失败诊断保留实际字节、预算、原因和最近 10 次尝试；direct 不代表用户未启用代理。
