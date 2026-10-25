'use strict';
// I08 static package verification; never starts Nova, the backend or networking.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),vm=require('node:vm'),asar=require('@electron/asar');
const {REPOSITORY,verifyDirectory,hashFile}=require('./lib/windows-update.cjs');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const extract=(archive,file)=>asar.extractFile(archive,path.normalize(file));
function declarations(source,imports=false){
 const module={exports:{}};
 vm.runInNewContext(source.toString('utf8'),{module,require(name){assert.ok(imports&&['node:fs','node:path','node:crypto','better-sqlite3'].includes(name));return Object.freeze({});}},{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
 return module.exports;
}
function files(root,relative=''){
 return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).flatMap(entry=>{
  const item=path.posix.join(relative,entry.name);assert.equal(entry.isSymbolicLink(),false);
  if(entry.isDirectory())return files(root,item);assert.ok(entry.isFile());return[item];
 });
}
async function main(argv){
 assert.equal(argv.length,2,'Usage: node scripts/verify-lifecycle-package.cjs <verified-B-directory> <new-evidence-json>');
 const directory=path.resolve(argv[0]),evidence=path.resolve(argv[1]);
 assert.equal(path.dirname(evidence),path.join(REPOSITORY,'docs/implementation/i08-evidence'));
 assert.match(path.basename(evidence),/^package-lifecycle[A-Za-z0-9.-]*\.json$/);assert.equal(fs.existsSync(evidence),false,'Evidence must be new');
 const {plan,summary}=await verifyDirectory(directory);assert.equal(plan.profile,'github-test');assert.equal(plan.version,'3.6.2');
 const archive=path.join(directory,'win-unpacked/resources/app.asar'),aDir=path.join(REPOSITORY,'release-updates/github-test/3.6.1');
 const {plan:aPlan}=await verifyDirectory(aDir),aArchive=path.join(aDir,'win-unpacked/resources/app.asar');
 const manifest=json(path.join(REPOSITORY,'docs/implementation/i05-i07-evidence/source-manifest.json'));assert.equal(manifest.files.length,23);
 const approvedSources=manifest.files.map(item=>{const actual=sha(fs.readFileSync(path.join(REPOSITORY,item.file)));assert.equal(actual,item.finalSha256,'Approved source drift: '+item.file);return{file:item.file,sha256:actual};});
 const productionFiles=['backend/server.js','backend/tasks/service.js','backend/tasks/lifecycle-contract.js','backend/tasks/execution-runtime.js','backend/tasks/diagnostic-timeline.js','backend/tasks/flare-image-adapter.js','backend/tasks/plugin-adapter.js','backend/storage/migrations.js','backend/storage/store.js','backend/storage/http.js','backend/storage/workbench-library.js','backend/storage/diagnostics.js','backend/storage/download-worker.js','desktop/main.cjs','desktop/runtime.cjs','desktop/update-identity.cjs','desktop/update-policy.cjs','desktop/update-service.cjs'].map(file=>{const data=extract(archive,file);assert.equal(Buffer.compare(data,fs.readFileSync(path.join(REPOSITORY,file))),0,'Packaged source drift: '+file);return{file,sha256:sha(data)};});
 const contract=declarations(extract(archive,'backend/tasks/lifecycle-contract.js')),defaults=JSON.parse(JSON.stringify(contract.DEFAULT_EXECUTION_SETTINGS)),limits=JSON.parse(JSON.stringify(contract.EXECUTION_LIMITS));
 assert.deepEqual(defaults,{imageConcurrency:3,videoConcurrency:3,imageTimeoutSeconds:120,videoTimeoutSeconds:300});
 assert.deepEqual(limits,{concurrency:{min:1,max:5},timeoutSeconds:{min:30,max:1800}});
 const migrationsOf=app=>Array.from(declarations(extract(app,'backend/storage/migrations.js'),true).MIGRATIONS,item=>({version:item.version,name:item.name,sqlSha256:sha(item.sql)}));
 const aMigrations=migrationsOf(aArchive),migrations=migrationsOf(archive);
 assert.deepEqual(aMigrations.map(item=>item.version),[1,2,3,4,5,6]);assert.deepEqual(migrations.slice(0,6),aMigrations,'Released A migrations changed');
 assert.deepEqual(migrations.slice(6).map(({version,name})=>({version,name})),[{version:7,name:'task-lifecycle-contract'},{version:8,name:'task-execution-runtime'}]);
 const out=path.join(REPOSITORY,'frontend/out'),frontendFiles=files(out).map(file=>{const data=extract(archive,'frontend/out/'+file);assert.equal(Buffer.compare(data,fs.readFileSync(path.join(out,file))),0,'Frontend export drift: '+file);return{file,bytes:data.length,sha256:sha(data)};});
 const chunks=frontendFiles.filter(item=>item.file.endsWith('.js')).map(item=>extract(archive,'frontend/out/'+item.file).toString('utf8')).join('\n');
 const featureMarkers=['图片同时处理数','视频同时处理数','图片最长等待时间（秒）','视频最长等待时间（秒）','取消本地等待','移除任务展示','原生成执行结论','本次生成截止：','恢复同一任务查询','下载重试'];
 for(const marker of featureMarkers){const escaped=Array.from(marker,c=>c.charCodeAt(0)>127?'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'):c).join('');assert.ok(chunks.includes(marker)||chunks.toLowerCase().includes(escaped.toLowerCase()),'UI marker missing: '+marker);}
 assert.ok(frontendFiles.filter(item=>item.file.endsWith('.css')).some(item=>extract(archive,'frontend/out/'+item.file).includes(Buffer.from('.wb-task-settings'))),'Settings CSS missing');
 const guide=fs.readFileSync(path.join(directory,'win-unpacked/resources/GitHub测试版使用说明.md'));assert.equal(Buffer.compare(guide,fs.readFileSync(path.join(REPOSITORY,'docs/Windows-GitHub测试版使用说明.md'))),0,'A/B guide differs');
 for(const marker of['A3.6.1','B3.6.2','120 / 300','真实用户库迁移和 A→B 资料保持仍待安装态验收'])assert.ok(guide.includes(Buffer.from(marker)));
 const identities=[];
 for(const [version,app]of[[aPlan.version,aArchive],[plan.version,archive]]){
  const record=json(path.join(REPOSITORY,'release-updates/local-verification/github-test-'+version+'-identity/identity-summary.json'));assert.equal(record.source.version,version);assert.equal(record.source.appAsarSha512,await hashFile(app));assert.equal(record.results.length,2);assert.deepEqual(record.results[0],record.results[1]);const{version:actual,...fixed}=record.results[0];assert.equal(actual,version);assert.equal(fixed.data.mode,'system');identities.push({version,fixed,appAsarSha512:record.source.appAsarSha512});
 }
 assert.deepEqual(identities[0].fixed,identities[1].fixed,'A/B fixed identity differs');
 const result={schemaVersion:1,version:plan.version,installer:summary.installer,appAsarSha256:sha(fs.readFileSync(archive)),approvedSourceCount:approvedSources.length,approvedSources,productionFiles,defaults,limits,migrations:{a:aMigrations,b:migrations,releasedSqlUnchanged:true},frontend:{fileCount:frontendFiles.length,files:frontendFiles,featureMarkers,cssPresent:true,limitation:'Static package equality and marker checks; no installed UI interaction.'},bundledGuide:{sha256:sha(guide),identicalToSource:true},identityComparison:{a:identities[0],b:identities[1],fixedIdentityEqual:true},limitation:'Offline package inspection and independent identity evidence only. No Nova main, real generation, installation, GitHub traffic, differential transfer or real user-data migration.'};
 fs.writeFileSync(evidence,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({version:plan.version,approvedSources:approvedSources.length,productionFiles:productionFiles.length,frontendFiles:frontendFiles.length,featureMarkers:featureMarkers.length,defaults,migrations:migrations.map(item=>item.version),sameABIdentity:true,evidence},null,2));
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
