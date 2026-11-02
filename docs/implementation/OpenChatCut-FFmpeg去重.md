# OpenChatCut 本地预览包 FFmpeg 去重

> 2026-11-02发布后状态：GitHub Test 3.6.11已提交、推送、独立构建并公开发布，包含剪辑基础入口、参考图粘贴和保存提示优化。素材/工程/成片进一步融合继续暂缓，未验证能力与正式签名/安装升级门槛保持；旧local.1/local.2不变。以下“仅源码/未打包/3.6.10基线”均为发布前阶段记录，当前以[3.6.11交付记录](3.6.11-交付记录.md)为准。

> 2026-11-02 状态核对：local.2已构建并保留，local.1为历史包；本次只核对既有产物、证据与文档，未重跑包体验证。用户已暂缓后续Nova融合。11月2日参考图粘贴及保存提示改动仍仅在源码，不在本包内；统一状态见[总任务清单](../Nova-Studio落地任务清单.md)。

日期：2026-11-01。用户要求先做小范围体积优化，仅去掉重复FFmpeg。旧local.1包保留，新包版本3.6.11-local.2；没有提交、推送、发布或安装覆盖。

## 修改范围

- Nova与OpenChatCut原先的FFmpeg二进制SHA256相同：`04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`，每份82797568字节（约79MiB）。
- Nova与剪辑共用的通用FFmpeg仅分发 `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe`，不再复制 `resources/openchatcut/node_modules/ffmpeg-static/ffmpeg.exe`。剪辑的ffmpeg-static模块、许可证与说明保留，其余564个生产包不裁剪。
- Remotion还自带不同的n7.1渲染版本（ffmpeg.exe为325120字节，另有其配套库），与通用6.1.1版哈希不同，完整保留。通用副本2→1；包内所有名为ffmpeg.exe的文件总数实际为3→2，并非只剩一个同名文件。
- 原版已有路径覆盖接口。宿主在包体检查通过后，把固定路径经OPENCHATCUT_FFMPEG与FFMPEG_BIN传给隔离服务；不继承外部同名环境变量，不增加页面配置或任意执行入口，不修改子模块源码。
- nova-runtime.json记录sharedFfmpeg的SHA256与字节数；运行预检核对Nova既有审计清单、受管路径、文件大小和哈希。文件缺失/改变或出现重复副本均拒绝启动；页面只收到安全状态码。
- 开发模式和旧包保留原有路径规则。构建阶段创建的共享文件镜像仅供预检，安装包内使用Nova原有副本，不引入另一份打包资源。

## 验证

运行 `node --test scripts/openchatcut-runtime.test.cjs scripts/openchatcut-preview.test.cjs backend/test/openchatcut-host.test.js scripts/deliver.test.cjs`，47/47通过；覆盖二进制一致才允许去重、保留模块和许可、缺失/篡改/重复拒绝、拒绝继承外部媒体路径和宿主窄传递。

使用 `npm run deliver -- local --version 3.6.11-local.2 --execute` 构建并自动验证。原版和Nova生产构建通过，包体/EXE/原版工作区与关闭检查通过。验证器额外创建一秒合成音频，经原版上传及音频提取API完成实际编码；关闭GPU并清除开发工具PATH，不能依赖开发仓库或系统FFmpeg。该检查不代表完整视频编辑/导出或安装升级验收。

## 实测体积

| 项目 | local.1 | local.2 | 减少 |
| --- | --- | --- | --- |
| 安装器 | 552.5 MiB | 531.8 MiB | 20.7 MiB |
| 相同版本的通用FFmpeg副本数 | 2 | 1 | 1 |
| 解压后重复二进制 | 82797568字节 | 0 | 约79MiB |

安装器使用相同压缩配置，压缩体积与解压体积分别报告。对比剪辑资源文件列表及大小，删除项仅FFmpeg二进制，无新增文件；大小变化项仅运行资源清单。未裁剪Copilot、推理依赖或其他能力。

新安装包：[Nova-Studio-Editor-Preview-3.6.11-local.2-x64.exe](../../release-local-editor/3.6.11-local.2/Nova-Studio-Editor-Preview-3.6.11-local.2-x64.exe)。安全证据：[真实包运行与合成音频](openchatcut-ffmpeg-dedup-evidence/packaged-runtime-result.json)、[体积对比](openchatcut-ffmpeg-dedup-evidence/size-comparison.json)。

接入能力仍以[验收清单](../acceptance/openchatcut-native.md)为准；素材交接、Agent凭据、成片回库和正式交付继续待后续任务。
