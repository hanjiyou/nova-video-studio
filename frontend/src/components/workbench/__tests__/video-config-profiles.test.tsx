import {useState} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DraftEditor} from '../DraftEditor';
import {generationPlan} from '@/lib/workbench-generation';
import {videoPrice,videoRule,videoDefaults,type VideoRule} from '@/lib/workbench-model-catalog';
import type {ConnectionModels,ConnectionSummary,CapabilitySummary} from '@/lib/connection-client';
import type {Draft} from '@/lib/workbench-client';
import rules from '../../../../../backend/connections/model-rules.json';
const model='fixture-video-browser';
const connection:ConnectionSummary={connectionId:'connection',connectionVersionId:'version',displayName:'fixture',baseUrl:rules.baseUrl,provider:rules.provider,protocol:'openai',hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:'',defaultVideoModel:model,isDefault:true};
const rule:VideoRule={profile:'openai-video-multipart-v1',modes:['video.text','video.multi_reference'],referenceLimits:{'video.text':{min:0,max:0},'video.multi_reference':{min:3,max:4}},minSeconds:2,maxSeconds:9,defaultSeconds:4,sendSize:false,sizes:[],defaultSize:null,centsPerSecond:null,submissionEnabled:true};
const capability:CapabilitySummary={capabilityVersionId:'capability',provider:connection.provider,baseUrl:connection.baseUrl,protocol:'openai',model,mode:'video.text',parameters:rule,evidenceLevel:'unverified',evidenceVersion:rules.version,evidence:{sourceIds:[],applicationVerified:false,configuredProtocol:rule.profile}};
const catalog:ConnectionModels={connectionVersionId:'version',modelsFetchedAt:'2026-11-02',models:[{model,visibility:'visible',categories:['video'],submissionEnabled:true}],capabilities:[capability],videoRules:{[model]:rule},videoRuleVersion:rules.version};
const draft:Draft={mode:'video.text',model,prompt:'Synthetic scene',parameters:{},inputAssets:[],revision:1,updatedAt:null};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function editor(models:ConnectionModels=catalog,value:Draft=draft){render(<DraftEditor draft={value} connection={connection} models={models} saving={false} onChange={()=>{}} onConfigure={()=>{}} onRetry={()=>{}} onReload={()=>{}} onSubmit={()=>{}}/>);}

it('an unseen model uses returned capability/defaults and can submit without a successful-generation record or a known price',()=>{
  editor();expect(screen.getByRole('button',{name:'生成视频'})).toBeEnabled();expect(screen.getByRole('spinbutton',{name:'视频时长（秒）'})).toHaveValue(4);
  expect(screen.getByText('暂无法估算')).toBeInTheDocument();expect(videoPrice(rule,4)).toBeNull();
  expect(generationPlan(draft,connection,catalog).parameters).toEqual({seconds:4});
  expect(screen.getByRole('button',{name:'已设为默认'})).toBeDisabled();
});
it('only changing configured open state or limits changes the button, with no model-name branch',()=>{
  const disabled={...catalog,videoRules:{[model]:{...rule,submissionEnabled:false}}};
  expect(generationPlan(draft,connection,disabled).issues.some(issue=>issue.code==='capability')).toBe(true);
  expect(generationPlan({...draft,parameters:{seconds:10}},connection,catalog).issues.some(issue=>issue.code==='video-parameters')).toBe(true);
  const unsupported=generationPlan({...draft,mode:'video.single_reference'},connection,catalog);expect(unsupported.issues.some(issue=>issue.code==='video-mode')).toBe(true);
  expect(videoRule(model,connection,catalog)).toEqual(rule);expect(videoRule(model,{...connection,connectionVersionId:'different'},catalog)).toBeNull();
});
it('missing configured protocol does not fabricate duration/size or grant generation from model visibility',()=>{
  const missing={...catalog,capabilities:[],videoRules:{}};
  const plan=generationPlan(draft,connection,missing);expect(plan.parameters).toEqual({});expect(plan.issues.some(issue=>issue.code==='video-configuration')).toBe(true);
  editor(missing);expect(screen.getByRole('button',{name:'生成视频'})).toBeDisabled();
});
it('unknown pricing does not prevent saving an otherwise valid default duration',()=>{
  editor(catalog,{...draft,parameters:{seconds:5}});expect(screen.getByRole('button',{name:'设为默认'})).toBeEnabled();
  expect(screen.getByRole('button',{name:'生成视频'})).toBeEnabled();
});

function inheritedCatalog():ConnectionModels {
  const inherited:VideoRule={...rule,modes:['video.text'],referenceLimits:{'video.text':{min:0,max:0}},minSeconds:1,maxSeconds:null,defaultSeconds:2,sendSize:true,sizeOptional:true,sizes:['720x1280','1280x720'],defaultSize:null};
  return {...catalog,videoRuleVersion:'dynamic-server-version',capabilities:[{...capability,evidenceVersion:'dynamic-server-version',parameters:inherited,configurationCurrent:true}],videoRules:{[model]:inherited}};
}
it('dynamic host rule versions use unknown maximum duration without fabricating a size or price',()=>{
  const dynamic=inheritedCatalog(),inherited=dynamic.videoRules![model];
  editor(dynamic);const duration=screen.getByRole('spinbutton',{name:'视频时长（秒）'});
  expect(duration).toHaveValue(2);expect(duration).not.toHaveAttribute('max');
  expect(screen.getByText('请输入正整数秒；服务最大时长尚未公布。')).toBeInTheDocument();
  expect(screen.getByLabelText('视频画面尺寸')).toHaveValue('');expect(screen.queryByLabelText('宽度')).not.toBeInTheDocument();
  expect(generationPlan(draft,connection,dynamic).blocked).toBe('');expect(generationPlan(draft,connection,dynamic).parameters).toEqual({seconds:2});
  expect(videoDefaults(model,inherited,{...dynamic,modelSettings:{[model]:{defaultSeconds:300}}})).toEqual({seconds:300});
  expect(generationPlan({...draft,parameters:{seconds:300}},connection,dynamic).blocked).toBe('');
  for(const seconds of [0,-1,2.5,Number.MAX_SAFE_INTEGER+1])expect(generationPlan({...draft,parameters:{seconds}},connection,dynamic).issues.some(issue=>issue.code==='video-parameters')).toBe(true);
  expect(videoPrice({...inherited,centsPerSecond:7},300)).toBe('21.00');expect(videoPrice(inherited,300)).toBeNull();
});
it('optional size supports explicit portrait and custom values then omits size again without altering other inputs',()=>{
  const dynamic=inheritedCatalog();let persisted={...draft,prompt:'保留剧情'};
  function Editor(){const [value,setValue]=useState(persisted);return <DraftEditor draft={value} connection={connection} models={dynamic} saving={false} onChange={patch=>{persisted={...value,...patch};setValue(persisted);}} onConfigure={()=>{}} onRetry={()=>{}} onReload={()=>{}} onSubmit={()=>{}}/>;}
  render(<Editor/>);fireEvent.change(screen.getByLabelText('视频画面尺寸'),{target:{value:'720x1280'}});expect(persisted.parameters).toEqual({seconds:2,size:'720x1280'});
  fireEvent.change(screen.getByLabelText('视频画面尺寸'),{target:{value:'custom'}});expect(screen.getByRole('button',{name:'生成视频'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('宽度'),{target:{value:'1082'}});fireEvent.change(screen.getByLabelText('高度'),{target:{value:'1902'}});expect(persisted.parameters).toEqual({seconds:2,size:'1082x1902'});expect(screen.getByRole('button',{name:'生成视频'})).toBeEnabled();
  fireEvent.change(screen.getByLabelText('视频画面尺寸'),{target:{value:''}});expect(persisted.parameters).toEqual({seconds:2});expect(screen.queryByLabelText('宽度')).not.toBeInTheDocument();expect(screen.getByLabelText('剧情描述')).toHaveValue('保留剧情');
});
it('saving a valid default duration remains available when the supplier maximum and fee are unknown',async()=>{
  const dynamic=inheritedCatalog(),fetcher=vi.fn(async(_url:unknown,_init?:RequestInit)=>Response.json({...dynamic,modelSettings:{[model]:{defaultSeconds:300}}}));vi.stubGlobal('fetch',fetcher);
  editor(dynamic,{...draft,parameters:{seconds:300}});fireEvent.click(screen.getByRole('button',{name:'设为默认'}));
  await screen.findByText('已保存此型号的默认时长。');expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({model,defaultSeconds:300});
  await waitFor(()=>expect(screen.getByRole('button',{name:'已设为默认'})).toBeDisabled());
});
