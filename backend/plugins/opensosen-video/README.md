# OpenSosen 视频协议边界

版本 1.0.0。此插件属于 Nova 工作台 B1，使用桌面 POST /api/nova/workbench/tasks 的持久任务、连接版本和 assetId 输入。旧通用 plugin-tasks 表单不能代替该契约。

仅 grok-imagine-video-1.5-6s 单/双图 + multipart + seconds=6 + size=1280x720 有历史成功证据。普通 Grok、文生及其他规格保留为待验证需求。双图是有序参考，不命名为严格首尾帧。

driver 构造有序 parts，宿主读取原始受管 PNG/JPEG；不接收路径、URL、base64 或 JSON 图片数组，不手填 boundary。查询与 content 使用同一个精确服务源和原任务 ID，下载仍由 T08 实现。没有自动 POST 重试、模型替换或远端取消。

协议 fixtures 复用 ../../test/fixtures/workbench-v1 中的 video-single-request、video-dual-request、video-created、video-generating 和 video-completed。它们的来源及历史/合成区别见 ../../../docs/contracts/opensosen-evidence-v1.md。直接生产适配器、真实本地 HTTP 和 Windows Electron 验证见 ../../../docs/implementation/B1-T06-T07-图片视频适配.md。mock 不是新的真实供应商成功或媒体播放验收。

审核补修：仅为 . / .. 的上游ID不可安全作为 WHATWG URL 单段，当前明确拒绝，查询与content均使用宿主统一校验/编码。普通含点、斜杠、百分号及中文ID不被这一限制误拦；不可查询ID不会触发新生成。
