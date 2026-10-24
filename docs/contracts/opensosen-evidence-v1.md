# OpenSosen 协议证据 v1

日期：2026-10-23。T01 只提取历史证据并建立离线测试，没有发送新的生成请求。

机器可读清单：[evidence-index.json](../../backend/test/fixtures/workbench-v1/evidence-index.json)。本机历史根目录为 `C:\Users\Administrator\.codex\visualizations\2026\10\21\01a15e71-63d5-7d42-b848-53f2b376ab64`；这是证据定位，不是应用默认路径，也不是测试运行所需目录。每个原始来源记录 SHA-256，提交的 fixtures 自包含，不依赖这些绝对路径。

## 来源与可信范围

| ID | 原始资料 | 可确认内容 |
| --- | --- | --- |
| H01 | dialogue-video/single-image-job.json | 1.5-6s 单个 input_reference、原始 JPEG、seconds=6、size=1280x720；有创建正文与完成/下载记录，但该文件没保留创建 HTTP 状态码 |
| H02 | multi-image-protocol-tests/repeated-input-reference/manifest.json | 双文件请求描述、线上创建 HTTP200+queued、in_progress 与 completed 完整查询正文、独立 wire_check 原图字节/顺序、下载记录 |
| H03 | multi-image-protocol-tests/comparison.json | 两图视觉影响的历史对照结果及局限；不证明严格首尾帧锁定 |
| H04 | peephole-json-input-reference/response.json | JSON input_reference 数组被 HTTP400 拒绝，解析器要求字符串；不能推断字符串URL或Data URL已可用 |
| H05 | multi-image-protocol-tests/images-array/response.json | JSON images 数组被 HTTP400 拒绝，保留多层嵌套JSON错误；不代表模型只支持单图 |
| H06 | multi-image-protocol-tests/repeated-input-reference/result.json | 历史输出媒体信息及视觉检查摘要；时长6.041667秒、1280×720、有音轨，不是新应用播放证明 |
| D01 | 桌面 OpenSosen视频生成接口使用说明.md v1.1 | 对历史请求、查询、content下载、未知供应商规则的整理；不是运营方完整规范 |
| P01 | E盘 ai-agent-book/视频工作台功能规划-拆解-方案.md | 61项产品范围及候选协议，不能替代原始成功请求 |

H02 历史原图顺序与字节摘要：1号PNG为 1,514,260 bytes / `07c8b977476513f227a711a4e3b33d6d2b92f75970ea7b271a963d1572f1c40e`；2号PNG为 1,671,548 bytes / `a7146330bf4ab109e93e86f8acdf006dd4a202a9928b65872892ce78e7ddc9a7`。历史 wire_check 文件 MIME 为 application/octet-stream。测试夹具替换为无隐私的微小 PNG/JPEG，并验证声明的 image/png 或 image/jpeg 与原文件字节，不把这一测试当作新的供应商 MIME 接受证据。

## 已确认与仍未知

历史可确认的组合只有当前归档中的 `https://newapi.opensosen.com/v1` + `grok-imagine-video-1.5-6s` + 单图/双图 + multipart 原图文件 + `seconds=6`、`size=1280x720`。双图按顺序重复 `input_reference`，不使用 input_reference[]、JSON数组、图片URL或首尾帧参数。应用首版只开放两张是产品限制，不是供应商上限。

| 组合 / 能力 | 当前结论 |
| --- | --- |
| 1.5 单图、双图 | historically_verified，历史实测；本应用完整生成/保存/播放仍需 T15 |
| 两个视频型号的文生 JSON | unverified：规划提及 duration/aspect_ratio/resolution，但本次限定证据里没有对应原始成功请求；不以去掉文件的 multipart 补猜 |
| 普通 Grok 双图、三张及更多图、竖版/1080p | unverified |
| flare 文生图 | 有用户既往成功信息，但此处未归档其精确原始协议响应；后续按证据补齐 |
| flare 参考图编辑 | unverified，不能沿用别处 birdsun 或其他型号的 image/image[] 结论 |
| 上游幂等、主动取消、退款/计费、资源有效期、跨域重定向鉴权 | 未验证，不填入服务承诺 |
| 异步 failed/取消正文、429/Retry-After | 原线路缺完整真实响应；mock 中相关形状明确为 synthetic |

## 归档和模拟的区别

`historical_response_sanitized` 夹具保留真实字段名、类型和HTTP状态（缺失则null），替换任务/请求ID、提示词、资源URL；`status/body` 是历史辅助程序的外包装，不是上游正文新增一层。完成响应中 size='16:9'、seconds='6'、duration=6 按原样保存，不能把 size 当输出像素。

原始人物图片、提示词、视频、签名URL、Key、计费日志及完整原始 multipart 均不提交。以微小合成图片替代私有原图，替代文件不是历史输入的字节副本；原图摘要只用来说明来源。合成请求的字节与顺序由测试再次真实发送到 loopback 接收端核对。

mock 的 JSON 文生传输测试只证明 JSON 捕获可用。它不使文生协议变成已验证，也不证明未来生产适配器不会重试。生产无重复创建行为必须由 T02/T05 接入 mock 后，统计生产路径真实发出的 POST 再验收。

远端 completed 夹具只代表可进入下载阶段；默认下载内容为任意测试字节，并不是可播放MP4。JSON伪MP4、断流、503等是下载故障支撑，T08还须接入真实媒体验证、原子落盘和本地完成逻辑。没有用 mock 成功填写61项产品已验收。

## B1 补充调查与证据版本

2026-10-23 的 B1 精准调查保留原 T01 条目、摘要和能力等级，向机器清单追加：

| ID | 原始来源 | 可确认范围 |
| --- | --- | --- |
| H07 | 历史 H02 同目录 run.mjs | 成功任务使用 GET /v1/videos/{encodeURIComponent(taskId)}；配合 H02 查询正文确认端点，不猜 POST 查询 |
| D02 | 当前桌面说明 v1.2 | v1.1 之后的迁移/下载说明；另存当前 SHA，不覆盖 D01 旧版本摘要 |
| C01 | 历史 opensosen-media/server.mjs | 客户端候选图片 JSON 最小构造，以及已有任务 /content 下载实现；客户端代码单独不能证明精确 flare 文生/编辑或视频文生成功 |

B1 对 1.5 已归档模式使用原服务 /videos/{id}/content 稳定候选交给 T08，不持久保存返回的 CDN/签名 URL；未执行新下载或新生成来升级证据。原文件 wire MIME 的历史观察仍为 application/octet-stream，离线传输测试的 image/png/jpeg 声明并不构成新的真实供应商 MIME 接受记录。

flare 的 JSON/base64/URL 合成响应放在 backend/test/fixtures/b1，明确 synthetic_offline_only；只证明候选适配和安全分支。两个视频型号文生、flare 参考编辑及尺寸/质量仍未取得精确成功协议。实现边界见 [B1 接口](../b1-adapters-v1.md)，T15 仍须有效配置与明确费用/预算后进行受控真实验证。

## T15 应用验证版本（2026-10-24，追加）

`opensosen-application-evidence-2026-10-24-v1` 仅为原 OpenSosen 精确 URL 的 flare 最小文生图、1.5 单参考和双参考追加 `application_verified` 记录。正常应用启动为已有连接幂等补登，新连接同样登记；旧 v1 行和历史任务 UUID/快照不改。真实图片完整解码/预览、视频下载/完整解码/实际播放及参考特征证据见 [T15 能力收尾](../implementation/T15-能力版本与验收收尾.md)。

flare 只开放无图、无额外参数的 `{model,prompt,n:1}`；不代表编辑、尺寸、比例或质量枚举成功。视频文生、普通版参考及其他服务保持未验证。早期关于“尚无成功”的段落为各历史批次当时结论，本追加记录不改写原来源与摘要。首轮跨 FormData 品牌错误已本地复现并另行授权复测，成功证据来自修复后的两个新请求，不来自原 HTTP 400。
