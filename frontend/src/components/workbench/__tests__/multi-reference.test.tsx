import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { DraftEditor } from '../DraftEditor';
import { WorkbenchLibrary } from '../WorkbenchLibrary';
import { generationPlan, generationEvidenceVerified, reusableDraft } from '@/lib/workbench-generation';
import { MAX_VIDEO_REFERENCE_ASSETS } from '@/lib/reference-policy';
import type { CapabilitySummary, ConnectionModels, ConnectionSummary } from '@/lib/connection-client';
import type { Draft, HistoryTask } from '@/lib/workbench-client';
import type { AssetSummary } from '@/lib/workbench-task-client';

const connection: ConnectionSummary = {connectionId:'connection',connectionVersionId:'version',displayName:'fixture',baseUrl:'https://newapi.opensosen.com/v1',provider:'opensosen',protocol:'openai',hasCredential:true,credentialState:'ready',validationState:'verified',lastCheckedAt:null,lastSuccessAt:null,modelsFetchedAt:null,errorCode:null,defaultImageModel:'gpt-image-2.5-flare',defaultVideoModel:'grok-imagine-video-1.5-6s',isDefault:true};
const asset = (index:number):AssetSummary => ({assetId:'asset-'+index,kind:'image',displayName:'fixture-'+index+'.png',mimeType:'image/png',byteLength:10,sha256:'fixture',availability:'available',validationState:'verified',previewUrl:'/fixture-'+index+'.png'});
const assets=Array.from({length:50},(_,index)=>asset(index));
const dual:CapabilitySummary={capabilityVersionId:'dual',provider:connection.provider,baseUrl:connection.baseUrl,protocol:'openai',model:connection.defaultVideoModel,mode:'video.dual_reference',parameters:{seconds:6,size:'1280x720',encoding:'multipart',inputReferenceName:'input_reference',referenceCount:2},evidenceLevel:'application_verified',evidenceVersion:'opensosen-application-evidence-2026-10-24-v1',evidence:{sourceIds:['existing-dual-fixture'],applicationVerified:true,referenceSemantics:'ordered_references'},isCurrent:true};
const multi:CapabilitySummary={...dual,capabilityVersionId:'multi',mode:'video.multi_reference',parameters:{seconds:6,size:'1280x720',encoding:'multipart',inputReferenceName:'input_reference',minimumReferences:3},evidenceLevel:'unverified',evidenceVersion:'opensosen-multi-reference-unverified-2026-10-24-v1',evidence:{sourceIds:[],applicationVerified:false,submissionPolicy:'explicit-user-action-unverified-multi-reference-v1',supplierMaximumReferences:null,referenceSemantics:'ordered_references'}};
const single:CapabilitySummary={...dual,capabilityVersionId:'single',mode:'video.single_reference',parameters:{...dual.parameters,referenceCount:1}};
const text:CapabilitySummary={...dual,capabilityVersionId:'text',mode:'video.text',parameters:{seconds:6,encoding:'multipart',referenceCount:0}};
const models:ConnectionModels={connectionVersionId:connection.connectionVersionId,modelsFetchedAt:null,models:[{model:connection.defaultVideoModel,visibility:'visible'}],capabilities:[dual,multi,single,text]};
const draft:Draft={mode:'video.dual_reference',model:connection.defaultVideoModel,prompt:'保留有序参考',parameters:{},inputAssets:assets.slice(0,3),revision:1,updatedAt:null};
const history=(index:number):HistoryTask=>({id:'task-'+index,localTaskId:'task-'+index,mode:'image.text',status:'completed',createdAt:'2026-10-24T00:00:00Z',completedAt:'2026-10-24T00:00:08Z',expiresAt:null,prompt:'作品 '+index,model:connection.defaultImageModel,parameters:{},inputAssets:[],outputAssets:[assets[index]]});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();delete window.novaDesktop;});
function Editor({initial=draft,changed=vi.fn(),submit=vi.fn()}:{initial?:Draft;changed?:(patch:Partial<Draft>)=>void;submit?:()=>void}) {const [value,setValue]=useState(initial);return <DraftEditor draft={value} connection={connection} models={models} saving={false} onChange={patch=>{changed(patch);setValue({...value,...patch});}} onConfigure={vi.fn()} onRetry={vi.fn()} onReload={vi.fn()} onSubmit={submit}/>;}

it('two references keep verified dual; 3..7 use only the exact unverified scope and retain every input',()=>{
  expect(generationPlan({...draft,inputAssets:assets.slice(0,2)},connection,models).capability).toBe(dual);
  for(const count of [3,5,MAX_VIDEO_REFERENCE_ASSETS]) {const value={...draft,inputAssets:assets.slice(0,count)},plan=generationPlan(value,connection,models);expect(plan.mode).toBe('video.multi_reference');expect(plan.capability).toBe(multi);expect(plan.unverifiedMulti).toBe(true);expect(plan.blocked).toBe('');expect(generationEvidenceVerified(plan.capability)).toBe(false);expect(value.inputAssets).toHaveLength(count);}
  expect(generationPlan({...draft,inputAssets:assets.slice(0,8)},connection,models).blocked).toMatch(/最多 7 张/);
  for(const c of [{...connection,provider:'openai-compatible'},{...connection,baseUrl:'https://other.invalid/v1'},{...connection,protocol:'other'}])expect(generationPlan(draft,c,models).blocked).not.toBe('');
  for(const cap of [{...multi,evidenceVersion:'unknown'},{...multi,evidence:{...multi.evidence,applicationVerified:true}},{...multi,parameters:{...multi.parameters,maximumReferences:7}}])expect(generationPlan(draft,connection,{...models,capabilities:[cap]}).blocked).not.toBe('');
  expect(generationPlan({...draft,mode:'video.single_reference'},connection,models).blocked).toMatch(/需要 1 张/);
  expect(generationPlan({...draft,mode:'video.text'},connection,models).blocked).toMatch(/需要 0 张/);
  const reused=reusableDraft({...history(0),mode:'video.multi_reference',inputAssets:assets.slice(0,8)});expect(reused.inputAssets).toEqual(assets.slice(0,8));expect(reused.inputAssets).not.toBe(assets);
});

it('ordinary submit remains enabled with an honest warning; drag, keyboard and removal preserve displayed order',()=>{
  const changed=vi.fn(),submit=vi.fn(),view=render(<Editor changed={changed} submit={submit}/>);
  expect(screen.getByText(/三张及以上有序参考尚未真实实测/)).toBeInTheDocument();expect(screen.queryByText(/已通过本应用真实生成/)).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'生成视频'})).toBeEnabled();expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'生成视频'}));expect(submit).toHaveBeenCalledOnce();
  fireEvent.drop(view.container.querySelectorAll('.wb-reference')[0],{dataTransfer:{getData:()=> '2',files:[]}});expect(changed.mock.lastCall?.[0].inputAssets).toEqual([assets[2],assets[0],assets[1]]);
  fireEvent.click(screen.getByRole('button',{name:'参考图 2 前移'}));expect(changed.mock.lastCall?.[0].inputAssets).toEqual([assets[0],assets[2],assets[1]]);
  fireEvent.click(screen.getByRole('button',{name:'移除参考图 3'}));expect(changed.mock.lastCall?.[0].inputAssets).toEqual([assets[0],assets[2]]);expect(screen.getByText(/已通过本应用真实生成/)).toBeInTheDocument();expect(screen.queryByText(/三张及以上有序参考尚未真实实测/)).not.toBeInTheDocument();
});

it('batch import preserves all four original File objects and order; over-budget selection performs no imports or truncation',async()=>{
  const files=Array.from({length:4},(_,index)=>new File(['original-'+index],'same-name.png',{type:'image/png'})),changed=vi.fn(),imports:File[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_route:string,init?:RequestInit)=>{imports.push(init?.body as File);return Response.json({asset:assets[imports.length-1]});}));
  const view=render(<Editor initial={{...draft,inputAssets:[]}} changed={changed}/>);const input=view.container.querySelector('input[type="file"]')!;expect(input).toHaveAttribute('multiple');fireEvent.change(input,{target:{files}});await waitFor(()=>expect(changed).toHaveBeenCalledOnce());expect(imports).toEqual(files);expect(imports.every((file,index)=>file===files[index])).toBe(true);expect(changed.mock.lastCall?.[0].inputAssets).toEqual(assets.slice(0,4));
  fireEvent.change(input,{target:{files:Array.from({length:MAX_VIDEO_REFERENCE_ASSETS-3},()=>files[0])}});await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent('未导入或移除任何图片');expect(imports).toHaveLength(4);expect(changed).toHaveBeenCalledOnce();expect(view.container.querySelectorAll('.wb-reference')).toHaveLength(4);
});

it('library keeps ordered selections across pages and supports moving or removing off-page images without generation',async()=>{
  const requests:Array<{route:string;method?:string}>=[],video=vi.fn(),rows=assets.map((_,index)=>history(index));vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{requests.push({route,method:init?.method});const url=new URL(route,'http://local'),offset=Number(url.searchParams.get('offset'));return Response.json({items:rows.slice(offset,offset+24),total:rows.length,unfilteredTotal:rows.length});}));
  render(<WorkbenchLibrary revision={0} onDetails={vi.fn()} onVideo={video} onImage={vi.fn()}/>);await screen.findByText('作品 0');fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('作品 24');fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);
  fireEvent.click(screen.getByRole('button',{name:'已选图片 3 前移'}));fireEvent.click(screen.getByRole('button',{name:'移除已选图片 4'}));expect(screen.getByRole('list',{name:'已选图片顺序'}).children).toHaveLength(3);fireEvent.click(screen.getByRole('button',{name:'带入多图参考草稿'}));expect(video).toHaveBeenCalledWith([assets[0],assets[24],assets[1]]);for(let i=0;i<4;i++)fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);expect(screen.getByRole('list',{name:'已选图片顺序'}).children).toHaveLength(7);expect(screen.getAllByRole('button',{name:'选择图片'})[0]).toBeDisabled();fireEvent.click(screen.getAllByRole('button',{name:'选择图片'})[0]);expect(screen.getByRole('list',{name:'已选图片顺序'}).children).toHaveLength(7);fireEvent.click(screen.getByRole('button',{name:'带入多图参考草稿'}));expect(video.mock.lastCall?.[0]).toHaveLength(7);expect(requests.every(call=>call.route.startsWith('/api/nova/storage/tasks?')&&(!call.method||call.method==='GET'))).toBe(true);
});