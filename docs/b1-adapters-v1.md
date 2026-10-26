# B1 图片与视频适配接口 v1

## 统一访问线路补充（2026-10-26）

模型列表、flare图片生成/编辑、既有OpenSosen视频创建/查询和受管content下载复用单一后端路由策略；仅两个精确内置HTTPS源之间映射合法端点。保持原请求路径、编码任务ID、参数和不可变连接/能力身份，不把当前线路写回 `getAuth().baseUrl`。此前固定cn下载特例由所选cn/com替代。

生成在任务创建时冻结 `transportRoute`；查询在每次请求前读取原任务所属连接当前线路，已发出请求不中断。原版本Key被清除仍暂停，不读取新版本Key；生成不自动重定向、切线回退或重复POST。CDN、签名URL和其他供应商不替换域名，认证仍按每跳精确目标判定。

com身份和原能力ID可通过线路控件选择cn；不将com成功证据复制为cn真实证据，不扩展直接编辑cn基础地址的能力矩阵。models 的 `generation_unverified` / `see_capability_evidence` 与具体模式能力分别解释，后者不代表所有模式验证。Preview、未实测窄例外与原图/参数约束保持。见[后端记录](implementation/R01-R05-统一线路后端实施记录.md)及[第二批记录](implementation/R06-R08-统一线路界面与整体验收.md)；真实cn生成尚未执行。

B2/T08当前已完成下载、完整媒体校验、目录版本、Range及系统文件动作的实现和离线/原生验证，基础范围已由主会话审核接受并明确批准提交推送，见[B2审核](implementation/b2-evidence/approval-review.json)；下文“待B2”保留为B1交付时的历史边界，当前行为见[B2媒体契约](b2-media-v1.md)。能力闸门与真实线路证据等级没有变化。

日期：2026-10-23。B1=T06+T07 的离线实现基础范围及上游 ID 补修已由主会话复审通过，明确批准提交并推送 origin/dev，见[审核记录](implementation/b1-evidence/approval-review.json)。本页不将参考编辑或文生视频标为完整验收。61 项需求、17 个任务编号和 B2–B7 计划保持。

## 桌面创建边界

新增桌面专用 POST /api/nova/workbench/tasks，复用桌面会话鉴权、T05 持久去重与单生成占位。请求严格只接收：

~~~json
{
  "localRequestId": "UUID",
  "connectionVersionId": "UUID",
  "capabilityVersionId": "UUID",
  "mode": "video.dual_reference",
  "model": "grok-imagine-video-1.5-6s",
  "prompt": "中文原文\n“完整台词”",
  "parameters": { "seconds": 6, "size": "1280x720" },
  "inputAssets": [
    { "assetId": "UUID", "role": "reference", "position": 0 },
    { "assetId": "UUID", "role": "reference", "position": 1 }
  ]
}
~~~

outputDirectoryVersionId/outputRootRef 可沿用 T05 的可选 UUID 引用，输入时随快照冻结；B2/T08 仍须补齐目录/下载交接。调用方保存同一个本地意图后再发送，丢失 ACK 时复用原 ID 和快照。成功返回 202 {taskId}，与旧任务共用 GET /api/nova/tasks/:id 和 T05 动作端点。前端 createWorkbenchTask 只发一次 POST，不读取当前设置重绑连接，不自动重试或换型号。

输入校验先验证模式与张数，再匹配 capabilityVersionId 的 provider/baseUrl/精确 model/mode/protocol；参数同时受实现边界与历史能力约束。图片文生恰好 0 图、参考至少 1 图；视频文生 0 图、单图 1 图、双图 2 图。数量或顺序错误为 INPUT_INVALID；缺少成功协议证据为 CAPABILITY_UNVERIFIED。这些都是未派发结论，不是上游不支持的最终裁定，不删除产品需求。未知字段、Key、地址覆盖、路径、任意 URL 和错用的能力版本均拒绝。

旧桌面图片入口中新建 flare 意图返回 WORKBENCH_INPUT_REQUIRED，已有完全相同的旧持久意图仍可去重读取；新 OpenSosen 插件不通过旧 plugin-tasks 表单协议创建。其他旧图片和 ccode JSON 插件路径保持。Web 不提供新工作台创建入口。完整工作台页面在 B3/B4 接线，本阶段没有把旧页面伪装成新能力可用界面。

## T06 图片边界

适配器 opensosen-flare-image / 1.0.0 使用精确 gpt-image-2.5-flare。候选文生请求来自历史客户端 C01：POST /v1/images/generations，JSON 仅 model、原 prompt、n=1；省略 streaming 及 size/quality/style/background 等附加字段，不受旧图片 SSE 环境开关影响。C01 是实现记录，不是精确型号成功原始请求/响应证据，所以正式入队仍被能力闸门拒绝；离线测试通过不会升级数据库能力。

参考编辑有独立 buildReferenceSubmit 边界，当前只返回 CAPABILITY_UNVERIFIED，不猜 /images/edits 字段、不沿用其他服务的 image/image[]，也不转文生。尺寸、质量仍待精确证据和 T15，未开放任意枚举。

合成 data[].url/b64_json 归一化为 ResultSource。空数组、空项、坏 base64、不支持的字节签名、无有效 URL 和凭据污染均不成功。PNG/JPEG 签名只用于候选类型归一化，不等于完整解码验证；B2/T08 负责验证、保存和本地 completed。请求期限覆盖完整响应正文；headers 后挂起不提前结束期限。候选请求也只有一次 POST，无换模型/换参数重试。

## T07 视频与宿主传输

内置插件 opensosen-video / 1.0.0 包含 manifest、显式 schema、driver；两个精确模型与三种模式都保留。schema 与固定参数从已检查的合成器结果固化，仅展示 6 秒及 16:9；声明上限两图属于应用首版限制，不是供应商上限。

目前仅原服务 https://newapi.opensosen.com/v1 + grok-imagine-video-1.5-6s + 单/双参考 + seconds=6 + size=1280x720 有历史成功证据。driver 返回有序 multipart parts 和连接版本鉴权描述，不包含 Key 或文件路径。宿主按冻结的 inputAssets 找 assetId，验证受管文件哈希、原文件类型/签名并逐项 append FormData；重复 input_reference 文件保留原 PNG/JPEG 字节和顺序，不重采样、不转 WebP。普通文本的逻辑换行保留，wire 使用 WHATWG FormData 的 CRLF 规范化；不回写提示词。boundary 由 FormData 产生，手填 Content-Type/boundary 被拒绝。

H07 历史成功脚本与 H02 完整正文确认只读 GET /v1/videos/{单路径段编码ID}；H01/H02/H06 的下载记录及历史客户端、D02 确认 /content。新解析器区分 queued、in_progress、completed；明确 failed/cancelled 分支用合成测试验证，未宣称取得这两种真实失败正文。未知状态暂停；progress 只取合法的上游数值，不推算完成时间。

远端 completed 归一化为原服务 GET /v1/videos/{id}/content 候选，authScope=connection，避免持久化返回的临时 CDN/签名 URL。这只交付结果描述，不执行下载；T08 仍须检查精确服务源、每跳重定向鉴权、媒体、落盘与恢复。两个型号的文生、普通 Grok 的参考组合仍未验证，不能通过删文件、JSON 数组/URL 或其他供应商参数来猜协议。双图语义是有序参考，不是严格首尾帧。

## 持久任务与后续下载

T05 先把 dispatch_started 事务提交，再调用一次创建。driver 的 extractAcceptedId 在解析后续字段前调用 onAccepted，使 ID 立即入库；随后字段污染/解析异常也保留 ID，只能原连接 GET。原版本凭据不可用保持暂停，不自动改绑。补 ID 仅校验格式/凭据后保存为暂停，显式 resume 才 GET，不宣称已经确认任务归属。

已派发 submission_unknown/polling_paused 继续占唯一生成名额；停止查询不等于远端取消/退款。GET 沿用持久的有界重试、Retry-After 和 notBeforeAt；POST 无自动重发。HTTP/WS/历史/事件/日志不暴露 Key、两轮百分号编码的 Key、base64 或原资源 URL。

remote_completed 与下载队列登记后没有下载 worker，因此不是 completed。本接口允许适配器返回瞬时 URL/inline 字节；图片带查询的 URL 当前仍在 T05 边界被拒绝持久化。B2 需实现瞬时交接、同 ID 刷新及无 ID 同步结果的明确恢复限制，不通过重新生成恢复资源。未实现 .part、Range、解码、CDN 跳转或下载闭环。

## 证据与后续验收

[历史证据索引](contracts/opensosen-evidence-v1.md)保留原等级，新增 H07/D02/C01 来源摘要；[B1 实施记录](implementation/B1-T06-T07-图片视频适配.md)区分实现、离线验证和待验证能力。flare 响应 fixtures 明确 synthetic_offline_only，视频复用 T01 脱敏历史请求/响应与替代小图。所有新生成行为均为 loopback 合成服务，未读取真实 Key 或调用外部收费生成。T15 必须先有用户有效配置和明确费用/预算范围，再补精确协议和真实应用生成/保存/播放证据；发现服务最终不支持时才请求产品范围裁定。

## 审核修复：纯点段 ID

主会话指出 . / .. 经 URL 解析会退化为集合/父路径。现统一使用 plugin-runtime/upstream-id：接收和手动补ID拒绝纯点段，查询/content构造同样检查；%2E 不作为替代。普通含点ID以及斜杠、百分号、中文仍按单段一次编码，声明式旧插件同样处理。不可查询的上游返回进入 submission_unknown，已有不可查询ID恢复为 polling_paused，均保留占位、不重POST；无效手动补ID没有网络或持久ID副作用。有效补ID仍须显式 resume 才GET，且仍不证明归属。最新包与相关回归见[B1实施记录末节](implementation/B1-T06-T07-图片视频适配.md)。
