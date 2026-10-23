# 61 项产品验收台账

日期：2026-10-23。T00–T03已由主会话验收，T04连接基础也已由主会话验收并明确批准提交推送。61项产品条目没有任何一项因此自动标为完整验收通过。主会话新增编码Key错误回显审查已复现、修复并通过实际exe回归，见[T04记录](../implementation/T04-连接凭据与能力配置.md)。

机器可读来源：[workbench-61.json](workbench-61.json)。证据只证明所述基础设施/API部分；完整UI、真实线路及安装发布仍依赖后续阶段。桌面栏区分原生开发态、unpacked运行包和NSIS，不提升证据等级。

| 编号 | 功能 | 关联任务 | 验收要求 | 状态 | 离线证据 | 真实线路证据 | 桌面与打包证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G01 | 标题栏及窗口按钮 | T02、T16 | Windows 原生窗口行为正常，无误触；优先使用原生标题栏 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| G02 | 图片生成、视频生成导航 | T03、T09 | 来回切换不丢提示词、参数和已导入素材 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| G03 | 作品库 | T13 | 可检索历史并打开对应文件 | 待开始 | — | — | — |
| G04 | 连接设置 | T04、T10 | 保存后新任务生效，已有任务仍关联原连接 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| G05 | 已连接状态 | T04、T10 | 离线或凭据错误时不会永久显示绿色；连接成功不等于生成可用 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| G06 | 文件保存在本机 | T08、T13 | 所指目录与实际结果一致 | 待开始 | — | — | — |
| G07 | 深色视觉系统 | T09、T14 | 两页一致，键盘可操作，文字和按钮不因缩放被截断 | 待开始 | — | — | — |
| I01 | 模型下拉框与默认标签 | T04、T06、T11 | 请求使用用户选定型号；不可用时不偷偷更换 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| I02 | 画面描述 | T03、T11 | 中文、换行、引号完整保存和发送；空白提示词禁止提交 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| I03 | 横版/方形/竖版 | T06、T11 | 选项不会与尺寸冲突；不拉伸原图预览 | 待开始 | — | — | — |
| I04 | 图片尺寸 | T04、T06、T11 | 不把任意输入直接作为已支持规格 | 待开始 | — | — | — |
| I05 | 图片质量 | T04、T06、T11 | 提交参数与选择一致；未知枚举不默认开放 | 待开始 | — | — | — |
| I06 | 参考图片（可选） | T03、T06、T11、T15 | 无图片走文生图；有图片走已验证编辑适配器；不能忽略图片后继续文生图 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| I07 | 生成图片 | T05、T11 | 连点不会造成重复提交；失败有明确操作入口 | 待开始 | — | — | — |
| I08 | 生成结果 | T08、T11 | 展示实际输出；大图适配容器，可点击放大和还原 | 待开始 | — | — | — |
| I09 | 已完成标签 | T08、T11 | HTTP 200 或空结果不能显示已完成 | 待开始 | — | — | — |
| I10 | 保存图片 | T02、T08、T11 | 可选择路径，重名时确认覆盖；取消对话框不报错 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| I11 | 打开目录 | T02、T08、T11 | 路径有中文、空格时仍正常 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| I12 | 用于生成视频 | T11、T13 | 使用同一资产，不重新生图；保留原图片记录 | 待开始 | — | — | — |
| I13 | 最近生成缩略图 | T08、T11 | 图片、尺寸、状态与任务关联一致 | 待开始 | — | — | — |
| I14 | 更多菜单 | T11、T13 | 每个菜单项有实际实现，未实现项不展示 | 待开始 | — | — | — |
| V01 | 三种模式 | T07、T12 | 模式校验在提交前完成；模式切换不自动裁掉素材 | 待开始 | — | — | — |
| V02 | 模型下拉 | T04、T07、T12 | 未验证组合给出原因，可由用户选择已验证模型，不静默切换 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| V03 | 已验证双图参考 | T04、T07、T12、T15 | 只有对应线路/模型/模式显示；切换连接后重新匹配 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| V04 | 导入参考图 | T03、T12、T13 | 文件导入后即复制到应用素材目录；原文件移动不影响任务 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| V05 | 参考图排序 | T07、T12 | 预览序号、数据库顺序与 multipart 顺序一致 | 待开始 | — | — | — |
| V06 | 移除与补充图片 | T03、T12 | 不删除原文件或其他任务素材；数量不足时不允许生成 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| V07 | 当前使用张数与说明 | T12 | 明确双图参考不等于首尾帧锁定 | 待开始 | — | — | — |
| V08 | 剧情描述 | T12 | 不擅自修改用户台词；可提示六秒内容过多，但不阻断正常输入 | 待开始 | — | — | — |
| V09 | 时长、比例、清晰度 | T04、T07、T12 | 六秒型号锁定时长；未验证的规格不伪装为可用 | 待开始 | — | — | — |
| V10 | 生成视频 | T05、T07、T12 | 一个本地任务最多发起一次自动创建请求 | 待开始 | — | — | — |
| V11 | 视频预览 | T08、T12、T16 | 打包后的应用中可播放真实样本，时长读取媒体元数据 | 待开始 | — | — | — |
| V12 | 保存视频 | T02、T08、T12 | 不触发重新生成；下载失败与另存失败分开处理 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| V13 | 打开目录 | T02、T08、T12 | 未下载时显示对应状态，不打开不存在的文件 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| V14 | 复用参数 | T12、T13 | 不直接提交；重新检查当前模型能力和图片存在性 | 待开始 | — | — | — |
| V15 | 最近任务卡片 | T05、T12 | 点击可查看详情；无真实进度时只显示状态和已用时间 | 待开始 | — | — | — |
| V16 | 自动保存任务与结果 | T05、T08、T12 | 强制退出后可恢复已持久化的任务与文件状态 | 待开始 | — | — | — |
| L01 | 作品列表 | T03、T13 | 网格缩略图，图片/视频分类，按日期排序，分页或虚拟列表 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| L02 | 搜索筛选 | T13 | 按提示词、模型、状态查找；区分无结果和空库 | 待开始 | — | — | — |
| L03 | 详情 | T03、T13 | 输入图片、完整提示词、参数、时间、任务 ID、输出路径、脱敏错误 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| L04 | 跨模式复用 | T13 | 单图带入单图视频，两图按选择顺序带入多图视频 | 待开始 | — | — | — |
| L05 | 移除记录 | T03、T13 | 默认仅从库中移除，删除应用管理文件需单独明确选择；不得删除用户导入源文件 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| L06 | 文件缺失 | T08、T13 | 外部删除后提示文件缺失；保留任务记录，可重新定位或尝试重新下载 | 待开始 | — | — | — |
| S01 | 连接档案 | T04、T10 | 显示名称、Base URL、Key；首版一个默认连接，数据模型允许多个 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log)、[编码错误回归](../implementation/t04-evidence/encoded-error-regression.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| S02 | 测试连接 | T04、T10 | 检查地址规范、鉴权和模型列表；不发起付费生成 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| S03 | 模型刷新 | T04、T10 | 保存完整型号和刷新时间；离线保留缓存并标注过期 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| S04 | 默认参数 | T04、T10 | 生图默认 flare，视频默认 1.5；比例、质量、目录可配置 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| S05 | 输出目录 | T02、T08、T10 | 选择目录并做写入探测；变更只影响新任务，旧文件不自动搬迁 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| S06 | 诊断导出 | T14 | 导出任务参数、状态、响应摘要、错误及应用版本；不导出 Key 和原图编码 | 待开始 | — | — | — |
| O01 | 首次启动分流 | T04、T09、T10 | 空数据、未完成引导、跳过、已配置四种状态进入正确页面 | 待开始 | — | — | — |
| O02 | 欢迎页与跳过 | T09、T10 | 不填 Key 可进入工作台；再次启动不反复强制引导 | 待开始 | — | — | — |
| O03 | 服务预设与地址 | T04、T10 | OpenSosen 预填正确，自定义留空，规范化不重复 `/v1` | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O04 | Key 输入与加密 | T04、T10 | 遮挡/显示可用，不进入日志或草稿，保存失败不显示已完成 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log)、[编码错误回归](../implementation/t04-evidence/encoded-error-regression.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O05 | 只读连接检查 | T04、T10 | 不调用生成接口，响应分类准确，可取消与重试 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O06 | 模型与目录设置 | T02、T04、T08、T10 | 缺省型号不可用时说明原因，目录可写后才能用于新结果 | 进行中 | — | — | [证据](../implementation/t02-evidence/native-boundary-evidence.json)、[证据](../implementation/t02-evidence/installed-system-evidence.json) |
| O07 | 未配置工作台 | T03、T09、T10 | 草稿/素材可编辑，生成按钮导向配置，预览显示真实空态 | 进行中 | [证据](../implementation/t03-evidence/storage-targeted.log) | — | [证据](../implementation/t03-evidence/native-storage-phase-1.json)、[证据](../implementation/t03-evidence/native-storage-phase-2.json)、[证据](../implementation/t03-evidence/packaged-evidence.json) |
| O08 | 配置后的返回 | T09、T10 | 返回原模式且草稿完整，不自动提交原来的生成意图 | 待开始 | — | — | — |
| O09 | 未验证与离线状态 | T04、T10 | 不显示假绿色连接状态，本地作品可正常浏览 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O10 | 更新/清除凭据 | T04、T05、T10 | 影响范围明确，旧任务和作品不丢失，不跨供应商误查 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O11 | 检查竞态处理 | T04、T10 | 测试中修改地址/Key 后，旧结果不标记新配置验证成功 | 进行中 | [证据](../implementation/t04-evidence/storage-connections-targeted.log) | — | [证据](../implementation/t04-evidence/native-connections-phase-1.json)、[证据](../implementation/t04-evidence/native-connections-phase-2.json)、[证据](../implementation/t04-evidence/packaged-evidence.json) |
| O12 | 引导恢复与键盘操作 | T09、T10、T14 | 中途退出可恢复正确步骤，Tab/Enter/Esc 行为明确且不会误提交生成 | 待开始 | — | — | — |
