# OpenChatCut 原版接入契约 v1

> 2026-11-02 范围同步：本契约的宿主/入口已有首批实现；OCC04–05素材/工程、OCC07–08成片回库当前按用户决定暂缓进一步融合。以下相应接口为预留约束，并非可调用的已实现接口；OCC06真实服务配置仍未接通。原版UI与本地预览不等于完整功能或正式交付验收。状态以[接入计划](../OpenChatCut原版接入需求与实施计划.md)和[总任务清单](../Nova-Studio落地任务清单.md)为准。

日期：2026-11-01。状态：首批宿主/入口契约；业务素材与回库接口随对应任务增量落实。未实现的字段或接口不能标为可用。

## 宿主和运行边界

运行模块路径固定，父仓库 gitlink 与配置固定SHA一致才允许准备；启动参数、数据根、URL、脚本路径由宿主计算。页面不能输入服务器源、命令、绝对路径或进程参数。

OpenChatCut 服务使用 Nova 资料根下独立子目录，运行探针可使用显式隔离临时根。启动前设置 profile，不继承供应商密钥或读取用户现有配置。只监听127.0.0.1。编辑 View 用独立 session，禁止越源导航、新窗口和 Nova 凭据注入。Worker只在该独立View按原版需要开放。不得给它 Nova 主窗口 preload。

本地预览包增量：固定资源根为 resources/openchatcut，使用profile=local-preview的nova-runtime.json及构建receipt核对版本、服务/入口/锁文件/依赖。安装态不调用Git或读取开发目录；缺清单仍明确不可用。当前仅批准独立本地预览，不将此等同正式子模块交付。

local.2起，预览包可用sharedFfmpeg记录复用Nova既有的resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe；宿主核对既有审计SHA256、大小与真实资源边界后，向隔离服务显式设置OPENCHATCUT_FFMPEG和FFMPEG_BIN。不继承同名外部值，页面没有媒体可执行路径参数；旧开发/完整副本规则保持。

## 首批页面 API（novaDesktop 只对原 Nova 主 frame 暴露）

所有调用返回 `{ok:true,...}` 或 `{ok:false,code}`；失败文本由前端安全映射，不返回日志、路径、令牌、命令、密钥。状态事件同样只包含允许字段。

| API / IPC | 参数 | 结果 |
| --- | --- | --- |
| getEditorState / nova:editor-state | 无 | state：phase、code可选、engineCommit、available；phase为 unavailable/idle/starting/ready/failed/stopped |
| openEditor / nova:editor-open | 无（首批默认恢复/新建入口，不能传URL或路径） | 与state相同；并发启动共享同一启动请求 |
| setEditorViewport / nova:editor-viewport | `{visible:boolean,x:number,y:number,width:number,height:number}` | ok；坐标为CSS像素且有限整数，宿主按窗口内容区校验/裁切；不可跨全局导航边界 |
| hideEditor / nova:editor-hide | 无 | 隐藏保留编辑上下文，取消在途启动后不能迟到展示 |
| onEditorState / nova:editor-state-changed | 订阅回调 | 返回unsubscribe；仅向原主窗口发送状态 |

页面 activePage 增加 `editor`，returnPage允许editor，其他原有字段保持；后端窄schema同步。进入剪辑先保存适用草稿；不把editor模式当生成mode或自动创建生成任务。离开时隐藏View，更新冻结时隐藏并进入后续统一收尾。首批不能自行开放Nova旧Agent/CDP。

运行包缺失、依赖未安装或预检不通过时显示真实不可用说明与重试入口，不显示伪编辑器、不内嵌自制九页签、不把工程卡片作为成功编辑状态。

## 素材交接预留（OCC04–05，暂缓）

建议请求 `{requestId,novaProjectId,expectedRevision,items:[{sourceTaskId,assetId,position}]}`，只允许正式输出、连续有序position。宿主冻结摘要与媒体身份，持久保护传输中引用，复制并校验；原版独立拥有副本后完成回执，记录novaAssetId与occAssetId映射。同ID同快照复用，同ID异快照冲突，过期revision拒绝。不能后台用离线CLI抢写打开中的工程。

## 成片回库预留（OCC07–08，暂缓）

渲染回执绑定工程、时间线、工程版本、宿主授权输出与目标剧本。页面不传任意文件路径。只有验证、原子发布和本地作品登记完成才算回库成功。原版导出完成与Nova回库完成分别记录；后者失败重试不得再次导出。作品来源为本地剪辑，云生成任务字段与费用事实保持独立。

## 凭据与功能可用性（OCC06）

机密经safeStorage保存；原版配置UI保留，明文keystore写入必须在正式允许配置之前替换。首批离线探针不给真实服务凭据；原版Agent UI存在不表示已连接模型。联网音频检索、云生成、本地模型、原生推理和外部MCP逐项明确配置与可用状态。原版浏览器HTTP模式不得挂半套openChatCutDesktop。
