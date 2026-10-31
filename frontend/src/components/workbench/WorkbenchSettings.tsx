'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ConnectionForm } from './ConnectionForm';
import { ModelDisplaySettings } from './ModelDisplaySettings';
import { OutputDirectorySettings } from './DefaultSettings';
import type { ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
const tabs = [['general','通用'],['connection','连接与模型'],['storage','存储'],['about','关于']] as const;
export function WorkbenchSettings({connection,models,onSaved,onModels,general,about,locateAbout=false}:{connection:ConnectionSummary|null;models:ConnectionModels|null;onSaved:(connection:ConnectionSummary)=>void;onModels:(models:ConnectionModels)=>void;general:ReactNode;about:ReactNode;locateAbout?:boolean}) {
  const [tab,setTab]=useState<string>('connection');
  useEffect(()=>{if(locateAbout)setTab('about');},[locateAbout]);
  return <section className="wb-settings-surface"><nav className="wb-settings-tabs" role="tablist" aria-label="设置分类">{tabs.map(([key,label])=><button key={key} type="button" role="tab" id={'settings-tab-'+key} aria-controls={'settings-panel-'+key} aria-selected={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</nav>
    {tabs.map(([key])=><div key={key} id={'settings-panel-'+key} role="tabpanel" aria-labelledby={'settings-tab-'+key} hidden={tab!==key} className="wb-settings-tabpanel">
      {key==='general'?general:key==='connection'?<>{connection&&<ModelDisplaySettings connection={connection} models={models} onModels={onModels} onSaved={onSaved}/>}<details className="wb-connection-editor" open={!connection || undefined}><summary>{connection?'编辑连接':'配置生成服务'}</summary><ConnectionForm key={connection?.connectionId||'new'} connection={connection} onSaved={onSaved} onModels={onModels}/></details></>:key==='storage'?<OutputDirectorySettings/>:about}
    </div>)}
  </section>;
}
