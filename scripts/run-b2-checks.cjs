'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'docs/implementation/b2-evidence');fs.mkdirSync(output,{recursive:true});
const checks={
    backend:{command:process.execPath,args:['--test'],cwd:path.join(root,'backend')},
    targeted:{command:process.execPath,args:['--test','backend/test/workbench-downloads.test.js','backend/test/workbench-downloads-http.test.js','backend/test/workbench-tasks.test.js','backend/test/workbench-storage.test.js','backend/test/workbench-storage-http.test.js','backend/test/workbench-b1-http.test.js','backend/test/workbench-contracts.test.js'],cwd:root},
    lint:{command:process.execPath,args:[path.join(root,'backend/node_modules/eslint/bin/eslint.js'),'--config','scripts/eslint-b2.config.mjs',
        'backend/server.js','backend/storage/download-errors.js','backend/storage/output-directories.js','backend/storage/media-validator.js','backend/storage/download-worker.js','backend/storage/migrations.js','backend/storage/store.js','backend/storage/http.js','backend/tasks/service.js','backend/test/workbench-downloads.test.js','backend/test/workbench-downloads-http.test.js','backend/test/workbench-b1-http.test.js','backend/test/workbench-tasks-http.test.js','backend/test/workbench-storage-http.test.js','backend/test/workbench-tasks.test.js','backend/test/support/desktop-http-runtime.cjs','desktop/asset-actions.cjs','desktop/ipc.cjs','desktop/main.cjs','desktop/preload.cjs','scripts/electron-b2-test-entry.cjs','scripts/verify-desktop-b2.cjs','scripts/verify-desktop-b2-package.cjs','scripts/verify-b2-package-audit.cjs','scripts/verify-ffmpeg-before-pack.cjs','scripts/verify-b2-windows-file-lock.cjs','scripts/run-b2-checks.cjs'],cwd:root},
    build:{command:process.execPath,args:[path.join(root,'frontend/node_modules/next/dist/bin/next'),'build','--webpack'],cwd:path.join(root,'frontend')},
    package:{command:process.execPath,args:[path.join(root,'node_modules/electron-builder/out/cli/cli.js'),'--dir','--win','--x64','--config','electron-builder.yml','-c.directories.output=release-b2','-c.electronDist=node_modules/electron/dist'],cwd:root},
};
const resultsFile=path.join(output,'command-results.json'),results=fs.existsSync(resultsFile)?JSON.parse(fs.readFileSync(resultsFile,'utf8')):[];
for(const name of process.argv.slice(2)){
    const check=checks[name];if(!check)throw new Error('Unknown B2 check');const startedAt=new Date().toISOString(),result=spawnSync(check.command,check.args,{cwd:check.cwd,env:process.env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
    fs.writeFileSync(path.join(output,name+'.log'),(result.stdout||'')+(result.stderr||''));results.push({name,...check,startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,error:result.error?.message||null});fs.writeFileSync(resultsFile,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results.at(-1)));if(result.status!==0){process.exitCode=1;break;}
}
