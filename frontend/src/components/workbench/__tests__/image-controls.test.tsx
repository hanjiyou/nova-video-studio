import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { DraftEditor } from '../DraftEditor';
import { AssetActions } from '../WorkbenchResults';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { WorkbenchShell } from '../WorkbenchShell';
import { DRAFT_MODES } from '@/lib/workbench-client';
import { useWorkbenchTasks } from '@/hooks/useWorkbenchTasks';
import { generationPlan, generationEvidenceVerified } from '@/lib/workbench-generation';
import type { CapabilitySummary, ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { Draft, HistoryTask, SubmissionIntent } from '@/lib/workbench-client';
import type { AssetSummary, WorkbenchTaskInput } from '@/lib/workbench-task-client';
import policy from '../../../../../backend/tasks/image-policy.json';
const connection: ConnectionSummary = {connectionId:'11111111-1111-4111-8111-111111111111',connectionVersionId:'22222222-2222-4222-8222-222222222222',displayName:'fixture',baseUrl:policy.baseUrl,provider:policy.provider,protocol:policy.protocol,hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:policy.model,defaultVideoModel:'grok-imagine-video-1.5-6s',isDefault:true};
const asset: AssetSummary = {assetId:'44444444-4444-4444-8444-444444444444',kind:'image',displayName:'original.png',mimeType:'image/png',byteLength:120,sha256:'fixture',availability:'available',validationState:'verified',previewUrl:'/original.png'};
const minimum: CapabilitySummary = {capabilityVersionId:'33333333-3333-4333-8333-333333333333',provider:policy.provider,baseUrl:policy.baseUrl,protocol:policy.protocol,model:policy.model,mode:'image.text',parameters:{},evidenceLevel:'application_verified',evidenceVersion:'existing-verified',evidence:{sourceIds:['existing-test'],applicationVerified:true},isCurrent:true};
const specs: CapabilitySummary = {...minimum,capabilityVersionId:'55555555-5555-4555-8555-555555555555',parameters:{sizes:policy.sizes,qualities:policy.qualities,encoding:'json',referenceCount:0},evidenceLevel:'unverified',evidenceVersion:policy.evidenceVersion,evidence:{sourceIds:[],applicationVerified:false,submissionPolicy:policy.submissionPolicy},isCurrent:false};
const edit: CapabilitySummary = {...specs,capabilityVersionId:'66666666-6666-4666-8666-666666666666',mode:'image.reference',parameters:{...specs.parameters,encoding:'multipart',referenceCount:1,inputReferenceName:'image'},isCurrent:true};
const models: ConnectionModels = {connectionVersionId:connection.connectionVersionId,modelsFetchedAt:null,models:[{model:policy.model,visibility:'visible'}],capabilities:[minimum,specs,edit]};
const draft: Draft = {mode:'image.text',model:policy.model,prompt:'用原图编辑中文\n完整描述',parameters:{},inputAssets:[],revision:1,updatedAt:null};
const task: HistoryTask = {id:'77777777-7777-4777-8777-777777777777',localTaskId:'77777777-7777-4777-8777-777777777777',mode:'image.reference',status:'completed',createdAt:'2026-10-24T00:00:00Z',completedAt:'2026-10-24T00:00:08Z',expiresAt:null,prompt:draft.prompt,model:policy.model,parameters:{quality:'max'},inputAssets:[asset],outputAssets:[asset]};
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete window.novaDesktop;});
function Editor({initial=draft,changed=vi.fn(),submit=vi.fn()}:{initial?:Draft;changed?:(patch:Partial<Draft>)=>void;submit?:()=>void}) { const [value,setValue]=useState(initial),plan=generationPlan(value,connection,models);return <><DraftEditor draft={value} connection={connection} models={models} saving={false} onChange={patch=>{changed(patch);setValue({...value,...patch});}} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()} onSubmit={submit}/><output data-testid="capability">{plan.capability?.capabilityVersionId}</output></>; }

it('default selects proven minimum while displaying separate specs; explicit controls and clearing back to auto use the correct immutable capability',()=>{
  const changed=vi.fn(),submit=vi.fn();render(<Editor changed={changed} submit={submit}/>);
  expect(screen.getByTestId('capability')).toHaveTextContent(minimum.capabilityVersionId);expect(screen.getByLabelText('图片尺寸')).toBeEnabled();expect(screen.getByRole('button',{name:'生成图片'})).toBeEnabled();
  expect(screen.getByLabelText('图片质量').querySelectorAll('option')).toHaveLength(6);expect(screen.getByText(/横版 3:2/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'横版'}));expect(screen.getByLabelText('图片尺寸')).toHaveValue('1536x1024');expect(screen.getByTestId('capability')).toHaveTextContent(specs.capabilityVersionId);expect(screen.getByText(/^图片规格与参考图编辑尚未在当前中转实测/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('图片尺寸'),{target:{value:'1024x1536'}});expect(screen.getByRole('button',{name:'竖版'})).toHaveAttribute('aria-pressed','true');
  fireEvent.change(screen.getByLabelText('图片质量'),{target:{value:'max'}});expect(changed).toHaveBeenLastCalledWith({parameters:{size:'1024x1536',quality:'max'}});
  fireEvent.change(screen.getByLabelText('图片尺寸'),{target:{value:''}});expect(screen.getByTestId('capability')).toHaveTextContent(specs.capabilityVersionId);
  fireEvent.change(screen.getByLabelText('图片质量'),{target:{value:''}});expect(changed).toHaveBeenLastCalledWith({parameters:{}});expect(screen.getByTestId('capability')).toHaveTextContent(minimum.capabilityVersionId);expect(screen.queryByText(/^图片规格与参考图编辑尚未在当前中转实测/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'生成图片'}));expect(submit).toHaveBeenCalledOnce();
});

it('single-reference editing keeps the original File body and params; remove returns to explicit text scope without changing model or specs',async()=>{
  const file=new File(['original raw bytes'],'source.png',{type:'image/png'}),changed=vi.fn(),imports:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_route:string,init?:RequestInit)=>{imports.push(init?.body);return Response.json({asset});}));
  const view=render(<Editor initial={{...draft,parameters:{quality:'high'}}} changed={changed}/>),input=view.container.querySelector('input[type="file"]')!;
  expect(input).not.toHaveAttribute('multiple');fireEvent.change(input,{target:{files:[file]}});await waitFor(()=>expect(screen.getByTestId('capability')).toHaveTextContent(edit.capabilityVersionId));
  expect(imports).toEqual([file]);expect(imports[0]).toBe(file);expect(screen.getByRole('button',{name:'生成图片'})).toBeEnabled();expect(screen.getByText(/添加图片后，描述你想修改的内容/)).toBeInTheDocument();expect(generationEvidenceVerified(edit)).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'移除参考图 1'}));expect(screen.getByTestId('capability')).toHaveTextContent(specs.capabilityVersionId);expect(screen.getByLabelText('生成模型')).toHaveValue(policy.model);expect(screen.getByLabelText('图片质量')).toHaveValue('high');
});

it('unsupported saved specs, multiple references and stale/mismatched policies are preserved and blocked',()=>{
  const value={...draft,parameters:{size:'2048x2048',quality:'high'}};render(<Editor initial={value}/>);expect(screen.getByLabelText('图片尺寸')).toHaveValue('2048x2048');expect(screen.getByLabelText('图片质量')).toHaveValue('high');expect(screen.getByRole('button',{name:'生成图片'})).toBeDisabled();expect(value.parameters).toEqual({size:'2048x2048',quality:'high'});
  expect(generationPlan({...draft,inputAssets:[asset,{...asset,assetId:'other'}]},connection,models).blocked).toContain('1 张');
  const reference={...draft,inputAssets:[asset]};for(const changed of [{...connection,provider:'openai-compatible'},{...connection,baseUrl:'https://other.invalid/v1'},{...connection,protocol:'other'}])expect(generationPlan(reference,changed,models).blocked).not.toBe('');
  for(const cap of [{...edit,evidenceVersion:'other'},{...edit,parameters:{...edit.parameters,inputReferenceName:'image[]'}},{...edit,evidence:{...edit.evidence,applicationVerified:true}}])expect(generationPlan(reference,connection,{...models,capabilities:[cap]}).blocked).not.toBe('');
  expect(generationPlan(reference,connection,{...models,connectionVersionId:'stale'}).blocked).not.toBe('');expect(generationPlan({...draft,model:'gpt-image-2.5-sunburst',parameters:{quality:'high'}},connection,models).model).toBe('gpt-image-2.5-sunburst');
});

it('normal image submission freezes edit capability, exact controls and original asset ID once',async()=>{
  const calls:Array<{route:string;body:unknown}>=[];let intents:SubmissionIntent[]=[];
  vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({route,body});
    if(route.startsWith('/api/nova/storage/tasks?'))return Response.json({items:[task],total:1});if(route==='/api/nova/storage/tasks/'+task.localTaskId)return Response.json({task});
    if(route==='/api/nova/storage/submissions'&&init?.method==='POST'){intents=[{input:body,localRequestId:body.localRequestId,createdAt:'now',attemptStartedAt:null,taskId:null}];return Response.json({input:body});}
    if(route==='/api/nova/storage/submissions')return Response.json({items:intents});if(route.endsWith('/attempt'))return Response.json({marked:true});if(route==='/api/nova/workbench/tasks'){intents[0].taskId=task.localTaskId;return Response.json({taskId:task.localTaskId});}if(init?.method==='DELETE'){intents=[];return Response.json({dismissed:true});}throw Error(route);
  }));
  const hook=renderHook(()=>useWorkbenchTasks(true,'image',connection,models));await waitFor(()=>expect(hook.result.current.reconciliationReady).toBe(true));const value={...draft,inputAssets:[asset],parameters:{size:'1024x1024',quality:'max'}};
  await act(async()=>{await Promise.all([hook.result.current.submit(value),hook.result.current.submit(value)]);});await act(async()=>hook.result.current.submit(value));
  const creates=calls.filter(c=>c.route==='/api/nova/workbench/tasks');expect(creates).toHaveLength(1);const body=creates[0].body as WorkbenchTaskInput;expect(body).toMatchObject({capabilityVersionId:edit.capabilityVersionId,mode:'image.reference',model:policy.model,prompt:draft.prompt,parameters:value.parameters,inputAssets:[{assetId:asset.assetId,position:0,role:'reference'}]});
});

it('preview and library bring only one selected original image into an edit draft',async()=>{
  const useImage=vi.fn(),view=render(<AssetActions asset={asset} onImageReference={useImage}/>);fireEvent.click(screen.getByRole('button',{name:'作为参考图编辑'}));expect(useImage).toHaveBeenCalledWith(asset);view.unmount();
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({items:[task,{...task,localTaskId:'other',outputAssets:[{...asset,assetId:'other'}]}],total:2})));
  render(<WorkbenchLibrary revision={0} onDetails={vi.fn()} onVideo={vi.fn()} onImage={vi.fn()} onImageReference={useImage}/>);await screen.findAllByRole('button',{name:'选择图片'});const action=screen.getByRole('button',{name:'带入图片编辑草稿'});expect(action).toBeDisabled();
  fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);expect(action).toBeEnabled();fireEvent.click(action);expect(useImage).toHaveBeenLastCalledWith(asset);fireEvent.click(screen.getByRole('button',{name:'选择图片'}));expect(action).toBeDisabled();expect(useImage).toHaveBeenCalledTimes(2);
});

it('result-to-edit shell flow checks the original asset, updates the image draft and performs no generation',async()=>{
  vi.spyOn(window,'scrollTo').mockImplementation(()=>{});const calls:Array<{route:string;method:string}>=[];
  const records=new Map<string,Draft>(DRAFT_MODES.map(mode=>[mode,{...draft,mode,inputAssets:[],parameters:{}}]));
  vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{calls.push({route,method:init?.method||'GET'});
    if(route==='/api/nova/connections/current')return Response.json({connection});
    if(route.startsWith('/api/nova/connections/'))return Response.json(models);
    if(route.startsWith('/api/nova/storage/settings/'))return Response.json({setting:{key:route.split('/').pop(),value:null,revision:0,updatedAt:null}});
    if(route.startsWith('/api/nova/storage/drafts/')){const mode=route.split('/').pop()!;if(init?.method==='PUT'){const body=JSON.parse(String(init.body));records.set(mode,{...records.get(mode)!,...body,inputAssets:body.inputAssets.map(()=>asset),revision:body.expectedRevision+1});}return Response.json({draft:records.get(mode)});}
    if(route==='/api/nova/storage/submissions')return Response.json({items:[]});
    if(route.startsWith('/api/nova/storage/tasks?'))return Response.json({items:[task],total:1});
    if(route==='/api/nova/assets/'+asset.assetId)return Response.json({asset});
    throw Error('Unexpected route '+route);
  }));
  render(<WorkbenchShell/>);fireEvent.click(await screen.findByRole('button',{name:'作为参考图编辑'}));expect(await screen.findByRole('dialog',{name:'将内容带入草稿'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'确认带入草稿'}));await waitFor(()=>expect(screen.getByAltText('参考图 1：'+asset.displayName)).toBeInTheDocument());await waitFor(()=>expect(records.get('image.text')?.inputAssets).toEqual([asset]));
  expect(screen.getByLabelText('画面描述')).toHaveValue(draft.prompt);expect(screen.getByLabelText('生成模型')).toHaveValue(policy.model);expect(calls.some(c=>c.route==='/api/nova/assets/'+asset.assetId)).toBe(true);expect(calls.some(c=>c.method==='POST')).toBe(false);
});
