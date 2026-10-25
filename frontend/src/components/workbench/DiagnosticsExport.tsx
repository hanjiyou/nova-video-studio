'use client';
import { useRef, useState } from 'react';
export function DiagnosticsExport() {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');const pending=useRef(false);
  async function run() {
    if(pending.current)return;pending.current=true;setBusy(true);setNotice('');
    try {const result=await window.novaDesktop?.exportDiagnostics();if(!result?.ok){setNotice(result?.code==='DIAGNOSTIC_TARGET_PROTECTED'?'请选择应用数据和作品目录之外的位置。':'诊断导出失败，请检查保存位置、可用空间或文件占用后重试。');return;}setNotice(result.cancelled?'已取消导出。':`诊断已保存，包含 ${result.exportedTasks || 0} 条任务摘要。${result.omittedTasks ? `另有 ${result.omittedTasks} 条较早记录未包含。` : ''}`);}
    catch {setNotice('诊断导出失败，请稍后重试。');}finally{pending.current=false;setBusy(false);}
  }
  return <section className="wb-panel"><h2>诊断与支持</h2><p className="wb-help">导出应用版本、最近 1000 条任务的脱敏参数、状态、阶段耗时与受限时间线、错误分类和素材摘要。包含已移除任务展示或从作品库隐藏的记录；不会发送到网络。</p><p className="wb-help">不包含提示词原文、API Key、密文、服务或签名网址、原始响应、原图编码及磁盘路径。请将 JSON 文件保存在应用数据和作品目录之外。</p><button type="button" disabled={busy} onClick={() => void run()}>{busy?'正在导出…':'导出脱敏诊断'}</button>{notice&&<p className="wb-help" role="status">{notice}</p>}</section>;
}
