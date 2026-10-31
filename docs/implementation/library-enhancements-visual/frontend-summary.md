# 作品库增强前端实施摘要

日期：2026-10-31。当前状态：代码与本次离线验证完成，交主会话最终审核。未提交、推送、打包、发布；不读取用户数据库/Key、不调用上游生成、不移动真实作品。

## 实现

- 日期：全部/今天/自定义范围，任务创建时间，本地自然日转换UTC含开始/不含结束边界；应用前校验；筛选前端联动重置页码与管理选择、拒绝迟到响应；今天跨午夜更新，活动批次结束立即补边界；跨年与历史范围保留年份及完整title。
- 多选：整任务卡图片/视频独立管理选择，当前页全选/清空/退出，与原最多7张的有序参考图状态隔离；拖拽与按钮共用逐项moveTaskGroup，冻结任务/版本/目标；0/N开始进度、防重复、成功/失败/跳过/未知回执；未知回执核对原requestId，确定性失败的新重试使用新ID；失败快照在自动纠页后保留可重试；卸载停止后续派发。
- 悬浮：250ms停留静音循环，最多一个；快速划过不播放；lastPlayTicket避免旧promise暂停新播放；移开归位，失焦/hidden/视口外/多选/拖拽/弹窗/卸载释放；IO先确认视口再附src，避免整页预加载；捕获已有本地帧作封面，只有本地previewUrl。
- 样式：沿用当前工作台/分组栏/卡片尺寸；日期popover、管理工具栏、勾选、叠放拖影与窄屏适配，没有新增说明区。

## 文件

新增：
- frontend/src/components/workbench/LibraryDateFilter.tsx
- frontend/src/components/workbench/LibraryVideoPreview.tsx
- frontend/src/lib/library-date-filter.ts
- frontend/src/lib/library-group-batch.ts
- frontend/src/components/workbench/__tests__/library-enhancements.test.tsx
- frontend/scripts/verify-library-enhancements.cjs

修改：
- frontend/src/components/workbench/WorkbenchLibrary.tsx
- frontend/src/components/workbench/MediaTaskCard.tsx
- frontend/src/components/workbench/WorkbenchResults.tsx（TaskThumbnail）
- frontend/src/lib/workbench-client.ts（HistoryQuery日期字段）
- frontend/src/app/globals.css（追加本轮样式，保留模型设置修改）
- frontend/src/components/workbench/__tests__/library-preview.test.tsx（播放器自身清理断言）

未改workbench-group-client，复用原接口和回执跟踪；后端由另一代理实现。

## 最终执行结果

frontend目录：
    npx vitest run src/components/workbench/__tests__/library-enhancements.test.tsx src/components/workbench/__tests__/library-preview.test.tsx src/components/workbench/__tests__/grouped-workspace.test.tsx src/components/workbench/__tests__/group-operations.test.tsx --maxWorkers=2
4文件63/63通过：新增15、原预览18、分组工作区18、归组操作12。最终恢复实验前行为后再次执行通过（17:49，约12秒）。

    npx tsc --noEmit --incremental false
完整类型检查最终通过，退出0。

根目录：
    node frontend/scripts/verify-library-enhancements.cjs
退出0，报告status=passed。真实挂载WorkbenchShell/Library+合成loopback API和MP4，默认Chromium静音自动播放策略（无放宽autoplay开关）：
- currentTime实际推进至0.18秒，muted/loop=true，单实例；
- 切卡、移开、失焦停止及释放；
- 管理态与发移动请求时卡片视频附着源数0；
- 三项拖拽范围正确、2成功1失败、失败保持选中后单项明确重试；
- 日期今天查询真实带createdFrom/createdBefore；
- 1440与390无横溢出，5张截图：hover-wide、date-wide、batch-drag-wide、batch-390、date-390。
报告与截图：docs/implementation/library-enhancements-visual/。

    git -c safe.directory=E:/Learn/AI/nova-image-studio -c core.safecrlf=false diff --check
退出0（主会话会统一新文件EOF格式）；不代表全项目测试已执行。

## 首轮失败与主审修复

1. 原48项首轮45过3失败，原测试按HTMLMediaElement.prototype的全局pause/load次数断言。新增卡片清理增加全局调用；断言改为核对弹窗player自身的调用上下文，原行为仍验证停止并释放src，18项通过。
2. 主审发现并已修复：同video旧play回执暂停新播放；午夜遇活动批次漏更新；首项慢请求不显示本次0/N；自动纠页清掉失败管理选择；IO首回调前整页附src；失焦/hidden期间新hover复活；跨年省略年份。对应15项回归覆盖主要已发现边界。
3. 自动纠页新增用例首轮失败属于合成路由未decode中文ID，修正fixture后通过。
4. 门闩回调useRef(()=>false)首次完整TS推断成()=>false，显式注解()=>boolean后完整TS通过。
5. 原生输入补测的一次诊断字符串引用SyntaxError已修；一次无提升权限的Chrome探针在Page.enable超时，以与主脚本相同权限重新对照后得到下述明确限制。

## 原生拖拽输入链限制

主浏览器验收的批量拖拽用DOM DragEvent/DataTransfer派发，验证实际React处理、载荷、目标与逐项请求，但不能等同于操作系统原生拖影/输入验收。

额外用CDP鼠标按下/移动/松开及drag interception核对：作品封面和信息区均没有取得native dragstart；再用同页面直接append的标准draggable=true DIV、无业务处理、无preventDefault进行对照，可信mousedown buttons=1、后续可信mousemove buttons=1，但同样不发native dragstart/intercept。已记录为当前Windows headless/CDP输入链unsupported，不能据此断定业务不可拖，也不能声称原生拖拽通过。

试验中曾给button/video显式透传draggable，对照后没有证据支持其必要性，已全部撤回（连同仅用于试验的属性测试），恢复之前通过的生产行为。主脚本重新执行passed，nativeDrag单独为unsupported。完整控制证据在native-drag-control.json，不再追Chrome内部。

未覆盖：安装态、真实用户媒体、真实文件迁移、系统原生拖影。实际后端文件一致性由另一代理相关测试与主会话集成审核核实。
