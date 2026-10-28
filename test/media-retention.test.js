import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {expireResources,mediaExpired,requireMedia,retentionMs} from '../media-retention.js';
import {videoFile} from '../video-download.js';
import {createSettingsStore} from '../model-settings.js';
import {startWorkflowServer} from './fixtures/workflow-server.js';

async function directory(t) {
  const dir=await mkdtemp(join(tmpdir(),'ai-flow-retention-'));
  t.after(async()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep+'ai-flow-retention-'));await rm(dir,{recursive:true,force:true});});
  return dir;
}
function emptyState(){return {projects:[],shots:[],assets:[],results:[],tasks:[]};}

test('seven-day boundary removes bytes and links, preserves tombstones, and cleans disk and stale references',async t=>{
  const dir=await directory(t),time=Date.now(),old=new Date(time-retentionMs).toISOString(),fresh=new Date(time-retentionMs+1).toISOString();
  const state=emptyState(),url='https://example.test/expired.mp4',hash=createHash('sha256').update(url).digest('hex');
  state.assets=[{id:'old',kind:'image',name:'原图',createdAt:old,dataUrl:'data:image/png;base64,c2VjcmV0'},{id:'fresh',kind:'image',createdAt:fresh,dataUrl:'data:image/png;base64,YQ=='}];
  state.results=[{id:'video',kind:'video',createdAt:old,dataUrl:'/api/video-results/task-aaaa.mp4'},{id:'remote',kind:'video',createdAt:old,dataUrl:url}];
  state.shots=[{id:'s',selectedImageId:'old',selectedVideoId:'video',assetIds:['old','fresh']}];
  state.projects=[{canvas:{assetIds:['old','fresh'],generators:[{referenceImageIds:['old','fresh']}]}}];
  state.tasks=[{createdAt:old,inputImageUrl:'data:image/png;base64,c2VjcmV0',params:{referenceImages:[url],firstImage:url,duration:8}}];
  for(const folder of ['videos','video-downloads','recovered-videos'])await mkdir(join(dir,folder));
  await writeFile(join(dir,'videos/task-aaaa.mp4'),'old video');
  await writeFile(join(dir,'video-downloads',hash+'.mp4'),'cached video');
  const orphan=join(dir,'recovered-videos/old.mp4');await writeFile(orphan,'old');await utimes(orphan,new Date(old),new Date(old));
  await writeFile(join(dir,'recovered-videos/recent.mp4'),'recent');
  let saved;
  await expireResources(state,dir,async value=>{saved=structuredClone(value);},time);
  assert.equal(saved.assets[0].name,'原图');assert.ok(saved.assets[0].deletedAt);assert.equal(saved.assets[0].dataUrl,undefined);
  assert.equal(state.assets[1].deletedAt,undefined);assert.ok(state.assets[1].dataUrl);
  assert.equal(mediaExpired(state.assets[1],time),false);assert.equal(mediaExpired(state.assets[1],time+1),true);
  assert.equal(state.results[1].dataUrl,undefined);assert.equal(state.tasks[0].inputImageUrl,undefined);assert.deepEqual(state.tasks[0].params,{duration:8});
  assert.equal(state.shots[0].selectedImageId,null);assert.equal(state.shots[0].selectedVideoId,null);assert.deepEqual(state.shots[0].assetIds,['fresh']);
  assert.deepEqual(state.projects[0].canvas.assetIds,['old','fresh'],'confirmation must retain the placeholder');
  assert.deepEqual(state.projects[0].canvas.generators[0].referenceImageIds,['fresh']);
  for(const file of ['videos/task-aaaa.mp4','video-downloads/'+hash+'.mp4','recovered-videos/old.mp4'])await assert.rejects(stat(join(dir,file)),{code:'ENOENT'});
  assert.equal((await readFile(join(dir,'recovered-videos/recent.mp4'))).toString(),'recent');
  assert.throws(()=>requireMedia(state.assets[0]),{status:410});
  await assert.rejects(videoFile(state.results[1],dir,()=>assert.fail('must not redownload expired video')),{status:410});
});

test('shared cache survives until all references expire; failed deletions remain retryable after restart',async t=>{
  const dir=await directory(t),time=Date.now(),state=emptyState(),url='https://example.test/shared.mp4';
  const cache='video-downloads/'+createHash('sha256').update(url).digest('hex')+'.mp4';await mkdir(join(dir,'video-downloads'));await writeFile(join(dir,cache),'shared');
  state.results=[{id:'old',kind:'video',createdAt:new Date(time-retentionMs).toISOString(),dataUrl:url},{id:'fresh',kind:'video',createdAt:new Date(time).toISOString(),dataUrl:url}];
  await expireResources(state,dir,async()=>{},time);assert.equal((await readFile(join(dir,cache))).toString(),'shared');
  const blocked='videos/task-bbbb.mp4';await mkdir(join(dir,blocked),{recursive:true});
  state.results.push({id:'blocked',kind:'video',createdAt:new Date(time-retentionMs).toISOString(),dataUrl:'/api/video-results/task-bbbb.mp4'});
  let saved;const errors=await expireResources(state,dir,async value=>{saved=structuredClone(value);},time);
  assert.equal(errors.length,1,'a failed disk deletion must not prevent placeholders or other cleanup');
  assert.equal(saved.results.at(-1).dataUrl,undefined);assert.deepEqual(saved.results.at(-1).purgeFiles,[blocked]);
  await rm(join(dir,blocked),{recursive:true});await writeFile(join(dir,blocked),'unlocked');
  await expireResources(saved,dir,async()=>{},time+retentionMs);
  await assert.rejects(stat(join(dir,blocked)),{code:'ENOENT'});await assert.rejects(stat(join(dir,cache)),{code:'ENOENT'});
});

test('failed metadata persistence retries even when all expired payloads were already removed from memory',async t=>{
  const dir=await directory(t),state=emptyState();
  state.assets=[{id:'old',createdAt:new Date(Date.now()-retentionMs).toISOString(),dataUrl:'data:image/png;base64,YQ=='}];
  await assert.rejects(expireResources(state,dir,async()=>{throw Error('disk unavailable');}),/disk unavailable/);
  let saved;await expireResources(state,dir,async value=>{saved=structuredClone(value);});
  assert.ok(saved.assets[0].deletedAt);assert.equal(saved.assets[0].dataUrl,undefined);
});

test('startup and request-time expiry block generation, signed access, playback and downloads without paid calls',async t=>{
  const old=new Date(Date.now()-retentionMs-1000).toISOString(),state=emptyState();
  state.projects=[{id:'p',name:'项目'}];state.shots=[{id:'s',projectId:'p'}];
  state.assets=[{id:'asset-old',kind:'image',name:'旧图',projectId:'p',createdAt:old,dataUrl:'data:image/png;base64,YQ=='}];
  state.tasks=[{id:'task-aaaa',kind:'video',status:'completed',shotId:'s',createdAt:old}];
  state.results=[{id:'result-old',taskId:'task-aaaa',shotId:'s',kind:'video',provider:'openai',createdAt:old,dataUrl:'/api/video-results/task-aaaa.mp4'}];
  const app=await startWorkflowServer(state);t.after(app.stop);
  const call=(path,body,method='POST',headers={})=>app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const snapshot=await (await app.fetch(app.base+'/api/bootstrap')).json();
  assert.ok(snapshot.assets[0].deletedAt);assert.equal(snapshot.assets[0].dataUrl,undefined);
  for(const body of [{kind:'image',referenceImageIds:['asset-old']},{kind:'video',inputImageId:'asset-old'}]){
    const response=await call('/api/tasks',{shotId:'s',prompt:'cannot use expired reference',...body});assert.equal(response.status,410);assert.match((await response.json()).error,/已删除/);
  }
  assert.equal((await app.fetch(app.base+'/api/video-results/task-aaaa.mp4')).status,410);
  assert.equal((await app.fetch(app.base+'/api/results/result-old/download')).status,410);
  assert.equal((await call('/api/results/result-old/video-confirmation',{confirmed:true},'PATCH')).status,410);
  assert.equal((await call('/api/results/result-old/video-confirmation',{confirmed:false},'PATCH')).status,200);
  const settings=await (await app.fetch(app.base+'/api/settings')).json();
  assert.equal((await call('/api/settings',{VIDEO_API_TYPE:'kyyReactApi',PUBLIC_ASSET_BASE_URL:'https://media.example.test'},'PUT',{'x-settings-token':settings.settingsToken})).status,200);
  assert.equal((await call('/api/tasks',{shotId:'s',kind:'video',prompt:'expired kyy refs',kyyMedia:{referenceImageIds:['asset-old']}})).status,410);
  const store=await createSettingsStore(app.dir,{}),signed=new URL(await store.createAssetUrl('asset-old','image/png'));
  assert.equal((await fetch(app.base+signed.pathname+signed.search)).status,410);
  assert.equal(app.calls.length,0,'expired references must not reach any provider');
});

test('resources reaching seven days while the server runs expire on the next request',async t=>{
  const state=emptyState();state.assets=[{id:'asset-aging',kind:'image',createdAt:new Date(Date.now()-retentionMs+2000).toISOString(),dataUrl:'data:image/png;base64,YQ=='}];
  const app=await startWorkflowServer(state);t.after(app.stop);
  const before=await (await app.fetch(app.base+'/api/bootstrap')).json();assert.ok(before.assets[0].dataUrl);
  await delay(2100);
  const after=await (await app.fetch(app.base+'/api/bootstrap')).json();assert.ok(after.assets[0].deletedAt);assert.equal(after.assets[0].dataUrl,undefined);
  assert.equal((await app.fetch(app.base+before.assets[0].dataUrl)).status,410);
  assert.equal(JSON.parse(await readFile(join(app.dir,'state.json'),'utf8')).assets[0].dataUrl,undefined);
});
