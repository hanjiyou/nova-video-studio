# GitHub 下载断点续传分析

日期：2026-10-26。状态：主会话已完成代码核对、官方资料核对和公开资产小范围实测；本轮只分析，不修改续传代码，不发布、不安装、不访问生成接口或真实凭据。

## 结论与适用对象

GitHub Release 的本项目3.6.6 EXE公开下载链路支持单段字节Range，已实际收到准确的206和文件中间字节。服务器能力不等于当前Nova已实现中断续传，也不能推广成所有GitHub接口/代理始终支持。

三条链路必须分开：

| 链路 | 当前实现 | 本次结论 |
| --- | --- | --- |
| 用户下载/更新GitHub安装包 | electron-updater 6.8.11；允许差量更新，GitHub provider禁用多段Range同请求；完整已校验安装包可复用 | 单段Range服务器条件成立；失败临时下载不具备已确认的持久断点续传 |
| 发布脚本远端字节校验 | 流式读取完整远端资产计算SHA512；本次修复同次成功校验缓存身份 | 减少重复校验与断点续传不同；当前失败后不保存远端下载片段/哈希状态 |
| 图片/视频生成结果下载 | OpenSosen受管接口或返回的CDN/签名地址，临时文件每次新建、失败清理；已完成文件检查点可复用 | 不是GitHub安装包链路；GitHub结果不能证明cn/com或供应商CDN支持续传，尚未验证这些端点 |

## 公开资产实测

对象：[Nova Studio 3.6.6 Release](https://github.com/hanjiyou/nova-video-studio/releases/tag/v3.6.6)，文件Nova-Studio-3.6.6-github-test-x64.exe，归档长度133783907字节。公开下载URL跳转到release-assets.githubusercontent.com。仅匿名GET；每请求最多接收8192字节，限时15–25秒，未下载整包，未修改VPN/TUN/代理设置。本次不证明是绕过系统TUN的直连，也不比较下载速度。

| 请求 | 实际结果 | 判断 |
| --- | --- | --- |
| Range bytes=1024-2047 | 302后206，Content-Range bytes 1024-2047/133783907，Content-Length 1024，实际1024字节；与本地归档EXE同位置逐字节一致 | 非首段Range确实生效，不仅是HEAD宣称支持 |
| Range bytes=2048-3071，If-Range为上一响应ETag | 206，正确范围、1024字节，ETag一致 | 匹配条件下可请求后续段 |
| Range bytes=3072-4095，故意错误If-Range | 206，正确范围、1024字节；实际ETag仍为原文件 | 当前链路没有按预期因错误条件回退200，不能依赖If-Range单独保护文件身份 |
| 再次错误If-Range、Range bytes=4096-5119、Cache-Control:no-cache | 仍206；请求追踪确认两个请求均发送了带引号的If-Range条件头 | 排除没有发送条件头这一解释；不推断具体是源站还是CDN缓存处理造成 |
| Range bytes=133783907-133784930 | 416，Content-Range bytes */133783907，正文0字节 | 越界反馈可用，但416本身不代表本地文件已完整 |
| 资产API /releases/assets/675544712，Accept:application/octet-stream，Range bytes=0-1023 | 匿名403 rate limit exceeded，278字节JSON | 本次未确认API入口Range，不以限流判定为不支持，也不读取Token重试 |

成功响应含Accept-Ranges: bytes及强ETag。没有实际替换远端文件，没有验证过期跳转URL、多段Range、完整中断/重启恢复、其他网络或电脑B；本次证明范围仅为上述公开EXE当前链路。报告不存短期签名跳转URL、Token或完整原始响应。

## 现有代码核对

- desktop/update-service.cjs显式启用差量更新（disableDifferentialDownload=false）。node_modules/electron-updater/out/providers/GitHubProvider.js设isUseMultipleRangeRequest=false，含义是避免一条请求请求多个区间，不是禁止单段Range。
- 锁定依赖electron-updater 6.8.11的AppUpdater.executeDownload会验证完整缓存；下载失败清理状态。DownloadedUpdateHelper.createTempUpdateFile先删除已有同名临时文件，httpExecutor以普通createWriteStream写新文件。因此不能将差量更新/完整缓存复用宣传为中断后从已下载字节继续。
- 差量更新从旧安装包复制可复用块、从远端补变化块；它可能减少总下载量，但不是继续上次未完成的临时下载。
- scripts/release-windows-update.cjs的remoteHash目前只流式计算摘要，不保存部分文件。成功校验缓存仅限同次交付且完整元数据一致；本轮Release ID类型修复不新增Range。
- backend/storage/download-worker.js只接受正常200、为每个未完成输出新建.part，finally清理；readCheckpoint/saveCheckpoint复用的是已完整验证保存的输出，不是半个文件。

## 若以后实现，建议的最小边界

先明确要改善安装包下载还是图片/视频下载，分别实现，不顺带重写两套下载器。GitHub安装包方向建议单段顺序续传，不新增并行分片：

1. 保存受管临时文件和小型记录：固定版本/asset身份、目标文件名、总大小、已落盘长度、强ETag及可信最终摘要；继续前核对实际文件长度。保持现有签名/渠道/来源约束。
2. 从已确认偏移发Range并带If-Range；重试重新走稳定公开下载入口，不永久保存短期签名跳转地址。每跳仍限制来源并剥离不该转发的凭据。
3. 只有206且Content-Range起点/终点/总长、ETag和正文长度一致才能追加；ETag不同或可信身份改变必须丢弃旧片段重新下载。服务返回200时按新文件处理，禁止追加完整正文。416只在本地长度等于可信总长且完整摘要通过后才能算完成。
4. 全部下载完成后重新读取本地整文件计算可信SHA512，再走既有签名与安装门槛；网络分段成功不能替代完整校验。
5. 保持取消/超时/清理责任明确，只复用本次目标对应片段；失败提示如实区分“继续下载”与“重新下载”。先测试同进程重试，再考虑重启恢复，不引入额外加密体系。

规模判断：这不是增加一个Range头的小修改。安装包方向属于中等改动，需要处理更新器下载集成、片段记录、状态/进度、校验清理与测试；现有更新器会清理临时文件，需先确定可维护的集成点，不直接修改node_modules或随意替换整个更新器。媒体方向还涉及任务尝试身份、多输出、cn/com切换及过期来源，且缺真实端点证据；本轮不承诺相同规模或直接实现。

验收最低覆盖：正确206续接、忽略Range的200、错误/缺失Content-Range、总长或ETag变化、错误If-Range仍206、416完整/不完整、过期跳转重新获取、连接中断/取消、重启片段校对、磁盘失败、最终摘要/签名失败，以及不得拼接其他版本或重复绑定作品。使用本地合成服务，真实GitHub仅做低流量只读补证。

## 来源

- [GitHub官方Release资产接口](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)：公开资源可匿名读取，下载可能直接200或302跳转；该文档不是所有路径均支持Range的保证。
- [HTTP Range与If-Range规范 RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)：206/200/416和条件范围语义；客户端需处理服务器忽略Range等情况。
- 本项目锁定依赖和生产代码核对，以及上述2026-10-26实测；以本机安装版本为准，不拿新版依赖行为代替当前实现。
