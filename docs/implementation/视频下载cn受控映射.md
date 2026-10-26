# 视频下载cn受控映射（2026-10-26）

> 2026-10-26 替代说明：下文为此前固定cn映射的已审核历史证据。当前工作区已由[统一线路方案](../OpenSosen线路切换实施规划.md)替换为用户选择cn/com，第一批后端源码与离线范围已主审，第二批界面待主审。不得再按下文恢复无条件cn下载映射；独立[下载提示修复](下载重试提示状态修复.md)继续保留。尚未提交或发布本轮统一线路修改。

状态：代码与离线验证完成，本轮源码与离线范围主审通过；未提交、推送、打包、发布。

## 2026-10-26 OpenSosen 视频下载域名受控映射

仅原连接 baseUrl 精确为 https://newapi.opensosen.com/v1、结果为 video、authScope=connection，且原URL为该.com源的 /v1/videos/{单个编码ID段}/content（无query/hash/userinfo）时，下载器发起GET到 https://newapi.opensosen.cn 的相同路径。编码ID含%2F允许。生成、状态查询与持久化来源继续保持.com；历史任务重试同样走此下载入口。

只有本次映射得到的精确cn URL可携带原连接Key；每跳重新检查URL，离开该URL后永久剥离Key，包括同cn域其他路径、另一任务content、查询串及返回原目标。不新增通用跨域认证，不自动回退.com，不重新生成。显式cn来源配.com连接仍按跨域来源拒绝。公共URL检查、完整下载/校验/保存与原时限保持。无凭据HEAD返回401仅证明TLS可达，不证明实际同Key兼容、速度或未被TUN接管。

实现仅修改backend/storage/download-worker.js，新增test/workbench-download-cn.test.js。worker保持source对象不变；映射条件满足后认证匹配从原服务前缀收窄为本次cn精确URL，既有leftService门闩防重获认证。

验证：node --test backend/test/workbench-download-cn.test.js backend/test/workbench-downloads.test.js backend/test/workbench-download-progress.test.js，60/60通过。其中新9项覆盖旧来源重复使用、encoded ID、其他供应商/图片/匿名来源/非content不映射、直接cn带连接认证拒绝、重定向边界与401不回退。合成传输及隔离临时目录，不读取真实Key/数据库，不请求真实生成。没有实测实际下载速度或凭据兼容；不实现断点续传。
