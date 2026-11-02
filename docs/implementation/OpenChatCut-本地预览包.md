# OpenChatCut 本地剪辑预览包

## 当前包与使用入口（2026-11-02核对）

现有最新本地剪辑预览包是 **3.6.11-local.2**，安装器557641548字节（531.8MiB）；local.1的579343802字节（552.5MiB）包保留追溯。local.2已实际构建，并验证原版界面与合成音频提取，见[去重记录](OpenChatCut-FFmpeg去重.md)。均为独立本地预览身份，未提交、发布或执行安装器。

- 当前安装器：[Nova-Studio-Editor-Preview-3.6.11-local.2-x64.exe](../../release-local-editor/3.6.11-local.2/Nova-Studio-Editor-Preview-3.6.11-local.2-x64.exe)。
- 当前免安装入口：[Nova Studio Editor Preview.exe](<../../release-local-editor/3.6.11-local.2/win-unpacked/Nova Studio Editor Preview.exe>)，必须保留整个win-unpacked文件夹。
- local.2不含11月2日新完成的参考图粘贴与草稿保存提示优化；这些源码尚未重新构建。
- 原版编辑器已基础接入；与Nova的进一步融合按用户决定暂缓，真实Agent服务、完整编辑/导出与安装升级未整体验收。

下方local.1身份、体积、哈希和失败经过属于首个包的历史证据，不覆盖此处当前包结论。

> 2026-11-01 后续补充：已完成3.6.11-local.2，仅去掉重复FFmpeg，安装器降至531.8MiB，共用路径及实际音频编码通过，见[FFmpeg去重记录](OpenChatCut-FFmpeg去重.md)。下方local.1的字节、哈希和失败记录作为首个包的历史证据保留。

日期：2026-11-01。本地预览安装包构建、包体与真实 EXE 启动验证通过；用户授权只制作本地包，不提交、推送或发布，不安装覆盖现有应用。本记录补充首批运行与入口，不将 OCC04–OCC11 全部标为完成。

## 包身份与资源

- 首个包历史版本：`3.6.11-local.1`；Windows buildVersion：`3.6.11.1`。当前local.2版本与证据见上方。
- appId：`com.novaimage.studio.editor-preview`；package.name：`nova-studio-editor-preview`；productName：`Nova Studio Editor Preview`。与现有 GitHub Test 及正式版分开。
- 默认资料目录：`%APPDATA%\Nova Studio Editor Preview`；显式 `NOVA_DATA_DIR` 覆盖仍优先。不会自动导入已有版本的资料。安装时使用其独立默认目录。
- 不包含 `novaUpdate`，不生成发布清单，不启用更新；`--publish never`。本地未签名，正式发布门槛不变。
- 剪辑产物和生产依赖位于 `resources/openchatcut`，Nova 入口及窄运行检查位于 `app.asar`。不依赖开发仓库、外部 Node/npm/Git。
- 保留固定 fork 7fa4b7903e7ebecf832a36249f0c0c755200cc17；包内检查固定版本、服务/入口/锁文件/打包回执，不再在用户机器调用 Git。
- 仅收集明确构建产物和依赖，不复制原版开发配置、用户上传和真实资料；保留许可证。564 个生产包，不同步本地大模型；ONNX 二进制仅保留 Windows x64。

## 重现入口

```text
npm run deliver -- local --version 3.6.11-local.3
npm run deliver -- local --version 3.6.11-local.3 --execute
node scripts/verify-openchatcut-preview.cjs release-local-editor/3.6.11-local.2
```

双击根目录“交付菜单.bat”，选择第5项“仅本地打包”，填写新的本地预览版本，即可构建并自动验证。CLI 不带 `--execute` 只预览，无文件写入、Git或远端操作；执行路径只有本地构建与包体/启动验证，不要求审核记录，不接收提交、发布或网络参数。已有1–4项及正式交付门槛保留。

底层入口为 `npm run editor:pack:local -- --version 3.6.11-local.3`；附加 `--check-only` 可只检查。local.1和local.2都已实际生成且保留；重新构建使用未用过的local.3或后续版本，不能覆盖既有包。上方验证命令针对已存在的local.2，会启动隔离包体验证，不执行安装器。版本只接受三段版本加 `-local.N`，同步四段Windows FileVersion。

构建使用当前工作区，包括未提交变更；未冒充干净已提交的正式来源。产物目录已存在则拒绝覆盖。失败 attempt 和日志保留，后续重新构建使用新 attempt。

首个local.1历史包的安装器与可直接运行文件夹为（当前local.2入口见文首）：

```text
release-local-editor/3.6.11-local.1/Nova-Studio-Editor-Preview-3.6.11-local.1-x64.exe
release-local-editor/3.6.11-local.1/win-unpacked/Nova Studio Editor Preview.exe
```

安装包附 SHA256 与 build-summary.json；直接运行版必须保留整个 win-unpacked 文件夹。使用说明随包提供，见[本地剪辑预览包使用说明](../本地剪辑预览包使用说明.md)。

## local.1历史验证与失败记录

| 验证 | 结果与范围 |
| --- | --- |
| 资源映射修复后的 runtime/preview/host | 30/30；包含 builder 实际资源复制器回归 |
| deliver/preview/runtime/windows-update/windows-release/release-network | 102/102；不触发真实发布 |
| 随后隔离本地预览与发布代理，复跑受影响 deliver/preview | 16/16；与上项重叠，不相加 |
| 原版 TypeScript/Vite、Nova webpack/TypeScript/静态生产构建 | 通过；保留原有提示 |
| 实际包内生产依赖 | 564个逐项存在；隔离副本服务可启动 |
| 最终 EXE、app.asar、Nova IPC、原版 View、退出 | 通过；测试时清除开发工具PATH，使用全新临时资料，关闭GPU；不代表完整安装、GPU预览或真实媒体验收 |
| 安装器 | 579343802字节（约552.5MiB）；SHA256与侧车一致；27450个blockmap分块完整覆盖 |
| Windows资源与签名 | 安装器/应用 FileVersion均3.6.11.1，均NotSigned；安装器ProductVersion为3.6.11-local.1，应用PE ProductVersion由builder规范化为3.6.11.0，应用内版本由package读取3.6.11-local.1 |

SHA256：`c9f8a0a0f00057673117bfbc55870e2103085f5d0f5b6fd1e065dc3939f226f5`。安全证据见[真实包运行结果](openchatcut-local-package-evidence/packaged-runtime-result.json)与[完整性结果](openchatcut-local-package-evidence/artifact-validation.json)。原版Agent、资源、预览、时间线及六主页签均在实际包内加载；编辑页没有Nova preload或不完整原生桥。

首次 `.attempt-SI9sg5` 在原版构建与资源准备后失败：新入口直接调用 Next 时遗漏项目既有 `--webpack` 构建选项，触发默认 Turbopack 与原有配置冲突。已改为复用根目录 `npm run build`，未修改应用的构建模式，失败文件与日志保留。

第二次 `.attempt-pQWb5k` 已生成安装器，但最终包体检查发现剪辑依赖缺失，未提升为成功产物。原因是 builder 的 FileMatcher 对每个来源根目录下的 `node_modules` 固定过滤。已添加独立 `runtime/node_modules → resources/openchatcut/node_modules` 映射，并通过 builder 实际资源复制器补回归；没有改动依赖工具源码。

首次实际包探针错误地在Node inspector全局上下文直接调用CJS require，报require未定义；改为通过主模块require访问Electron，原始失败记录保留在产物目录。该调整只修改验证器，未重写安装包；随后真实EXE验证通过。

本轮完善的是本地打包流程。正式交付的子模块初始化、原生资源、完整许可证清单和来源绑定仍未完成，保留在OCC10候选中，当前不自动推进，现有提交/推送/发布流程未被改成完整剪辑分发流程。

本地预览并未接通作品库送入、Agent 凭据、成片回库或完整服务端渲染；真实媒体与安装升级验收继续待办。原版构建保留 Vite 未来配置、chunk 大小及 Browserslist 提示。
