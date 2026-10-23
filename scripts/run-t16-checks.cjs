'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs/implementation/t16-evidence'),checks={
 hostLint:{cwd:root,args:['backend/node_modules/eslint/bin/eslint.js','--config','scripts/eslint-b2.config.mjs','desktop/main.cjs','scripts/verify-desktop-t16.cjs','scripts/t16-payload-entry.cjs','scripts/verify-t16-package.cjs','scripts/verify-t16-acceptance.cjs','scripts/electron-t16-baseline-entry.cjs','scripts/run-t16-checks.cjs']},
 frontendLint:{cwd:path.join(root,'frontend'),args:['node_modules/eslint/bin/eslint.js','src/components/workbench/WorkbenchShell.tsx']},
 contracts:{cwd:root,args:['--test','backend/test/workbench-contracts.test.js']},
 ledger:{cwd:root,args:['scripts/verify-t16-acceptance.cjs']},
 priorLedger:{cwd:root,args:['scripts/verify-b5-acceptance.cjs']}
};
const recordsFile=path.join(out,'command-results.json'),records=fs.existsSync(recordsFile)?JSON.parse(fs.readFileSync(recordsFile,'utf8')):[];
for(const name of process.argv.slice(2)){const c=checks[name];if(!c)throw Error('Unknown T16 check');const startedAt=new Date().toISOString(),r=spawnSync(process.execPath,c.args,{cwd:c.cwd,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});fs.writeFileSync(path.join(out,name+'.log'),(r.stdout||'')+(r.stderr||''));records.push({name,executable:process.execPath,...c,startedAt,finishedAt:new Date().toISOString(),exitCode:r.status,error:r.error?.message||null});fs.writeFileSync(recordsFile,JSON.stringify(records,null,2)+'\n');console.log(JSON.stringify({name,exitCode:r.status}));if(r.status!==0){process.exitCode=1;break;}}
