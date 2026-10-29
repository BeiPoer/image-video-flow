import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import {imageRatios} from '../public/image-sizes.js';
import {startWorkflowServer,png} from './fixtures/workflow-server.js';

test('saved results refill prompts, ordered reference IDs and generation settings without submitting a new job',async()=>{
  const nodes=new Map(),calls=[],choices=['videoRatio','videoSize','videoResolution','videoFrameMode'].flatMap(field=>['reference','frames','16:9','1080p','1280x720'].map(value=>({dataset:{videoOption:field},value})));
  const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:true,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},focus(){document.activeElement=this;},scrollIntoView(){},setAttribute(){},removeAttribute(){}});return nodes.get(id);};
  const document={body:node('body'),querySelector:selector=>node(selector.slice(1)),querySelectorAll:selector=>selector==='[data-video-option]'?choices:[]};
  const createdAt=new Date().toISOString();
  const data={projects:[{id:'p1',canvas:{workflow:'confirmed-materials-v1',assetIds:[],hiddenNodeIds:['a2'],positions:{},viewport:{x:0,y:0,zoom:1}}},{id:'p2'}],shots:[{id:'s1',projectId:'p1'},{id:'s2',projectId:'p2'}],assets:['a1','a2'].map(id=>({id,projectId:'p1',kind:'image',name:id,dataUrl:'/api/media/'+id,createdAt})),results:[
    {id:'image',shotId:'s1',taskId:'image-task',kind:'image',name:'生成图',prompt:'结果提示词',dataUrl:'/api/media/image',createdAt},
    {id:'video',shotId:'s1',taskId:'video-task',kind:'video',name:'生成视频',prompt:'视频提示词',dataUrl:'https://example.test/video.mp4',createdAt},
    {id:'legacy',shotId:'s1',kind:'image',name:'旧结果',prompt:'旧结果提示词',createdAt},
    {id:'foreign',shotId:'s2',taskId:'foreign-task',kind:'image',createdAt},
  ],tasks:[
    {id:'image-task',shotId:'s1',kind:'image',status:'completed',prompt:'将 @图1 放入 @图2',referenceImageIds:['a2','a1'],params:{size:'1536x864'},createdAt},
    {id:'video-task',shotId:'s1',kind:'video',status:'completed',prompt:'从 @图1 过渡到 @图2',params:{duration:12,videoSize:'1280x720',videoMedia:{firstImageId:'a2',lastImageId:'a1'}},videoApiType:'openai',createdAt},
    {id:'foreign-task',shotId:'s2',kind:'image',prompt:'其他项目',referenceImageIds:['a1'],createdAt},
  ],models:{},providers:{},videoApiType:'openai'};
  const context=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,document,window:{location:{hash:'#/project/p1'},addEventListener(){}},console,structuredClone,setTimeout(){},clearTimeout(){},bindSettings(){},fetch:async(path,options)=>{
    const body=options?.body?JSON.parse(options.body):null;calls.push({path,body});
    if(path==='/api/projects/p1')data.projects[0].canvas=structuredClone(body.canvas);
    return {ok:true,json:async()=>structuredClone(data)};
  }});
  const run=code=>vm.runInContext(code,context);
  run((await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,''));await run('refresh()');
  assert.match(node('generatedMaterials').innerHTML,/data-reuse-generation="image"/);
  assert.match(node('generatedMaterials').innerHTML,/aria-label="点击回填提示词"><svg[^>]*aria-hidden="true"[^>]*><path[^>]*\/><\/svg><\/button><\/div><span class="material-name"/);
  assert.doesNotMatch(node('generatedMaterials').innerHTML,/回填生成信息/);
  assert.doesNotMatch(node('uploadedMaterials').innerHTML,/data-reuse-generation="a[12]"/);
  assert.match(node('videoResults').innerHTML,/data-reuse-generation="video"/);
  assert.match(node('confirmedVideos').innerHTML,/data-reuse-generation="video"/);
  for(const container of ['videoResults','confirmedVideos']){
    assert.match(node(container).innerHTML,/<div class="video-card-actions"><button type="button" class="outline-button reuse-video" data-reuse-generation="video">回填提示词<\/button>/);
    assert.doesNotMatch(node(container).innerHTML,/class="reuse-generation"/);
  }
  node('imagePrompt').value='当前草稿';node('videoPrompt').value='视频草稿';
  await node('body').handlers.click({target:{closest:selector=>selector==='[data-reuse-generation]'?{dataset:{reuseGeneration:'image'}}:null}});await run('projectSaveQueue');
  assert.equal(node('imagePrompt').value,'将 @图1 放入 @图2');assert.equal(run('imageSize'),'1536x864');
  assert.equal(run('JSON.stringify(imageReferenceIds)'),'["a2","a1"]');assert.equal(node('videoPrompt').value,'视频草稿');
  assert.deepEqual(data.projects[0].canvas.hiddenNodeIds,[]);assert.match(node('imagePromptHighlight').innerHTML,/@图1/);
  await run('refresh()');assert.equal(run('JSON.stringify(imageReferenceIds)'),'["a2","a1"]','polling preserves restored references');
  run("reuseGeneration('video')");await run('projectSaveQueue');
  assert.equal(node('videoPrompt').value,'从 @图1 过渡到 @图2');assert.equal(node('videoDuration').value,'12');assert.equal(node('videoSize').value,'1280x720');assert.equal(node('videoFrameMode').value,'frames');
  assert.equal(run('JSON.stringify(selectedImageIds)'),'["a2","a1"]');assert.deepEqual(data.projects[0].canvas.assetIds,['a2','a1']);
  assert.ok(choices.find(option=>option.dataset.videoOption==='videoFrameMode'&&option.value==='frames').checked);
  assert.match(node('videoPicker').innerHTML,/图1 · 首帧/);assert.match(node('videoPicker').innerHTML,/图2 · 尾帧/);
  assert.equal(run('JSON.stringify(imageReferenceIds)'),'["a2","a1"]');
  data.tasks[1].params={duration:7,ratio:'16:9',resolution:'1080p',kyyMedia:{referenceImageIds:['a1','a2']}};data.tasks[1].videoApiType='kyyReactApi';data.videoApiType='kyyReactApi';await run('refresh()');
  run("reuseGeneration('video')");await run('projectSaveQueue');
  assert.equal(node('videoFrameMode').value,'reference');assert.equal(node('videoRatio').value,'16:9');assert.equal(node('videoResolution').value,'1080p');assert.equal(run('JSON.stringify(selectedImageIds)'),'["a1","a2"]');
  data.tasks[1].params={duration:6,ratio:'9:16'};data.tasks[1].inputImageId='a2';data.tasks[1].videoApiType='volcengine';await run('refresh()');run("reuseGeneration('video')");await run('projectSaveQueue');
  assert.equal(run('JSON.stringify(selectedImageIds)'),'["a2"]');assert.match(node('videoError').textContent,/接口与原任务不同/);
  data.assets[1].deletedAt=createdAt;data.results[0].deletedAt=createdAt;await run('refresh()');
  assert.match(node('generatedMaterials').innerHTML,/data-reuse-generation="image"/,'expired outputs still expose their generation record');
  run("reuseGeneration('image')");await run('projectSaveQueue');
  assert.equal(node('imagePrompt').value,'将 @图1 放入 @图2');assert.equal(run('imageReferenceIds.length'),0,'missing earlier references must not renumber the remaining ones');assert.match(node('imageError').textContent,/图1（a2）/);
  run("reuseGeneration('legacy')");await run('projectSaveQueue');assert.equal(node('imagePrompt').value,'旧结果提示词');assert.match(node('imageError').textContent,/原任务记录缺失/);
  run("reuseGeneration('foreign')");assert.equal(node('imagePrompt').value,'旧结果提示词');assert.match(node('toast').textContent,/原项目/);
  assert.equal(calls.some(call=>call.path==='/api/tasks'||call.path==='/api/shots'),false,'recall never generates or charges for another task');
});

test('generation prompts and material IDs survive reloading stored results even after media expires',async t=>{
  const createdAt=new Date(Date.now()-8*86400000).toISOString();
  const task={id:'task-image',shotId:'shot',kind:'image',status:'completed',prompt:'保留 @图1',referenceImageIds:['asset'],params:{size:'1024x1024'},createdAt};
  const state={projects:[{id:'project'}],shots:[{id:'shot',projectId:'project'}],assets:[{id:'asset',projectId:'project',kind:'image',createdAt,dataUrl:'data:image/png;base64,'+png}],results:[{id:'result',shotId:'shot',taskId:task.id,kind:'image',prompt:task.prompt,createdAt,dataUrl:'data:image/png;base64,'+png}],tasks:[task]};
  const app=await startWorkflowServer(state);t.after(app.stop);
  const stored=JSON.parse(await readFile(app.dir+'/state.json','utf8'));
  assert.equal(stored.results[0].taskId,task.id);assert.equal(stored.results[0].prompt,task.prompt);assert.deepEqual(stored.tasks[0].referenceImageIds,['asset']);
  const payload=await (await app.fetch(app.base+'/api/bootstrap')).json();
  assert.equal(payload.tasks[0].prompt,task.prompt);assert.deepEqual(payload.tasks[0].referenceImageIds,['asset']);assert.ok(payload.assets[0].deletedAt);assert.equal(payload.assets[0].dataUrl,undefined);
});
