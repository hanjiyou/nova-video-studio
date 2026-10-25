import {videoRule,configuredVideo,validVideoParameters,videoDefaults} from './workbench-model-catalog';
import type { CapabilitySummary, ConnectionModels, ConnectionSummary } from './connection-client';
import type { Draft, HistoryTask } from './workbench-client';
import type { WorkbenchTaskInput } from './workbench-task-client';
import { MAX_VIDEO_REFERENCE_ASSETS, unverifiedMultiSubmissionAllowed } from './reference-policy';
import { unverifiedImageCapability } from './image-policy';
export const generationEvidenceVerified = (capability?: CapabilitySummary) => capability?.evidenceLevel === 'historically_verified' || capability?.evidenceLevel === 'application_verified' && capability.evidence.applicationVerified === true && Array.isArray(capability.evidence.sourceIds) && capability.evidence.sourceIds.length > 0;
export const TASK_LABELS: Record<string, string> = { local_queued: '等待处理', submitting: '提交中', submission_unknown: '提交结果待核对', remote_queued: '远端排队', generating: '生成中', polling_paused: '查询已暂停', remote_completed: '等待下载', downloading: '下载中', download_failed: '下载失败', completed: '已保存到本机', failed: '失败', local_cancelled: '已取消本地等待', remote_cancelled: '远端已取消', timed_out: '超时失败' };
export const terminalTask = (status: string) => ['completed', 'failed', 'download_failed', 'local_cancelled', 'remote_cancelled', 'timed_out'].includes(status);
export function generationPlan(draft: Draft, connection: ConnectionSummary | null, models: ConnectionModels | null) {
  const image = draft.mode === 'image.text';
  const model = draft.model || (image ? connection?.defaultImageModel : connection?.defaultVideoModel) || (image ? 'gpt-image-2.5-flare' : 'grok-imagine-video-1.5-6s');
  const mode = (image && draft.inputAssets.length ? 'image.reference' : draft.mode === 'video.dual_reference' && draft.inputAssets.length > 2 ? 'video.multi_reference' : draft.mode) as WorkbenchTaskInput['mode'];
  const matching = models && models.connectionVersionId === connection?.connectionVersionId ? models.capabilities.filter(item => item.model === model && item.mode === mode && item.baseUrl === connection?.baseUrl && item.provider === connection?.provider && item.protocol === connection?.protocol) : [];
  // A newer unverified scope never replaces the proven default in generic capability ranking.
  const imageControls = image ? matching.find(item => unverifiedImageCapability(item,connection)) : undefined;
  const wantsImageControls = image && (mode === 'image.reference' || Object.keys(draft.parameters).length > 0);
  const rule = !image ? videoRule(model,connection) : null;
  const videoConfiguration = rule ? matching.find(configuredVideo) : undefined;
  const capability = videoConfiguration || (wantsImageControls ? imageControls : matching.filter(item => item.isCurrent !== false && (!image || Object.keys(item.parameters).length === 0)).sort((a,b) => Number(b.isCurrent === true) - Number(a.isCurrent === true))[0]);
  const unverifiedImage = Boolean(wantsImageControls && imageControls);
  const unverifiedMulti = mode === 'video.multi_reference' && unverifiedMultiSubmissionAllowed(capability, connection);
  const sizes = imageControls ? imageControls.parameters.sizes as string[] : [];
  const qualities = imageControls ? imageControls.parameters.qualities as string[] : [];
  const parameters: Record<string, unknown> = image ? { ...draft.parameters } : Object.keys(draft.parameters).length ? { ...draft.parameters } : rule && videoConfiguration ? videoDefaults(model,rule,models) : { seconds: capability?.parameters.seconds ?? 6, ...(typeof capability?.parameters.size === 'string' ? { size: capability.parameters.size } : draft.mode === 'video.text' ? {} : { size: '1280x720' }) };
  const expectedCount = draft.mode === 'video.text' ? 0 : draft.mode === 'video.dual_reference' ? 2 : 1;
  let blocked = !connection?.hasCredential || connection.credentialState !== 'ready' ? '请先配置可用的连接凭据。' : '';
  if (!blocked && models?.modelsFetchedAt && models.models.find(item => item.model === model)?.visibility !== 'visible' && !models?.models.find(item=>item.model===model)?.custom) blocked = '该完整型号不在当前模型列表中，请明确选择型号或刷新列表。';
  if (!blocked && !generationEvidenceVerified(capability) && !unverifiedMulti && !unverifiedImage && !(videoConfiguration && rule?.submissionEnabled)) blocked = '当前完整模型、模式与规格尚未取得成功协议证据，暂不开放提交。';
  if (!blocked && !draft.prompt.trim()) blocked = '请填写提示词。';
  if (!blocked && !image && (mode === 'video.multi_reference' ? draft.inputAssets.length < 3 || draft.inputAssets.length > MAX_VIDEO_REFERENCE_ASSETS : draft.inputAssets.length !== expectedCount)) blocked = draft.mode === 'video.dual_reference' ? `当前模式需要 2 张及以上参考图，应用最多 ${MAX_VIDEO_REFERENCE_ASSETS} 张。服务实际支持数量待确认。` : `当前模式需要 ${expectedCount} 张参考图。`;
  if (!blocked && image && draft.inputAssets.length > 1) blocked = '图片编辑每次使用 1 张参考图；已保留全部引用，请明确移除多余图片。';
  if (!blocked && draft.inputAssets.some(asset => asset.availability !== 'available')) blocked = '参考图缺失或损坏，请移除后重新导入。';
  if (!blocked && image && (Object.keys(parameters).some(key => !['size', 'quality'].includes(key)) || parameters.size !== undefined && !sizes.includes(String(parameters.size)) || parameters.quality !== undefined && !qualities.includes(String(parameters.quality)))) blocked = '草稿保留了当前能力未确认的图片规格，请核对后明确调整。';
  if (!blocked && !image && rule && videoConfiguration && !validVideoParameters(rule,parameters)) blocked = `请输入 ${rule.minSeconds}～${rule.maxSeconds} 的整数秒，并核对画面尺寸。`;
  if (!blocked && !image && !videoConfiguration && (parameters.seconds !== capability?.parameters.seconds || parameters.size !== capability?.parameters.size || Object.keys(parameters).some(key => !(typeof capability?.parameters.size === 'string' ? ['seconds','size'] : ['seconds']).includes(key)))) blocked = '历史规格与当前能力不一致，未自动修改，请核对草稿。';
  return { image, model, mode, capability, rule, videoConfiguration, unverifiedMulti, unverifiedImage, sizes, qualities, parameters: parameters as WorkbenchTaskInput['parameters'], blocked };
}
export function reusableDraft(task: HistoryTask): Pick<Draft, 'model' | 'prompt' | 'parameters' | 'inputAssets'> {
  return { model: task.model, prompt: task.prompt, parameters: { ...task.parameters }, inputAssets: [...(task.inputAssets || [])] };
}
export const taskExecutionActive = (task: HistoryTask) => task.downloadAttempt?.active === true || (typeof task.localExecutionActive === 'boolean' ? task.localExecutionActive : !task.localOutcome && !terminalTask(task.status));
const PHASE_LABELS: Record<string,string> = {reference_upload:'准备参考图',submitting:'提交与等待响应',receiving:'接收响应',parsing:'解析结果',remote_waiting:'远端等待',downloading:'下载结果',validating:'验证媒体',saving:'保存作品'};
export function taskStage(task: HistoryTask) {
  if(task.downloadAttempt?.active) return (task.lifecycleVersion===2&&task.downloadAttempt.attemptNumber===1?'':'下载重试 · ')+(!task.downloadAttempt.startedAt?'等待下载':PHASE_LABELS[task.phase || ''] || '下载中');
  if(!taskExecutionActive(task)) return TASK_LABELS[task.status] || '本地执行已结束';
  if(task.status==='local_queued') return task.requiresContinue?'等待明确继续':'等待处理';
  if(task.status==='polling_paused') return '查询已暂停（仍计时）';
  if(task.phase==='remote_waiting') return task.remoteState==='generating'?'远端生成中':task.remoteState==='queued'?'远端排队':'远端等待';
  return PHASE_LABELS[task.phase || ''] || TASK_LABELS[task.status] || '处理中';
}
export function durationLabel(start: string | null | undefined, finish: string | null | undefined, now: number) {
  const from = start ? Date.parse(start) : NaN, to = finish ? Date.parse(finish) : now;
  if(!Number.isFinite(from) || !Number.isFinite(to) || to<from) return '未知';
  const seconds=Math.floor((to-from)/1000);return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
}
export function taskTiming(task: HistoryTask, now: number) {
  const ended=!taskExecutionActive(task) || Boolean(task.localOutcome);
  const finish=task.generationFinishedAt || task.localFinishedAt || (ended?task.completedAt:null);
  const queue=task.dispatchStartedAt?durationLabel(task.createdAt,task.dispatchStartedAt,now):task.timeoutSeconds!=null || task.status==='local_queued'?durationLabel(task.createdAt,finish,now):'未知';
  const execution=task.dispatchStartedAt?(!finish&&ended?'未知':durationLabel(task.dispatchStartedAt,finish,now)):task.upstreamTaskId || task.generationReserved?'旧记录未提供':'尚未派发';
  const retry=task.downloadAttempt;
  return {queue,execution,limit:task.timeoutSeconds!=null?task.timeoutSeconds+' 秒':'旧记录未提供',deadline:task.deadlineAt || null,download:retry?(retry.startedAt?durationLabel(retry.startedAt,retry.finishedAt,now):'等待下载'):null,downloadLimit:retry?retry.timeoutSeconds+' 秒':null};
}
export function elapsed(task: Pick<HistoryTask,'createdAt'|'completedAt'> & Partial<HistoryTask>, now: number) {
  const finish=task.localFinishedAt || task.completedAt;
  if((task.localOutcome || terminalTask(task.status || ''))&&!finish)return '未知';
  return durationLabel(task.createdAt,finish,now);
}
