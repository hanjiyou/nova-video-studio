import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {DraftEditor} from '../DraftEditor';
import {generationPlan} from '@/lib/workbench-generation';
import {videoPrice,videoRule,type VideoRule} from '@/lib/workbench-model-catalog';
import type {ConnectionModels,ConnectionSummary,CapabilitySummary} from '@/lib/connection-client';
import type {Draft} from '@/lib/workbench-client';
import rules from '../../../../../backend/connections/model-rules.json';
const model='fixture-video-browser';
const connection:ConnectionSummary={connectionId:'connection',connectionVersionId:'version',displayName:'fixture',baseUrl:rules.baseUrl,provider:rules.provider,protocol:'openai',hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:'',defaultVideoModel:model,isDefault:true};
const rule:VideoRule={profile:'openai-video-multipart-v1',modes:['video.text','video.multi_reference'],referenceLimits:{'video.text':{min:0,max:0},'video.multi_reference':{min:3,max:4}},minSeconds:2,maxSeconds:9,defaultSeconds:4,sendSize:false,sizes:[],defaultSize:null,centsPerSecond:null,submissionEnabled:true};
const capability:CapabilitySummary={capabilityVersionId:'capability',provider:connection.provider,baseUrl:connection.baseUrl,protocol:'openai',model,mode:'video.text',parameters:rule,evidenceLevel:'unverified',evidenceVersion:rules.version,evidence:{sourceIds:[],applicationVerified:false,configuredProtocol:rule.profile}};
const catalog:ConnectionModels={connectionVersionId:'version',modelsFetchedAt:'2026-11-02',models:[{model,visibility:'visible',categories:['video'],submissionEnabled:true}],capabilities:[capability],videoRules:{[model]:rule},videoRuleVersion:rules.version};
const draft:Draft={mode:'video.text',model,prompt:'Synthetic scene',parameters:{},inputAssets:[],revision:1,updatedAt:null};
afterEach(cleanup);
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
