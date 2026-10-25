'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {recordReview,validateReview,localPath,sequence,options,git,run}=require('./deliver.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nova-deliver-test-'));
 git(root,['init','-b','dev']);git(root,['config','user.email','fixture@example.invalid']);git(root,['config','user.name','Fixture']);
 fs.writeFileSync(path.join(root,'a.txt'),'old');fs.writeFileSync(path.join(root,'remove.txt'),'remove');git(root,['add','.']);git(root,['commit','-m','base']);
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('nova-deliver-test-'));fs.rmSync(root,{recursive:true,force:true});});
 return root;
}
test('review binds exact added, changed and deleted files; later changes and traversal fail',t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'a.txt'),'new');fs.writeFileSync(path.join(root,'new.txt'),'new');fs.unlinkSync(path.join(root,'remove.txt'));
 const review=recordReview(root,['a.txt','new.txt','remove.txt'],'reviewer','tests passed');validateReview(root,review);
 assert.equal(review.files[2].sha256,null);fs.writeFileSync(path.join(root,'a.txt'),'changed again');assert.throws(()=>validateReview(root,review),/审核后/);
 for(const name of ['../outside','.git/config','temp/raw','backend/.env','frontend/node_modules/a'])assert.throws(()=>localPath(root,name));
});
test('real local delivery commits only reviewed paths, preserves unrelated edits and resumes after push failure',async t=>{
 const root=fixture(t),remote=path.join(root,'.git','fixture-remote.git');git(root,['init','--bare',remote]);git(root,['remote','add','origin',remote]);git(root,['push','origin','dev']);
 fs.writeFileSync(path.join(root,'a.txt'),'approved');fs.writeFileSync(path.join(root,'new.txt'),'approved new');fs.writeFileSync(path.join(root,'unrelated.txt'),'leave alone');
 const review=recordReview(root,['a.txt','new.txt'],'reviewer','local fixture'),file=path.join(root,'.git','review.json');fs.writeFileSync(file,JSON.stringify(review));
 const opts={review:file,mode:'push',profile:'github-test',message:'approved changes',execute:true};
 const tip=()=>git(root,['ls-remote',remote,'refs/heads/dev']).split(/\s/)[0];
 // A failing pre-push hook leaves the new commit and journal ready for retry.
 const hook=path.join(root,'.git','hooks','pre-push');fs.writeFileSync(hook,'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);
 await assert.rejects(run(root,opts,{remoteTip:tip}));
 const committed=git(root,['rev-parse','HEAD']);assert.notEqual(committed,review.base);assert.equal(git(root,['log','-1','--format=%s']),'approved changes');
 assert.equal(git(root,['show','HEAD:a.txt']),'approved');assert.throws(()=>git(root,['show','HEAD:unrelated.txt']));assert.equal(fs.readFileSync(path.join(root,'unrelated.txt'),'utf8'),'leave alone');
 fs.unlinkSync(hook);const state=await run(root,opts,{remoteTip:tip});assert.equal(state.commit,committed);assert.equal(tip(),committed);assert.equal(git(root,['rev-list','--count','HEAD']),'2');
 assert.deepEqual(state.done,['commit','push']);assert.equal(git(root,['diff','--cached','--name-only']),'');
});
test('preview changes no refs or journal and requires no remote',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'a.txt'),'approved');const review=recordReview(root,['a.txt'],'reviewer','fixture'),file=path.join(root,'.git','review.json');fs.writeFileSync(file,JSON.stringify(review));
 await run(root,{review:file,mode:'push',profile:'github-test',message:'fixture'},{remoteTip:()=>{throw Error('network forbidden');}});
 assert.equal(git(root,['rev-parse','HEAD']),review.base);assert.equal(fs.existsSync(path.join(root,'.git','nova-delivery')),false);
});
test('staged unrelated files block execution without changing index',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'a.txt'),'approved');const review=recordReview(root,['a.txt'],'reviewer','fixture'),file=path.join(root,'.git','review.json');fs.writeFileSync(file,JSON.stringify(review));fs.writeFileSync(path.join(root,'other.txt'),'staged');git(root,['add','other.txt']);
 await assert.rejects(run(root,{review:file,mode:'push',profile:'github-test',message:'fixture',execute:true}),/暂存区/);assert.equal(git(root,['diff','--cached','--name-only']),'other.txt');
});
test('stage journal resumes and promotes push to build then publish without repeating completed actions',async()=>{
 const state={done:[]},calls=[],save=()=>{};let fail=true;
 const ops=Object.fromEntries(['commit','push','build','verify','release'].map(name=>[name,async()=>{calls.push(name);if(name==='build'&&fail)throw Error('failed build');}]));
 await sequence(state,'push',ops,save);await assert.rejects(sequence(state,'publish',ops,save));assert.deepEqual(state.done,['commit','push']);fail=false;
 await sequence(state,'publish',ops,save);assert.deepEqual(calls,['commit','push','build','build','verify','release']);
});
test('argument defaults are preview and explicitly selected operation only',()=>{assert.equal(options(['run','--review','x']).execute,undefined);assert.equal(options(['run','--execute']).execute,true);assert.throws(()=>options(['run','--force']));});
test('legacy workflow never triggers on tags or uploads public Release assets',()=>{const text=fs.readFileSync(path.join(__dirname,'../.github/workflows/desktop-release.yml'),'utf8');assert.ok(text.includes('workflow_dispatch:'));assert.equal(/push:|action-gh-release|contents: write/.test(text),false);});
