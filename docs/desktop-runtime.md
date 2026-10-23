# 桌面运行边界

T02提供Electron运行与会话边界，T03接入持久资产/草稿，T04接入系统加密凭据和连接版本。Web保留旧服务入口；完整任务恢复及媒体下载留T05/T08。

## 数据和进程

数据目录优先级为 NOVA_DATA_DIR 显式覆盖、PORTABLE_EXECUTABLE_DIR/data、Electron 系统 userData。Windows 当前包名对应 %APPDATA%/nova-image。安装目录不再作为默认数据目录。用户确认从未使用过原版Nova，按全新安装处理；不检测、导入或复制旧版相邻data与浏览器资料。已有APPDATA测试目录保留。

单实例锁在加载后端和打开 SQLite 前取得，按 userData 配置目录隔离。同配置第二进程退出并恢复/聚焦已有主窗口。默认从 31207 尝试最多 10 个相邻回环端口，冲突后使用系统分配端口；NOVA_BACKEND_PORT 可指定起始值，0 表示直接分配。

## HTTP、WS 和渲染边界

宿主每次启动生成 256 位随机会话，仅驻留主进程和后端内存，既不写 env/argv，也不通过 preload、cookie、URL 或日志传给页面。会话头为 x-nova-session。后端同时校验真实回环连接、精确 Host、存在时的同源 Origin 与 fetch-site。敏感 API 和所有写请求必须带正确会话；WS 还必须带精确同源 Origin。无 Origin 的外部客户端也没有免鉴权通道。

Electron 只对本应用后端目标、正确 webContents、实际主 frame 且同源的请求注入会话。其他请求先移除任何同名头，外站/重定向不能获得会话。主文档 CSP 禁止 worker 和 frame；Chromium 会把专用 Worker 请求归因到所属 frame，因此不能只靠 frame 元数据区分 Worker。桌面不注册 PWA，启动只清理本应用 origin 的 serviceworkers/cachestorage，保留 localStorage/IndexedDB 和其他站点缓存。Web PWA 保留。

默认关闭 Agent、CDP 与浏览器自动启动。NOVA_AGENT_ENABLED、NOVA_CDP_ENABLED、NOVA_CDP_LAUNCH_ENABLED 的显式 true 可启用对应旧能力；它们不是首版承诺。NOVA_ELECTRON_CDP_ENABLED=true 仅用于明确调试，调试地址固定回环；普通启动不开调试监听。

## 网络策略

NOVA_NETWORK_MODE 支持 direct（默认直连）、system（使用 Electron 系统代理）、direct-first（只读请求可有限回退）。每次 GET/HEAD 最多一次直连加一次系统代理尝试，回退等待预算默认 2 秒；有效 Retry-After 超预算时原样返回，不提前重试。取消不触发回退。

所有非 GET/HEAD 请求只选定一个传输通道，无论超时、断连、429/503 或重定向均不自动切换/重发。写请求及本地服务请求使用手动重定向，桌面图片流式参数被拒绝时也不补发第二个 POST。传输失败报 SUBMISSION_UNKNOWN；此标识还未接入 T05 的持久任务状态机。Web 原有图片流式兼容回退保留。

## 窄 preload 接口

window.novaDesktop 只暴露公开 versions/features 与以下操作，每个 IPC 都再次校验发起 webContents 和主 frame：

| 方法 | 返回/限制 |
| --- | --- |
| saveConnection(input) | T04：主frame窄IPC瞬时接收Key，safeStorage加密；只返回脱敏摘要，更新须精确expectedVersionId |
| clearConnectionCredential(input) | T04：按稳定connectionId撤销全部版本凭据，保留任务/上游ID/素材 |
| selectConnection(input) | T04：选择图片/视频共享默认连接，不改变旧任务绑定 |
| importReferenceAssets() | T03：宿主选择PNG/JPEG并复制为受管资产，只返回摘要；无任意路径参数 |
| getRuntimeInfo() | 版本、存储策略名称、功能开关；无实际路径/会话 |
| chooseOutputDirectory() | 系统目录选择框，取消状态或不透明 selectionId 和目录显示名；宿主 realpath 与写探针验证 |
| saveAssetCopy(assetId) | 仅 UUID；当前明确返回 ASSET_SERVICE_NOT_READY |
| revealAsset(assetId) | 仅 UUID；当前明确返回 ASSET_SERVICE_NOT_READY |

页面不能传路径打开或写入任意本机文件。选中的真实目录只保存在宿主的有界会话表中，最多16项，退出后清空。另存/定位仍由T08/T13通过资产ID和宿主选择引用接入，不将文件服务未完成伪装为成功。没有通用 invoke、shell、文件读取或会话读取接口。

## 退出和验证

退出先撤销会话，停止接收请求，取消仍等待响应头的网络请求，关闭 HTTP/WS、定时器及 IPC，checkpoint/关闭 SQLite 后退出。响应头返回后的正文流及远端任务恢复/下载验证仍由 T05/T08 完成；本阶段不承诺远端取消或恢复状态机。

运行 node scripts/verify-desktop-boundary.cjs <全新输出目录> 可使用真实 Electron 验证开发态边界；测试包装器加载实际 desktop/main.cjs，只在测试中制造重定向、缓存和独立Web环境，既不打印会话也不进入安装包。安装包探针为 node scripts/verify-desktop-package.cjs <exe> <system|override|portable> <全新输出目录>；system 拒绝使用已有系统配置目录，避免覆盖用户资料。

T04连接细节见[连接契约](connections-v1.md)。node scripts/verify-desktop-connections.cjs <全新输出目录>使用真实Windows safeStorage/IPC验证两次启动、坏密文及清除；只向loopback模拟服务GET模型，不调用供应商。打包探针可在override模式追加--storage --connections，所有测试包装器与加密替身均不入包。
