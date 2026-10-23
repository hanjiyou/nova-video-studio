# T01 loopback provider

仅用于离线测试，入口为 `startMockProvider(options)`，返回 baseUrl（固定绑定127.0.0.1随机端口）、requests、taskIds、count(method,path)、counters、close()。不读取环境Key、不访问外网、不加载生产后端，不修改全局fetch或生产插件allowlist。调用方必须在finally或测试after中close。

```js
const { startMockProvider, FIXTURE_TOKEN } = require('./mock-provider');
const mock = await startMockProvider({ submitSteps: [{ disconnect: 'after_accept' }] });
// 测试客户端直接指向mock.baseUrl，鉴权固定为Bearer fixture-token。
// 观察mock.counters.submitPosts/acceptedCreates后，在finally中await mock.close()。
```

- POST /v1/videos 接收 JSON 或 multipart；普通文本和File分开捕获，重复字段保留顺序，File包含bytes/MIME/name/SHA-256。verifyMultipart(record,expected)逐字节检查，不将图片解码为文本。FormData会把标量换行规范为CRLF，测试只规范换行，不trim/折叠空白。
- GET /v1/videos/{id} 默认返回历史脱敏的in_progress、completed；每任务独立推进，最后一步重复。GET /v1/videos/{id}/content 只对完成任务提供下载，支持简单bytes=start-end范围。
- submitPosts在收到每次创建请求时计数，包含鉴权拒绝或坏请求；acceptedCreates只统计mock实际创建的新远端任务，不含seedTasks。相同localRequestId/Idempotency-Key不会被此mock去重，故意保留检测重复POST的能力。
- submitSteps/pollSteps/downloadSteps 是顺序响应脚本，元素支持 status（HTTP状态）、body、headers、delayMs、disconnect:'mid_body'；submit还支持accept和disconnect:'after_accept'。body.status才是远端任务状态。未配置body时submit使用历史创建结构；pollSteps应显式提供body。
- seedTasks:[{id,rawStatus:'completed'}] 支持已有ID恢复/下载测试，无需发新POST。authFailureStatus可为401/403，错误token不会保存到requests；maxBodyBytes默认1MiB，用于保护测试进程。
- after_accept先创建任务再断开响应，展示客户端失败不能证明POST未发送；延迟响应可让客户端主动超时。mid_body发HTTP头和部分正文后断开。测试明确断言submitPosts=1且acceptedCreates=1。
- 下载默认DEFAULT_DOWNLOAD是任意字节，不是合法MP4。可以发JSON但声明video/mp4，或503、超大Retry-After、未知状态和合成failed，供未来生产恢复/媒体验证接入。
- 不提供主动取消端点；查询中的cancelled仅为合成状态。不实现供应商幂等/计费/退款。

运行：在backend执行 `node --test test/mock-provider.test.js test/workbench-contracts.test.js`。`npm test`默认也运行新用例；Node默认会把test/support/mock-provider.js作为一个无副作用的辅助文件计入总结果，实际新增断言用例为25项。

这些测试检验支撑设施本身和夹具/台账完整性，不证明尚未改造的生产客户端、状态机、下载器已经可靠，也不证明上游会接受合成输入。未来生产模块应通过测试专用注入或直接客户端使用mock，不能为测试放松生产SSRF限制。
