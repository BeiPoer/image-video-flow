import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {imageRatios} from '../public/image-sizes.js';
import {startWorkflowServer} from './fixtures/workflow-server.js';

test('two image submissions return before the provider completes, with task state persisted for page reloads', {timeout:10000},async t=>{
  const app=await startWorkflowServer();t.after(app.stop);app.holdImages();
  async function api(path,body){const r=await app.fetch(app.base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3000)});assert.ok(r.ok);return r.json();}
  const p=await api('/api/projects',{name:'异步测试'});
  const ids=[];
  for(const prompt of ['第一张','第二张']){
    const shot=await api('/api/shots',{projectId:p.id,name:prompt});
    const task=await api('/api/tasks',{kind:'image',shotId:shot.id,prompt});ids.push(task.id);
  }
  const snapshot=await api('/api/bootstrap');assert.equal(snapshot.results.length,0);
  for(const id of ids)assert.ok(['queued','running'].includes(snapshot.tasks.find(t=>t.id===id).status));
  const disk=JSON.parse(await readFile(join(app.dir,'state.json'),'utf8'));
  assert.ok(ids.every(id=>disk.tasks.some(task=>task.id===id)));
  // A fresh page uses the same bootstrap endpoint; it does not resubmit either paid task.
  assert.equal((await api('/api/bootstrap')).tasks.length,2);
  for(let i=0;i<100&&app.calls.length<2;i++)await delay(10);
  assert.equal(app.calls.length,2,'both requests must reach the provider before either completes');
  app.releaseImages();
  let done;
  for(let i=0;i<100;i++){done=await api('/api/bootstrap');if(done.tasks.every(t=>t.status==='completed'))break;await delay(20);}
  assert.equal(done.results.length,2);assert.ok(ids.every(id=>done.results.some(r=>r.taskId===id)));
});

test('image placeholders survive fresh page state, do not block more submissions, and become results without duplicates',async()=>{
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const data={projects:[{id:'p1'},{id:'p2'}],shots:[{id:'other',projectId:'p2'}],assets:[],results:[],tasks:[{id:'foreign',shotId:'other',kind:'image',status:'running'}],models:{},providers:{}};
  let seq=0,bootstrapCalls=0;
  function browser(){
    const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,addEventListener(){}});return nodes.get(id);};
    const ctx=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,document:{body:node('body'),querySelector:s=>node(s.slice(1)),querySelectorAll:()=>[]},window:{location:{hash:'#/project/p1'},addEventListener(){}},console,structuredClone,setTimeout(){},clearTimeout(){},bindSettings(){},fetch:async(path,options)=>{
      const body=options?.body?JSON.parse(options.body):null;let result=data;
      if(path==='/api/bootstrap')bootstrapCalls++;
      if(path==='/api/shots'){result={id:'shot-'+(++seq),...body};data.shots.push(result);}
      if(path==='/api/tasks'){result={id:'task-'+seq,...body,status:'running',createdAt:`2026-10-25T01:00:0${seq}Z`};data.tasks.unshift(result);}
      return {ok:true,json:async()=>structuredClone(result)};
    }});
    vm.runInContext(script,ctx);return{ctx,node};
  }
  const first=browser();await vm.runInContext('refresh()',first.ctx);
  const before=bootstrapCalls;
  for(const prompt of ['第一张','第二张']){
    first.node('imagePrompt').value=prompt;await vm.runInContext('generateImage()',first.ctx);
    assert.equal(first.node('generateImageButton').disabled,false);
  }
  assert.equal(bootstrapCalls,before,'acknowledgement must not wait for another full bootstrap refresh');
  assert.equal((first.node('generatedMaterials').innerHTML.match(/data-image-task-id=/g)||[]).length,2);
  const fresh=browser();await vm.runInContext('refresh()',fresh.ctx);
  assert.equal((fresh.node('generatedMaterials').innerHTML.match(/data-image-task-id=/g)||[]).length,2);
  assert.doesNotMatch(fresh.node('generatedMaterials').innerHTML,/foreign|data-image-select/);
  const second=data.tasks.find(t=>t.id==='task-2');second.status='completed';
  data.results.push({id:'r2',taskId:'task-2',shotId:second.shotId,kind:'image',name:'第二张结果',createdAt:'2026-10-25T01:05:00Z',dataUrl:'data:image/png;base64,aA=='});
  await vm.runInContext('refresh()',fresh.ctx);
  let html=fresh.node('generatedMaterials').innerHTML;
  assert.match(html,/data-image-id="r2"/);assert.doesNotMatch(html,/data-image-task-id="task-2"/);
  assert.ok(html.indexOf('data-image-id="r2"')<html.indexOf('data-image-task-id="task-1"'));
  const original=data.tasks.find(t=>t.id==='task-1');original.status='failed';original.error='测试失败';
  await vm.runInContext('refresh()',fresh.ctx);
  assert.doesNotMatch(fresh.node('generatedMaterials').innerHTML,/data-image-task-id=/);
  assert.match(fresh.node('imageTaskFailure').textContent,/测试失败/);
  assert.equal(fresh.node('generateImageButton').disabled,false);
});
