'use client';
import { useEffect, useRef, useState } from 'react';
import { Film, Image as ImageIcon, Info, RefreshCw, Search } from 'lucide-react';
import { checkConnection, getModelDisplay, sameConnectionTransport, saveConnection, saveModelDisplay, type ConnectionModels, type ConnectionSummary, type ModelDisplaySettings, type TransportRoute } from '@/lib/connection-client';
import { classifiedModels, modelSubmissionEnabled } from '@/lib/workbench-model-catalog';
import { connectionMessage, localErrorMessage } from '@/lib/workbench-client';
import { useUpdateBlocker } from '@/hooks/useUpdateBlocker';
import { ModelCatalogSettings } from './DefaultSettings';

const empty: ModelDisplaySettings = { revision: 0, imageModels: [], videoModels: [], defaultImageModel: null, defaultVideoModel: null, pricingGroup: null };
const equal = (a: ModelDisplaySettings, b: ModelDisplaySettings) => JSON.stringify(a) === JSON.stringify(b);
const scopeOf = (connection: ConnectionSummary) => JSON.stringify([connection.connectionId, connection.connectionVersionId, connection.route, connection.routeRevision]);
export function ModelDisplaySettings({ connection, models, onModels, onSaved }: { connection: ConnectionSummary; models: ConnectionModels | null; onModels: (models: ConnectionModels) => void; onSaved: (connection: ConnectionSummary) => void }) {
  const catalog = models && sameConnectionTransport(connection, models) ? models : null;
  const [baseline, setBaseline] = useState(catalog?.displaySettings || empty), [draft, setDraft] = useState(catalog?.displaySettings || empty);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState({ image: '', video: '' }), [manage, setManage] = useState(false);
  const scope = scopeOf(connection), currentScope = useRef(scope), identity = useRef({ id: connection.connectionId, version: connection.connectionVersionId }), ticket = useRef(0), mounted = useRef(true);
  currentScope.current = scope;
  const dirty = !equal(draft, baseline), dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const latest = useRef(catalog); latest.current = catalog;
  const management = useRef<HTMLDivElement>(null);
  useUpdateBlocker(() => dirtyRef.current || busy);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ticket.current++; }; }, []);
  useEffect(() => { ticket.current++; setBusy(false); }, [scope]);
  useEffect(() => {
    if (identity.current.id !== connection.connectionId) {
      identity.current = { id:connection.connectionId,version:connection.connectionVersionId }; setBaseline(catalog?.displaySettings || empty); setDraft(catalog?.displaySettings || empty); setNotice(''); setConflict(false); setSearch({image:'',video:''}); return;
    }
    if (identity.current.version !== connection.connectionVersionId) {
      identity.current.version = connection.connectionVersionId;
      if (dirtyRef.current) { setConflict(true); setNotice('连接凭据版本已改变，当前修改已保留。请重新读取配置后核对，不能直接覆盖新连接配置。'); return; }
      setBaseline(catalog?.displaySettings || empty); setDraft(catalog?.displaySettings || empty); setConflict(false);
    }
    if (!catalog?.displaySettings || catalog.displaySettings.revision < baseline.revision) return;
    if (!dirtyRef.current) { setBaseline(catalog.displaySettings); setDraft(catalog.displaySettings); setConflict(false); }
    else if (catalog.displaySettings.revision !== baseline.revision) { setConflict(true); setNotice('配置已在其他位置更新。当前修改已保留，请重新读取后核对。'); }
  }, [catalog?.displaySettings, connection.connectionId, connection.connectionVersionId, baseline.revision]);
  const valid = (sequence: number, captured: string) => mounted.current && sequence === ticket.current && currentScope.current === captured;
  function toggle(kind: 'image' | 'video', model: string, checked: boolean) {
    const list = kind === 'image' ? 'imageModels' : 'videoModels', key = kind === 'image' ? 'defaultImageModel' : 'defaultVideoModel';
    setDraft(value => ({ ...value, [list]: checked ? [...new Set([...value[list], model])] : value[list].filter(name => name !== model), ...(!checked && value[key] === model ? { [key]: null } : {}) })); setNotice('');
  }
  async function refresh() {
    const sequence = ++ticket.current, captured = scope; setBusy(true); setNotice('');
    try { const value = await checkConnection(connection, true, 'manual'); if (!valid(sequence, captured)) return;
      if (value.stale || !value.models || !sameConnectionTransport(connection, value as ConnectionModels)) throw Error('CONNECTION_VERSION_CONFLICT');
      if (value.connection) onSaved(value.connection); onModels(value as ConnectionModels); setNotice(value.refreshError || value.connection?.validationState !== 'verified' ? '刷新未成功，保留上次清单和本次选择。' : '模型列表已更新，已保留本次选择；新型号默认不勾选。');
    } catch (error) { if (valid(sequence, captured)) setNotice('刷新失败，保留上次清单和本次选择。' + localErrorMessage(error)); }
    finally { if (valid(sequence, captured)) setBusy(false); }
  }
  async function changeRoute(route: TransportRoute) {
    const sequence = ++ticket.current, captured = scope; setBusy(true); setNotice('');
    try { const saved = await saveConnection({ connectionId: connection.connectionId, expectedVersionId: connection.connectionVersionId, expectedRouteRevision: connection.routeRevision ?? 1, route });
      if (!valid(sequence, captured)) return; onSaved(saved); setNotice('线路已保存。本次模型显示修改仍保留。');
    } catch (error) { if (valid(sequence, captured)) setNotice(localErrorMessage(error)); }
    finally { if (valid(sequence, captured)) setBusy(false); }
  }
  async function save() {
    if (busy || !dirty || !catalog?.displaySettings) return;
    const sequence = ++ticket.current, captured = scope, sent = draft; setBusy(true); setNotice('');
    try { const value = await saveModelDisplay(connection, sent); if (!valid(sequence, captured)) return;
      if (!sameConnectionTransport(connection, value) || !value.displaySettings || value.displaySettings.revision <= sent.revision) throw Error('CONNECTION_VERSION_CONFLICT');
      setBaseline(value.displaySettings); setDraft(value.displaySettings); setConflict(false); onModels(value); setNotice('配置已保存。默认型号仅用于新草稿。');
    } catch (error) { if (valid(sequence, captured)) { setConflict(error instanceof Error && ['MODEL_DISPLAY_CONFLICT','CONNECTION_VERSION_CONFLICT','CONNECTION_ROUTE_CONFLICT'].includes(error.message)); setNotice('保存失败，本次选择已保留。' + localErrorMessage(error)); } }
    finally { if (valid(sequence, captured)) setBusy(false); }
  }
  async function reload() {
    const sequence = ++ticket.current, captured = scope; setBusy(true);
    try { const value = await getModelDisplay(connection.connectionId); if (!valid(sequence, captured)) return; if (!sameConnectionTransport(connection,value) || !value.displaySettings) throw Error('CONNECTION_VERSION_CONFLICT');
      // Explicit reload discards edits and adopts the current connection baseline.
      setBaseline(value.displaySettings); setDraft(value.displaySettings); setConflict(false); onModels(value); setNotice('已重新读取保存的配置，请重新核对选择。');
    } catch (error) { if (valid(sequence,captured)) setNotice(localErrorMessage(error)); }
    finally { if (valid(sequence,captured)) setBusy(false); }
  }
  function cancel() { const incoming = latest.current?.displaySettings; const saved = incoming && (conflict || incoming.revision >= baseline.revision) ? incoming : baseline; setBaseline(saved); setDraft(saved); setConflict(false); setNotice('已取消本次模型显示更改。'); }
  function openManagement() { setManage(true); requestAnimationFrame(() => { management.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); management.current?.focus(); }); }
  const invalidDefault = (['image','video'] as const).some(kind => {
    const names=draft[kind==='image'?'imageModels':'videoModels'],name=draft[kind==='image'?'defaultImageModel':'defaultVideoModel'];
    return names.length>0 && (!name || !names.includes(name) || !catalog?.models.some(item=>item.model===name && item.visibility==='visible' && classifiedModels(catalog,kind).some(entry=>entry.model===item.model) && modelSubmissionEnabled(item,kind)));
  });
  const connected = connection.hasCredential && connection.credentialState === 'ready' && connection.validationState === 'verified';
  return <div className="wb-model-settings">
    <div className="wb-model-connection"><div className="wb-current-connection">当前连接：<strong>{connection.displayName}</strong><span className={connected ? 'wb-model-state ready' : 'wb-model-state'} title={connectionMessage(connection)}><i />{connected ? '已连接' : connectionMessage(connection)}</span></div>
      {connection.routeSupported && <label className="wb-route-compact">线路<select aria-label="当前访问线路" value={connection.route || 'cn'} disabled={busy} onChange={event => void changeRoute(event.target.value as TransportRoute)}><option value="cn">CN</option><option value="com">COM</option></select></label>}
      <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={18} />{busy ? '正在处理…' : '刷新模型'}</button>
    </div>
    <div className="wb-model-intro"><h2>模型显示</h2><p>勾选后显示在生成页，取消勾选仅隐藏入口，不影响历史任务和作品。</p><small>列表来自当前连接，刷新后保留选择，新模型默认不勾选。</small></div>
    {!catalog?.displaySettings && <p className="wb-warning" role="status">正在读取当前连接的模型显示配置…</p>}
    {catalog?.refreshError && <p className="wb-warning">最近刷新未成功，当前使用上次模型清单。</p>}
    <div className="wb-model-columns">{(['image','video'] as const).map(kind => {
      const title = kind === 'image' ? '图片模型' : '视频模型', Icon = kind === 'image' ? ImageIcon : Film, list = kind === 'image' ? 'imageModels' : 'videoModels', key = kind === 'image' ? 'defaultImageModel' : 'defaultVideoModel';
      const orphaned = (catalog?.models || []).filter(item=>draft[list].includes(item.model) && !classifiedModels(catalog,kind).some(entry=>entry.model===item.model));
      const entries = classifiedModels(catalog, kind).filter(item => item.model.toLocaleLowerCase().includes(search[kind].toLocaleLowerCase()));
      return <section className="wb-model-card" key={kind} aria-label={title}><header><h3><Icon size={25} />{title}</h3><span>已显示 {draft[list].length} 个</span></header>
        <label className="wb-model-search"><Search size={19} /><input aria-label={'搜索' + title} placeholder="搜索模型" value={search[kind]} onChange={event => setSearch(value => ({ ...value, [kind]: event.target.value }))} /></label>
        <div className="wb-model-table"><div className="wb-model-table-heading"><span>生成页显示</span><span>模型</span></div>
          {entries.map(item => { const checked = draft[list].includes(item.model), active = draft[key] === item.model, ready = modelSubmissionEnabled(item,kind) && (item.visibility === 'visible' || item.custom); return <div className="wb-model-row" key={item.model}>
            <label className="wb-model-check"><input type="checkbox" aria-label={'在生成页显示 ' + item.model} checked={checked} disabled={busy || !catalog?.displaySettings} onChange={event => toggle(kind,item.model,event.target.checked)} /></label>
            <span className="wb-model-name" title={item.model}>{item.model}</span><span className={'wb-model-state' + (ready ? ' ready' : '')}><i />{item.visibility === 'absent' && !item.custom ? '未列出' : ready ? '可生成' : '未接入'}</span>
            {active ? <span className="wb-default-badge">默认</span> : checked && ready && item.visibility === 'visible' ? <button type="button" className="wb-link" disabled={busy} aria-label={'将 ' + item.model + ' 设为默认'} onClick={() => { setDraft(value => ({ ...value,[key]:item.model })); setNotice(''); }}>设为默认</button> : <span />}
          </div>; })}{!entries.length && <p className="wb-model-empty">{search[kind] ? '没有匹配的模型' : '当前连接暂无此类模型'}</p>}
        </div>{orphaned.map(item=><div key={item.model} className="wb-model-orphan"><span>原选择已不属于此分类：{item.model}</span><button type="button" className="wb-link" disabled={busy} aria-label={'从'+title+'移除旧选择 '+item.model} onClick={()=>toggle(kind,item.model,false)}>移除旧选择</button></div>)}<p className="wb-help">默认型号必须是已勾选且已接入的模型。{draft[key] === null && '当前未设置默认型号。'}</p>

      </section>;
    })}</div>
        <label className="wb-pricing-group">图片参考价分组<select aria-label="图片参考价分组" disabled={busy || !catalog?.displaySettings} value={draft.pricingGroup || ''} onChange={event => { setDraft(value => ({ ...value, pricingGroup:event.target.value || null })); setNotice(''); }}><option value="">请选择参考价分组</option>{(catalog?.pricingGroups || []).map(group => <option key={group} value={group}>{group}</option>)}</select><small>{draft.pricingGroup ? '仅用于参考估价，实际扣费以服务结算为准。' : '请选择参考价分组，旧的中质量选择不会自动替换。'}</small></label>
    <div className="wb-model-management"><Info size={18} /><span>分类不正确？可在模型管理中调整图片 / 视频分类。</span><button type="button" className="wb-link" onClick={openManagement}>模型管理</button></div>
    {manage && <div ref={management} tabIndex={-1} className="wb-model-classification"><ModelCatalogSettings connection={connection} models={catalog} onModels={onModels} expanded /></div>}
    {dirty && invalidDefault && <p className="wb-warning" role="status">请为已显示的图片和视频模型明确选择可用的默认型号，或取消该类全部勾选。</p>}
    {notice && <p role="status" className={conflict ? 'wb-warning' : 'wb-help'}>{notice}</p>}
    {conflict && <button type="button" disabled={busy} onClick={() => void reload()}>重新读取已保存配置</button>}
    <footer className="wb-model-footer"><span aria-live="polite">{dirty ? '尚未保存' : '配置已保存'}</span><div><button type="button" disabled={busy || !dirty} onClick={cancel}>取消更改</button><button type="button" className="wb-primary" disabled={busy || !dirty || conflict || invalidDefault || !catalog?.displaySettings} onClick={() => void save()}>{busy ? '正在保存…' : '保存配置'}</button></div></footer>
  </div>;
}
