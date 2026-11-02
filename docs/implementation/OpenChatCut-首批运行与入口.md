# OpenChatCut 首批运行与入口

> 2026-11-02 当前进度补充：本文为11月1日OCC01–OCC03的阶段记录。本地预览包随后已完成local.1及FFmpeg去重local.2，见[本地包记录](OpenChatCut-本地预览包.md)。用户现暂缓与Nova进一步融合；本文“尚未完成”用于保留事实和边界，不代表当前继续开发指令。原版编辑器可加载不等于所有功能已验收。

日期：2026-11-01。状态：OCC01–OCC03 已实现，已通过本批源码与离线/开发态运行范围主审；完整接入、真实媒体与安装态验收未完成。未提交、推送或发布。

## 交付范围

- OCC01：固定fork/gitlink/HEAD、Node/依赖/构建receipt检查；子模块独立构建；受控服务进程、隔离HOME/profile、稳定来源与端口冲突恢复；保留原版源码和锁文件。
- OCC02：独立session的WebContentsView，保持Nova原主页面权限；原版真实DOM挂载后才ready；单例启动、越源拦截、CSS→DIP位置、隐藏恢复、保存关闭保护、幂等退出。
- OCC03：左侧“视频剪辑”第五入口、原版工作区承载、可恢复启动状态、持久导航及设置返回；先保存生成草稿、无生成连接也可进入本地剪辑。
- 原版UI布局、六主页签和资源分类均来自原版；未实现此前自定义九页签。

起始状态：Nova dev=e8e9480；.gitmodules与third_party/openchatcut的7fa4b79 gitlink已暂存；desktop/credential-vault.cjs曾显示已有修改；设计图和其他历史证据未跟踪。未将这些内容回滚或收入新提交。

## 运行与构建

本机 Node24.14.0，Nova Electron43.4.0内含Node24.18.1。子模块使用 npm ci --ignore-scripts --no-audit --no-fund 安装849个包，不触发安装脚本和模型下载、不修改锁文件。

原版 tsc -b、Vite生产构建（2013模块）与独立服务bundle通过；构建复用Nova已有且版本、SHA256匹配的FFmpeg二进制。未执行原版predev/prebuild的大模型同步；原生转写、模型文件与实际渲染不是本批已验收范围。

开发入口（仓库根目录）：

```text
npm run editor:build
npm run editor:check
npm run editor:smoke
npm run test:editor:runtime
```

准备好运行产物后，可直接双击根目录[启动工作台预览.bat](../../启动工作台预览.bat)，也可在工程根目录执行 `node scripts/start-local-preview.cjs`。脚本先检查工作台页面与剪辑运行资源，再调用工程内Electron启动桌面窗口；沿用此前手动启动所用的 `%LOCALAPPDATA%\NovaStudioPreview` 独立资料目录，不读取已安装Nova的默认资料。重复启动由现有单实例机制切回原窗口。依赖整个开发目录与已安装依赖；启动器不执行安装、构建、打包或发布。

执行 `node scripts/start-local-preview.cjs --check-only` 可仅检查资源，不创建测试资料或启动窗口。脚本版本使用 `.bat` 内置的Electron Node运行时，无需单独找到Node可执行文件；剪辑预检仍需要本机Git。启动日志写入测试资料目录下 `launch-*.stdout.log`、`launch-*.stderr.log`。

后续已按用户要求完成独立本地预览包，包含运行资源时可在packaged模式打开原版剪辑，见[本地包记录](OpenChatCut-本地预览包.md)。不含对应资源清单的旧包仍返回EDITOR_RUNTIME_NOT_PACKAGED；正式资源/依赖分发与安装升级验收继续由OCC10–11落实。

## 实际验证

| 执行者 | 命令/范围 | 结果 |
| --- | --- | --- |
| 构建代理 | 原版TypeScript、Vite、服务bundle | 通过；不代表媒体渲染通过 |
| 构建代理 | Node24及Electron内置Node两套scripts/openchatcut-smoke.cjs | 通过：HTML/静态脚本、原版SQLite工程读写与重启、正常重启来源稳定、端口冲突迁移和记忆、机密写入拒绝与配置指纹、跨站读取拒绝、优雅退出 |
| 主代理 | npm run test:editor:runtime；npm run editor:check | 7/7；available=true、固定7fa4b79 |
| 入口代理 | 6文件前端相关回归（含既有B3/分组/最近任务/生命周期） | 80/80；既有act提示保留 |
| 入口代理 | workspace新增与既有B3/最近任务后端回归 | 20/20 |
| 主代理 | npx vitest run openchatcut-editor.test.tsx openchatcut-navigation.test.tsx | 19/19，是80项的子集，不能相加 |
| 主代理 | npx tsc --noEmit --incremental false | 通过 |
| 主代理 | npm run build（frontend） | Next.js生产静态构建通过；Browserslist旧数据提示保留 |
| 主代理 | node --test backend/test/openchatcut-host.test.js backend/test/openchatcut-workspace.test.js backend/test/desktop-boundary.test.js desktop/update.test.cjs desktop/update-quit.test.cjs | 60/60；包含宿主专项17项，不与代理的既有63项相加 |
| 主代理 | 真实隐藏Electron窗口 + WebContentsView + 原版生产页 | 6项检查通过，见下 |

真实View检查：[安全结果](openchatcut-first-batch-evidence/native-view-result.json)。确认直接进入/#/editor/:id而不是工程卡片页，原版Agent/素材/预览/时间线DOM存在，六个中文主页签齐全；编辑页无Nova桥或半套openChatCutDesktop；隐藏/重入保持工程；125%缩放不覆盖Nova导航；关闭重开恢复同一工程与稳定来源。

可复现隐藏窗口探针：

```text
node docs/implementation/openchatcut-first-batch-evidence/run-native-view.cjs
```

归档后的脚本已在仓库位置独立复跑，6项检查通过，Electron正常退出。探针只创建短os.tmpdir隔离资料，GPU关闭，不读取用户现有配置/凭据，不调用付费服务，不进行桌面UI控制或截图。它验证真实宿主View，不等于完整Nova安装态鼠标交互或真实媒体制作。

## 审核发现与修复

- 首次state事件抢先于getState导致页面不自动启动；已修复并回归。
- 导航重入、解除freeze、窗口恢复可见时只更新viewport不能重新激活；已显式恢复宿主View并回归。
- HTML加载成功却React未挂载曾被标ready；已增加有界原版DOM就绪检查。
- 真正关闭WebContents后native View.webContents被清空；保留独立contents引用，重复close/hide/resize/reset/dispose幂等，真实重启通过。
- 服务随机端口改变浏览器来源；复用原版listenWithAffinity并验证冲突迁移、记忆和工程恢复。
- 更新busy失败不能改变编辑View可见性；该保护由宿主回归覆盖。

历史失败保留在[失败记录](openchatcut-first-batch-evidence/failure-history.json)，包括受限启动、长目录IndexedDB、原生关闭对象失效、端口断言和初始化非机密配置的探针修正，未把复跑成功写成首轮零失败。

## 尚未完成

1. OCC04–05：工程-剧本关联、正式作品多选送入、可靠复制、映射回执、原件变化保护。
2. OCC06：safeStorage适配、原版模型和联网素材服务配置、原生推理桥；首批明确拒绝机密写入及暂未适配的OAuth/外部MCP/技能执行，不能说Agent已可真实调用。
3. OCC07–08：独立本地作品、长成片流式处理、原版两条导出路径回库；没有伪造生成任务或费用记录。
4. OCC09–11：真实媒体编辑/保存/渲染、全部原版核心能力、资源许可证、正式打包和安装升级验收。
5. 当前存在编辑上下文时更新安装保守返回UPDATE_BUSY，切页只隐藏；需要保存并关闭/重开应用后再安装，后续补统一flush握手。
6. 长目录中的IndexedDB初始化失败边界、原版CSP开发警告和DNS重绑定尚需后续专项验证；没有为通过探针放宽Nova原主页面政策。
