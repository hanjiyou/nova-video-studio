'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'docs/implementation/b5-evidence'),frontend=path.join(root,'frontend');fs.mkdirSync(output,{recursive:true});
const backendFiles=['workbench-b5-diagnostics','desktop-boundary','workbench-contracts','workbench-storage','workbench-storage-http','workbench-connections','workbench-connections-http','workbench-tasks','workbench-tasks-http','workbench-image-boundary','workbench-b1-adapters','workbench-b1-http','workbench-upstream-id','workbench-downloads','workbench-downloads-http','workbench-b3','workbench-b4','workbench-b4-physical-aliases'];
const checks={
 backend:{cwd:root,args:['--test',...backendFiles.map(name=>'backend/test/'+name+'.test.js')]},
 frontend:{cwd:frontend,args:['node_modules/vitest/vitest.mjs','run','src/components/workbench/__tests__/workbench-b3.test.tsx','src/components/workbench/__tests__/workbench-b4.test.tsx','src/components/workbench/__tests__/workbench-b5.test.tsx','src/lib/__tests__/workbench-task-client.test.ts','src/lib/__tests__/connection-client.test.ts']},
 lint:{cwd:frontend,args:['node_modules/eslint/bin/eslint.js','src/components/workbench','src/hooks/useWorkbenchDrafts.ts','src/hooks/useWorkbenchTasks.ts','src/hooks/useWorkbenchPanelHeight.ts','src/lib/workbench-client.ts','src/lib/workbench-generation.ts','src/lib/workbench-task-client.ts']},
 hostLint:{cwd:root,args:['backend/node_modules/eslint/bin/eslint.js','--config','scripts/eslint-b2.config.mjs','backend/storage/diagnostics.js','backend/storage/store.js','desktop/diagnostic-actions.cjs','desktop/ipc.cjs','desktop/preload.cjs','desktop/main.cjs','backend/test/workbench-b5-diagnostics.test.js','scripts/run-b5-checks.cjs','scripts/electron-b5-test-entry.cjs','scripts/verify-desktop-b5.cjs','scripts/verify-b5-acceptance.cjs']},
 diagnostics:{cwd:root,args:['--test','backend/test/workbench-b5-diagnostics.test.js']},
 contracts:{cwd:root,args:['--test','backend/test/workbench-contracts.test.js']},
 tsc:{cwd:frontend,args:['node_modules/typescript/bin/tsc','--noEmit','--incremental','false','--pretty','false']},
 build:{cwd:frontend,args:['node_modules/next/dist/bin/next','build','--webpack']},
};
const file=path.join(output,'command-results.json'),results=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
for(const name of process.argv.slice(2)){const check=checks[name];if(!check)throw Error('Unknown B5 check');const startedAt=new Date().toISOString(),result=spawnSync(process.execPath,check.args,{cwd:check.cwd,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});fs.writeFileSync(path.join(output,name+'.log'),(result.stdout||'')+(result.stderr||''));const record={name,command:process.execPath,...check,startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,error:result.error?.message||null};results.push(record);fs.writeFileSync(file,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(record));if(result.status!==0&&name!=='tsc'){process.exitCode=1;break;}}
