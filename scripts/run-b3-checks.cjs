'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'docs/implementation/b3-evidence');fs.mkdirSync(output,{recursive:true});
const frontend=path.join(root,'frontend');
const checks={
  backend:{command:process.execPath,args:['--test','backend/test/workbench-b3.test.js','backend/test/workbench-connections.test.js','backend/test/workbench-connections-http.test.js','backend/test/workbench-storage.test.js','backend/test/workbench-storage-http.test.js','backend/test/desktop-boundary.test.js','backend/test/workbench-downloads.test.js'],cwd:root},
  frontend:{command:process.execPath,args:['node_modules/vitest/vitest.mjs','run','src/components/workbench/__tests__/workbench-b3.test.tsx','src/lib/__tests__/workbench-task-client.test.ts'],cwd:frontend},
  lint:{command:process.execPath,args:['node_modules/eslint/bin/eslint.js','src/components/workspace/WorkspaceShell.tsx','src/components/workbench','src/hooks/useWorkbenchDrafts.ts','src/lib/workbench-client.ts','src/lib/connection-client.ts','src/types/nova-desktop.d.ts','src/app/layout.tsx'],cwd:frontend},
  hostLint:{command:process.execPath,args:['backend/node_modules/eslint/bin/eslint.js','--config','scripts/eslint-b2.config.mjs','backend/connections/service.js','backend/storage/output-directories.js','backend/storage/store.js','backend/test/workbench-b3.test.js','desktop/ipc.cjs','desktop/main.cjs','desktop/preload.cjs','desktop/startup.cjs','scripts/electron-b3-test-entry.cjs','scripts/verify-desktop-b3.cjs','scripts/run-b3-checks.cjs'],cwd:root},
  tsc:{command:process.execPath,args:['node_modules/typescript/bin/tsc','--noEmit','--pretty','false'],cwd:frontend},
  build:{command:process.execPath,args:['node_modules/next/dist/bin/next','build','--webpack'],cwd:frontend},
};
const resultsFile=path.join(output,'command-results.json'),results=fs.existsSync(resultsFile)?JSON.parse(fs.readFileSync(resultsFile,'utf8')):[];
for(const name of process.argv.slice(2)){const check=checks[name];if(!check)throw Error('Unknown B3 check');const startedAt=new Date().toISOString(),result=spawnSync(check.command,check.args,{cwd:check.cwd,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});fs.writeFileSync(path.join(output,name+'.log'),(result.stdout||'')+(result.stderr||''));const record={name,...check,startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,error:result.error?.message||null};results.push(record);fs.writeFileSync(resultsFile,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(record));if(result.status!==0&&name!=='tsc'){process.exitCode=1;break;}}
