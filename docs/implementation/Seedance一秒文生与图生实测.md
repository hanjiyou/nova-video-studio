# Seedance一秒文生与图生实测

日期：2026-11-05。用户授权模型doubao-seedance-2.0-mini文生、单图各一次，时长各1秒；随后明确批准仅为本次测试读取既有中转操作凭据文件。真实外部生成POST共2次，每模式1次。未更改正式模型配置、已安装应用、Key分组或时长；未提交推送、打包发布。

## 实际结果

| 模式 | 请求 | 中转结果 | 成品 |
| --- | --- | --- | --- |
| video.text | multipart model/prompt/seconds=1，无size、无文件 | HTTP500，get_channel_failed | 无任务ID、无成品 |
| video.single_reference | 同上，额外1个input_reference PNG文件 | HTTP500，get_channel_failed | 无任务ID、无成品 |

两次后台安全错误消息一致：`分组 auto 下模型 doubao-seedance-2.0-mini 的可用渠道不存在（retry）`。错误中的retry是服务端原文，本地没有按此重发生成。

服务端requestId分别为`202611050633017093139608268d9d68VhP0cXb`和`202611050633259676868938268d9d6DUqVAfde`，供中转侧查找。请求客户端时间为UTC06:33:00/06:33:24附近，即北京时间14:33:00/14:33:24附近；requestId中的时间格式不作为客户端时区证据。

这证明请求已经到达中转且被其渠道选择拒绝；尚未验证实际生成参数、1秒时长、图像引导、状态查询和content取回。也不能据此认定协议不兼容，或整个中转平台所有分组都没有该模型。需先检查本次Key的auto分组与Seedance渠道/分组的匹配、启用和可用状态。

## 预检与范围

匿名公开价格GET及带凭据型号GET均HTTP200，型号目录包含Seedance、端点标签openai；其公开价格条目enable_groups为`【视频】视频接口使用Sora协议`。原条目model_price为0.25、quota_type为1；本次未确认单位/倍率或账单，不把此值写成已验证人民币每秒价格。型号可见、公开标签不代替实际渠道可用性。

测试读取本机当前Nova连接的只读元数据并冻结cn线路/revision；实际凭据来自用户随后明确批准的既有中转操作配置，按newapi.opensosen.com/cn区段精确选取，不使用另一个oneapi区段。Key仅进程内使用，未写日志/报告或改写用户连接。当前安全存储在隔离测试进程中解密失败；首次改读文件被自动审批拒绝后，取得用户对该具体来源的明确授权才继续。

图生输入为专门创建的1280×720红球测试PNG，无用户工程素材。沿用生产opensosen-video驱动和multipart请求构造器，仅在独立测试进程中注册精确的两个1秒候选模式；应用model-rules.json未修改。查询、下载、真实媒体验证流程已准备并复用生产模块，但由于未取得ID，本次没有执行这些阶段。不能写作工作台端到端生成验收成功。

初始隔离脚本显式传入新版undici dispatcher，与Electron内置fetch的处理器接口不兼容，返回UND_ERR_INVALID_ARG。已用相同调用在本地模拟服务复现：handler校验失败时0连接、0请求；改用兼容的全局dispatcher后本地请求HTTP200。该问题发生在建立socket之前，不计作供应商生成提交。保留原始本地失败ledger，再恢复仍未发出的两个授权意图；后续实际外部POST各一次。此为测试脚本初始化问题，不作为11月4日用户网络超时根因。

## 证据

- [脱敏实际结果](seedance-live-20261105/result.json)
- [只读预检结果](seedance-live-20261105/preflight-result.json)
- [本地传输兼容性证明](seedance-live-20261105/offline-transport-proof.json)

原始内部派发ledger和隔离脚本留在本次本地测试目录，未进入生产包。正式Seedance接入继续保留待验证状态；再次真实生成需要适用的后续授权，不自动增加本轮预算。
