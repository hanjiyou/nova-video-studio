'use client';
import { useEffect, useRef, useState } from 'react';
import { generateUUID } from '@/lib/uuid';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { clearConnectionCredential, ConnectionModels, ConnectionSummary, getConnection, getConnectionModels, saveConnection, TransportRoute } from '@/lib/connection-client';
import { connectionMessage, localErrorMessage, OPENSOSEN_BASE, OPENSOSEN_ROUTE_BASES, validateBaseUrl } from '@/lib/workbench-client';
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
  const [route, setRoute] = useState<TransportRoute>(connection?.route || 'cn');
  const [needsReload, setNeedsReload] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const previousProp = useRef(connection);
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
  const supportsRoute = provider === 'opensosen' && Object.values(OPENSOSEN_ROUTE_BASES).includes(normalized.canonical || '') && (!saved || saved.baseUrl !== normalized.canonical || saved.provider !== provider || saved.routeSupported === true);
  const targetAddress = supportsRoute ? OPENSOSEN_ROUTE_BASES[route] : normalized.canonical;
  const savedAddress = saved?.routeSupported === true && saved.route && saved.provider === 'opensosen' && Object.values(OPENSOSEN_ROUTE_BASES).includes(saved.baseUrl) ? OPENSOSEN_ROUTE_BASES[saved.route || 'cn'] : saved?.baseUrl;
  const routeInput = supportsRoute ? {route, ...(saved ? {expectedRouteRevision: saved.routeRevision ?? 1} : {})} : {};
  const needsKey = !saved?.hasCredential || saved.credentialState !== 'ready' || normalized.canonical !== saved.baseUrl;
  const dirty = !saved || provider !== saved.provider || name !== saved.displayName || normalized.canonical !== saved.baseUrl || apiKey.length > 0 || (supportsRoute && route !== (saved?.route || 'cn'));
  const unsaved = saved ? dirty : provider !== 'opensosen' || name !== '我的创作服务' || address !== OPENSOSEN_BASE || apiKey.length > 0 || route !== 'cn';
  useEffect(() => {
    if (previousProp.current === connection) return;
    previousProp.current = connection;
    if (!connection || (saved?.connectionVersionId === connection.connectionVersionId && saved?.routeRevision === connection.routeRevision && saved?.route === connection.route)) return;
    void cancel(); setSaved(connection);
    if (!dirty) { setProvider(connection.provider === 'openai-compatible' ? 'openai-compatible' : 'opensosen'); setName(connection.displayName); setAddress(connection.baseUrl); setRoute(connection.route || 'cn'); setApiKey(''); setVisible(false); }
    else setMessage('保存的连接已更新，已保留本次表单输入，请核对后保存或测试。');
    // Reconcile external defaults/reloads without replacing a draft or remounting the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);
  useUpdateBlocker(() => unsaved || busy || checking || !!currentCheck.current);
  const valid = Boolean(name.trim() && name.length <= 100 && normalized.canonical && (apiKey.trim() || !needsKey));
  async function persist(): Promise<ConnectionSummary> {
    if (!dirty && saved) return saved;
    const sequence = revision.current;
    {
      const result = await saveConnection({ ...(saved ? { connectionId: saved.connectionId, expectedVersionId: saved.connectionVersionId } : {}), displayName: name, baseUrl: normalized.canonical, provider, ...routeInput, ...(apiKey.trim() ? { apiKey } : {}) });
      if (!mounted.current) return result;
      setSaved(result); onSaved(result);
      // Never replace a form edit made while encryption/IPC was in flight.
      if (sequence === revision.current) { setAddress(result.baseUrl); setRoute(result.route || 'cn'); setApiKey(''); setVisible(false); setNeedsReload(false); }
      return result;
    }
  }
  async function saveLater() {
    setBusy(true); setError(''); const sequence = revision.current;
    try { await persist(); if (mounted.current && sequence === revision.current) { setMessage('配置已加密保存，连接尚未验证。'); await onSaveLater?.(); } }
    catch (e) { if (mounted.current && sequence === revision.current) { setNeedsReload(e instanceof Error && ['CONNECTION_ROUTE_CONFLICT', 'CONNECTION_VERSION_CONFLICT'].includes(e.message)); setError(localErrorMessage(e)); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function test() {
    const sequence = revision.current, operationId = generateUUID();
    currentCheck.current = operationId; setBusy(true); setChecking(true); setError(''); setMessage('正在验证访问并获取模型列表（只读，最长约 8 秒）…');
    try {
      const result = await window.novaDesktop?.validateAndSaveConnection({ ...(saved ? { connectionId:saved.connectionId, expectedVersionId:saved.connectionVersionId } : {}), displayName:name, baseUrl:normalized.canonical, provider, ...routeInput, ...(apiKey.trim() ? {apiKey} : {}), operationId, ...(onboarding ? {expectedOnboardingRevision:onboardingRevision} : {}) });
      if (!mounted.current || sequence !== revision.current) return;
      if (result?.stale || result?.cancelled) { setMessage(result.stale ? '检查结果已过期，本次修改未保存。请重新读取线路与版本后重试。' : '检查已取消，本次修改未保存。'); setNeedsReload(Boolean(result.stale)); return; }
      if (!result?.ok) throw Error(result?.code);
      if (!result.connection) {
        if(result.currentConnection) {setSaved(result.currentConnection);onSaved(result.currentConnection);}
        const failure = result.validationState || 'offline';
        const status = connectionMessage({ ...(saved || {}), hasCredential:true, credentialState:'ready', validationState:failure } as ConnectionSummary);
        setMessage(''); setError(result.httpStatus === 403 ? '当前凭据无权访问此接口（403），请核对权限。未保存本次修改。' : status + ' 本次修改尚未保存，可重试或保存后稍后验证。'); return;
      }
      setSaved(result.connection); setAddress(result.connection.baseUrl); setRoute(result.connection.route || 'cn'); setApiKey(''); setVisible(false); setNeedsReload(false);
      onSaved(result.connection); onModels(result as ConnectionModels);
      setMessage(connectionMessage(result.connection)); await onContinue?.();
    } catch (e) { if (mounted.current && sequence === revision.current) { setMessage(''); setNeedsReload(e instanceof Error && ['CONNECTION_ROUTE_CONFLICT', 'CONNECTION_VERSION_CONFLICT'].includes(e.message)); setError(localErrorMessage(e)); } }
    finally { if (mounted.current && sequence === revision.current) { currentCheck.current=null; setChecking(false); setBusy(false); } }
  }
  async function reload() {
    if (!saved) return;
    setBusy(true); setError('');
    try {
      const current = await getConnection(saved.connectionId);
      if (!mounted.current) return;
      setSaved(current); onSaved(current); setNeedsReload(false);
      setMessage('已重新读取保存的线路与版本。已保留本次名称、地址、线路和 Key 输入，请核对后再次保存或测试。');
    } catch (e) { if (mounted.current) setError(localErrorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
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
    <div className="wb-saved"><ShieldCheck size={17} />{saved ? `当前已保存：${saved.displayName} · ${savedAddress}` : '尚未保存连接'}{dirty && saved && <span>有未保存的修改</span>}</div>
    <label>服务预设<select disabled={busy && !checking} value={provider} onChange={event => { edited(); const next = event.target.value as typeof provider; setProvider(next); setRoute('cn'); setAddress(next === 'opensosen' ? OPENSOSEN_BASE : ''); }}><option value="opensosen">OpenSosen</option><option value="openai-compatible">自定义兼容服务</option></select></label>
    <label>连接名称<input disabled={busy && !checking} value={name} maxLength={100} onChange={event => { edited(); setName(event.target.value); }} autoComplete="off" /></label>
    <label>接口基础地址<input disabled={busy && !checking} readOnly={supportsRoute} value={supportsRoute ? targetAddress : address} onChange={event => { if (!supportsRoute) { edited(); setAddress(event.target.value); } }} placeholder="https://服务域名/v1" autoComplete="off" aria-invalid={Boolean(address && normalized.error)} /></label>
    {supportsRoute && <label>访问线路<select disabled={busy && !checking} value={route} onChange={event => { edited(); setRoute(event.target.value as TransportRoute); }}><option value="cn">国内线路（.cn，默认）</option><option value="com">国际线路（.com）</option></select></label>}
    {address && normalized.error ? <p className="wb-error">{normalized.error}</p> : normalized.canonical && <p className="wb-help">只读检查目标：{targetAddress}/models</p>}
    <label>API Key <span className="wb-key-field"><input disabled={busy && !checking} type={visible ? 'text' : 'password'} value={apiKey} onChange={event => { edited(); setApiKey(event.target.value); }} autoComplete="new-password" spellCheck={false} placeholder={saved?.hasCredential ? '已保存；填写以更新 API Key' : '填写你的 API Key'} /><button type="button" className="wb-icon" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} onClick={() => setVisible(old => !old)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></label>
    <p className="wb-help">使用 Windows 系统保护加密保存。保存成功后清空输入；离开页面或按 Esc 后恢复遮挡。{needsKey && !apiKey.trim() && ' 请填写 API Key。'}</p>
    <p className="wb-help">名称、地址和 Key 保存后用于新任务；旧任务始终使用原连接版本的 Key。检查仅请求模型列表，不生成图片或视频，也不要求文本模型。</p>
    {supportsRoute && <><p className="wb-help">线路保存后用于新建任务及后续查询、重新下载；已发出的请求保持原线路，不会因切换而中断或重新生成。线路不控制 VPN，也不保证更快。</p><p className="wb-help">{route === 'cn' ? '国内线路的真实生成及媒体下载仍待验证。' : '生成是否可用仍以具体模型、模式和参数的能力证据为准。'} 模型列表检查通过不代表所有生成模式已验证。</p></>}
    <div aria-live="polite" role="status">{message && <p className="wb-notice">{message}</p>}</div>
    {error && <p role="alert" className="wb-error">{error}</p>}
    {needsReload && saved && <button type="button" disabled={busy} onClick={() => void reload()}>重新读取线路与版本（保留输入）</button>}
    <div className="wb-actions">
      {onSkip && <button type="button" className="wb-link" disabled={busy && !checking} onClick={() => { void Promise.resolve(cancel()).then(() => { setApiKey(''); setVisible(false); return onSkip(); }).catch(e => setError(localErrorMessage(e))); }}>稍后配置</button>}
      <button type="button" disabled={!valid || busy} onClick={() => void saveLater()}>{onboarding ? '保存，稍后验证' : '保存连接'}</button>
      {checking ? <button type="button" onClick={() => { cancel(); setMessage('检查已取消，可重新测试。'); }}>取消检查</button> : <button type="button" className="wb-primary" disabled={!valid || busy} onClick={() => void test()}>{busy ? '正在保存…' : onboarding ? '测试连接并继续' : '测试连接 / 刷新模型'}</button>}
    </div>
    {!onboarding && saved?.hasCredential && <div className="wb-danger-zone"><button type="button" disabled={busy} onClick={() => setConfirmClear(true)}>清除已保存凭据</button>{confirmClear && <div role="alertdialog" aria-label="清除凭据确认"><p>将清除此连接所有版本的 Key，需要鉴权的旧任务将暂停。远端可能继续生成或计费。任务、上游 ID 和本地作品仍保留；重新填写 Key 不会自动修复旧版本。</p><div className="wb-actions"><button type="button" onClick={() => setConfirmClear(false)}>保留凭据</button><button type="button" onClick={() => void clear()}>确认清除</button></div></div>}</div>}
  </form>;
}
