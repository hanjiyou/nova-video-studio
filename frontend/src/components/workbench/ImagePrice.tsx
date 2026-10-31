'use client';
import { useEffect, useState } from 'react';
import { OPENSOSEN_ROUTE_BASES } from '@/lib/workbench-client';
import { getConnectionPricing, type ConnectionModels, type ConnectionPricing, type ConnectionSummary } from '@/lib/connection-client';
const format = (value:number) => Number(value.toPrecision(12)).toString();
const reasons:Record<string,string> = { MODEL_NOT_PRICED:'当前型号暂无报价。', BILLING_UNSUPPORTED:'当前计费规则暂不支持估算。', GROUP_PRICING_INVALID:'暂无所选分组报价。', PRICING_INVALID:'价格资料格式异常。', PRICING_GROUP_REQUIRED:'请在设置的连接与模型中选择图片参考价分组。' };
export function ImagePrice({connection,model,models=null}:{connection:ConnectionSummary|null;model:string;models?:ConnectionModels|null}) {
  const connectionId=connection?.connectionId,versionId=connection?.connectionVersionId,route=connection?.route,revision=connection?.routeRevision;
  const group=models?.displaySettings?.pricingGroup, displayRevision=models?.displaySettings?.revision;
  const supported=Boolean(connectionId && model && connection?.provider==='opensosen' && Object.values(OPENSOSEN_ROUTE_BASES).includes(connection.baseUrl) && connection.routeSupported===true && (route==='cn'||route==='com') && Number.isSafeInteger(revision) && Number(revision)>0);
  const key=JSON.stringify([connectionId,versionId,route,revision,model,group,displayRevision,models?.modelsFetchedAt,models?.refreshError]);
  const [state,setState]=useState<{key:string;loading:boolean;value?:ConnectionPricing}>({key:'',loading:true});
  useEffect(()=>{
    if(!supported || !connectionId || group===null)return;
    let ignore=false; const controller=new AbortController(); setState({key,loading:true});
    void getConnectionPricing(connectionId,controller.signal,model).then(value=>{
      if(ignore)return;
      if(value.stale || value.connectionVersionId!==versionId || value.route!==route || value.routeRevision!==revision || value.model!==model || group!==undefined && value.group!==group || displayRevision!==undefined && value.displayRevision!==displayRevision)setState({key,loading:false});
      else setState({key,loading:false,value});
    }).catch(()=>{if(!ignore)setState({key,loading:false});});
    return()=>{ignore=true;controller.abort();};
  },[connectionId,versionId,route,revision,model,group,displayRevision,supported,key,models]);
  const current=state.key===key?state:{key,loading:true};
  const loading=supported && group!==null && current.loading, estimate=supported && !loading && group!==null?current.value?.estimate:null;
  const amount=typeof estimate?.perImage==='number' && Number.isFinite(estimate.perImage) && estimate.perImage>=0?format(estimate.perImage):null;
  const reason=!connection?'配置连接后可读取价格。':group===null?reasons.PRICING_GROUP_REQUIRED:!supported?'当前连接暂不支持图片估价。':reasons[current.value?.reason||'']||'价格暂不可用，可刷新模型列表重试。';
  return <div className="wb-generation-price" aria-label="图片费用估算" aria-live="polite"><span>图片参考价</span><strong>{loading?'正在估算…':amount!==null?amount+'/张':'暂无法估算'}</strong>{amount!==null?<small>本次 1 张 · 参考费用 {amount}</small>:!loading&&<small>{reason}</small>}<small>按所选参考价分组估算，实际扣费以服务结算为准。</small></div>;
}
