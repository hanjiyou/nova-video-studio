'use client';
import { useEffect, useRef, useState } from 'react';
import { generateUUID } from '@/lib/uuid';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { clearConnectionCredential, ConnectionModels, ConnectionSummary, getConnectionModels, saveConnection } from '@/lib/connection-client';
import { connectionMessage, localErrorMessage, OPENSOSEN_BASE, validateBaseUrl } from '@/lib/workbench-client';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
interface Props {
  connection: ConnectionSummary | null;
  onboarding?: boolean;
  onboardingRevision?: number;
  onSaved: (connection: ConnectionSummary) => void;
  onModels: (models: ConnectionModels) => void;
  onContinue?: () => Promise<void>;
  onSaveLater?: () => Promise<void>;
  onSkip?: () => Promise<void>;
}
export function ConnectionForm({ connection, onboarding, onboardingRevision, onSaved, onModels, onContinue, onSaveLater, onSkip }: Props) {
  const [saved, setSaved] = useState(connection);
  const [provider, setProvider] = useState<'opensosen' | 'openai-compatible'>(connection?.provider === 'openai-compatible' ? 'openai-compatible' : 'opensosen');
  const [name, setName] = useState(connection?.displayName || '我的创作服务');
  const [address, setAddress] = useState(connection?.baseUrl || OPENSOSEN_BASE);
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const revision = useRef(0);
  const currentCheck = useRef<string | null>(null);
  const mounted = useRef(true);
  const cancel = () => {
    revision.current += 1;
    const active = currentCheck.current; currentCheck.current = null;
    if (mounted.current) { setChecking(false); setBusy(false); }
    return active ? window.novaDesktop?.cancelConnectionValidation({operationId:active}) : Promise.resolve();
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const active = currentCheck.current; currentCheck.current = null; if(active) void window.novaDesktop?.cancelConnectionValidation({operationId:active}); }; }, []);
  function edited() { cancel(); setMessage(''); setError(''); }
  const normalized = validateBaseUrl(address);
  const needsKey = !saved?.hasCredential || saved.credentialState !== 'ready' || normalized.canonical !== saved.baseUrl;
  const dirty = !saved || provider !== saved.provider || name !== saved.displayName || normalized.canonical !== saved.baseUrl || apiKey.length > 0;
  const unsaved = saved ? dirty : provider !== 'opensosen' || name !== '我的创作服务' || address !== OPENSOSEN_BASE || apiKey.length > 0;
  useUpdateBlocker(() => unsaved || busy || checking || !!currentCheck.current);
  const valid = Boolean(name.trim() && name.length <= 100 && normalized.canonical && (apiKey.trim() || !needsKey));
  async function persist(): Promise<ConnectionSummary> {
    if (!dirty && saved) return saved;
    const sequence = revision.current;
    try {
      const result = await saveConnection({ ...(saved ? { connectionId: saved.connectionId, expectedVersionId: saved.connectionVersionId } : {}), displayName: name, baseUrl: normalized.canonical, provider, ...(apiKey.trim() ? { apiKey } : {}) });
      if (!mounted.current) return result;
      setSaved(result); onSaved(result);
      // Never replace a form edit made while encryption/IPC was in flight.
      if (sequence === revision.current) setAddress(result.baseUrl);
      return result;
    } finally { if (mounted.current) { setApiKey(''); setVisible(false); } }
  }
  async function saveLater() {
    setBusy(true); setError(''); const sequence = revision.current;
    try { await persist(); if (mounted.current && sequence === revision.current) { setMessage('配置已加密保存，连接尚未验证。'); await onSaveLater?.(); } }
    catch (e) { if (mounted.current) setError(localErrorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    const sequence = revision.current, operationId = generateUUID();
    currentCheck.current = operationId; setBusy(true); setChecking(true); setError(''); setMessage('正在验证访问并获取模型列表（只读，最长约 8 秒）…');
    try {
      const result = await window.novaDesktop?.validateAndSaveConnection({ ...(saved ? { connectionId:saved.connectionId, expectedVersionId:saved.connectionVersionId } : {}), displayName:name, baseUrl:normalized.canonical, provider, ...(apiKey.trim() ? {apiKey} : {}), operationId, ...(onboarding ? {expectedOnboardingRevision:onboardingRevision} : {}) });
      if (!mounted.current || sequence !== revision.current || result?.stale || result?.cancelled) return;
      if (!result?.ok) throw Error(result?.code);
      if (!result.connection) {
        if(result.currentConnection) {setSaved(result.currentConnection);onSaved(result.currentConnection);}
        const failure = result.validationState || 'offline';
        const status = connectionMessage({ ...(saved || {}), hasCredential:true, credentialState:'ready', validationState:failure } as ConnectionSummary);
        setMessage(''); setError(result.httpStatus === 403 ? '当前凭据无权访问此接口（403），请核对权限。未保存本次修改。' : status + ' 本次修改尚未保存，可重试或保存后稍后验证。'); return;
      }
      setSaved(result.connection); setAddress(result.connection.baseUrl); setApiKey(''); setVisible(false);
      onSaved(result.connection); onModels(result as ConnectionModels);
      setMessage(connectionMessage(result.connection)); await onContinue?.();
    } catch (e) { if (mounted.current && sequence === revision.current) { setMessage(''); setError(localErrorMessage(e)); } }
    finally { if (mounted.current && sequence === revision.current) { currentCheck.current=null; setChecking(false); setBusy(false); } }
  }
  async function clear() {
    if (!saved) return;
    cancel(); setConfirmClear(false); setBusy(true); setError('');
    try {
      const result = await clearConnectionCredential({ connectionId: saved.connectionId, expectedVersionId: saved.connectionVersionId });
      if (!mounted.current) return;
      setSaved(result); setApiKey(''); setVisible(false); onSaved(result); onModels(await getConnectionModels(result.connectionId));
      setMessage('已清除此连接所有版本的凭据。任务和作品仍保留；旧任务不会改用新凭据。');
    } catch (e) { if (mounted.current) setError(localErrorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <form className="wb-form" onSubmit={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); setApiKey(''); setVisible(false); setConfirmClear(false); setMessage('已停止检查并清空未保存的 Key。'); } }}>
    <div className="wb-saved"><ShieldCheck size={17} />{saved ? `当前已保存：${saved.displayName} · ${saved.baseUrl}` : '尚未保存连接'}{dirty && saved && <span>有未保存的修改</span>}</div>
    <label>服务预设<select value={provider} onChange={event => { edited(); const next = event.target.value as typeof provider; setProvider(next); setAddress(next === 'opensosen' ? OPENSOSEN_BASE : ''); }}><option value="opensosen">OpenSosen</option><option value="openai-compatible">自定义兼容服务</option></select></label>
    <label>连接名称<input value={name} maxLength={100} onChange={event => { edited(); setName(event.target.value); }} autoComplete="off" /></label>
    <label>接口基础地址<input value={address} onChange={event => { edited(); setAddress(event.target.value); }} placeholder="https://服务域名/v1" autoComplete="off" aria-invalid={Boolean(address && normalized.error)} /></label>
    {address && normalized.error ? <p className="wb-error">{normalized.error}</p> : normalized.canonical && <p className="wb-help">只读检查目标：{normalized.canonical}/models</p>}
    <label>API Key <span className="wb-key-field"><input type={visible ? 'text' : 'password'} value={apiKey} onChange={event => { edited(); setApiKey(event.target.value); }} autoComplete="new-password" spellCheck={false} placeholder={saved?.hasCredential ? '已保存；填写以更新 API Key' : '填写你的 API Key'} /><button type="button" className="wb-icon" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} onClick={() => setVisible(old => !old)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
    <p className="wb-help">使用 Windows 系统保护加密保存。保存结束后清空输入；离开页面或按 Esc 后恢复遮挡。{needsKey && !apiKey.trim() && ' 请填写 API Key。'}</p>
    <p className="wb-help">修改只在保存后影响新任务。旧任务始终绑定原连接版本。检查仅请求模型列表，不生成图片或视频，也不要求文本模型。</p>
    <div aria-live="polite" role="status">{message && <p className="wb-notice">{message}</p>}</div>
    {error && <p role="alert" className="wb-error">{error}</p>}
    <div className="wb-actions">
      {onSkip && <button type="button" className="wb-link" disabled={busy && !checking} onClick={() => { void Promise.resolve(cancel()).then(() => { setApiKey(''); setVisible(false); return onSkip(); }).catch(e => setError(localErrorMessage(e))); }}>稍后配置</button>}
      <button type="button" disabled={!valid || busy} onClick={() => void saveLater()}>{onboarding ? '保存，稍后验证' : '保存连接'}</button>
      {checking ? <button type="button" onClick={() => { cancel(); setMessage('检查已取消，可重新测试。'); }}>取消检查</button> : <button type="button" className="wb-primary" disabled={!valid || busy} onClick={() => void test()}>{busy ? '正在保存…' : onboarding ? '测试连接并继续' : '测试连接 / 刷新模型'}</button>}
    </div>
    {!onboarding && saved?.hasCredential && <div className="wb-danger-zone"><button type="button" disabled={busy} onClick={() => setConfirmClear(true)}>清除已保存凭据</button>{confirmClear && <div role="alertdialog" aria-label="清除凭据确认"><p>将清除此连接所有版本的 Key，需要鉴权的旧任务将暂停。远端可能继续生成或计费。任务、上游 ID 和本地作品仍保留；重新填写 Key 不会自动修复旧版本。</p><div className="wb-actions"><button type="button" onClick={() => setConfirmClear(false)}>保留凭据</button><button type="button" onClick={() => void clear()}>确认清除</button></div></div>}</div>}
  </form>;
}
