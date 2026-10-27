import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import {imageRatios} from '../public/image-sizes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('old video failures stay in history, current failures are separate dated alerts, and successful media stays visible',async()=>{
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const nodes=new Map();
  function node(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}});return nodes.get(id);}
  const createdAt='2026-10-25T01:00:00Z',completedAt='2026-10-25T01:05:00Z';
  const data={projects:[{id:'p1'}],shots:[{id:'s1',projectId:'p1'},{id:'s2',projectId:'p2'}],assets:[],results:[{id:'r1',taskId:'success',kind:'video',name:'成功的视频',dataUrl:'https://example.test/video.mp4'}],tasks:[
    {id:'old',shotId:'s1',kind:'video',status:'failed',error:'旧 multipart 错误',createdAt},
    {id:'old-unknown',shotId:'s1',kind:'video',status:'unknown',error:'旧待核实',createdAt},
    {id:'success',shotId:'s1',kind:'video',status:'completed',prompt:'成功提示词',createdAt},
    {id:'active',shotId:'s1',kind:'video',status:'running',prompt:'当前任务',createdAt},
    {id:'queue',shotId:'s1',kind:'video',status:'queued',prompt:'排队任务',createdAt},
  ],models:{},providers:{}};
  const context=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,document:{body:node('body'),querySelector:selector=>node(selector.slice(1)),querySelectorAll:()=>[]},window:{location:{hash:'#/project/p1'},addEventListener(){}},console,structuredClone,setTimeout(){},clearTimeout(){},preprocessingGraph:()=>({nodes:[],edges:[]}),bindPrepCanvas:()=>({update(){}}),bindSettings(){},fetch:async()=>({ok:true,json:async()=>structuredClone(data)})});
  vm.runInContext(script,context);await vm.runInContext('refresh()',context);
  assert.doesNotMatch(node('videoResults').innerHTML,/旧 multipart|旧待核实|失败/);
  assert.match(node('videoResults').innerHTML,/成功的视频/);
  assert.match(node('videoResults').innerHTML,/视频生成中/);
  assert.match(node('videoResults').innerHTML,/视频排队中/);
  assert.equal(node('videoTaskAlerts').hidden,true);
  assert.match(node('taskList').innerHTML,/旧 multipart/);
  Object.assign(data.tasks.find(t=>t.id==='active'),{status:'failed',error:'当前错误 <script>',completedAt});
  await vm.runInContext('refresh()',context);
  assert.doesNotMatch(node('videoResults').innerHTML,/当前错误|生成失败/);
  assert.match(node('videoTaskAlerts').innerHTML,/本次任务提醒/);
  assert.match(node('videoTaskAlerts').innerHTML,/当前错误 &lt;script&gt;/);
  assert.ok(node('videoTaskAlerts').innerHTML.includes(new Date(completedAt).toLocaleString('zh-CN')));
  assert.doesNotMatch(node('videoTaskAlerts').innerHTML,/旧 multipart/);
  Object.assign(data.tasks.find(t=>t.id==='queue'),{status:'unknown',error:'查询超时',remoteTaskId:'remote-123'});
  await vm.runInContext('refresh()',context);
  assert.match(node('videoTaskAlerts').innerHTML,/避免重复提交计费/);
  assert.match(node('taskList').innerHTML,/remote-123/);
  // Covers a submission which fails before the first polling response.
  vm.runInContext("watchedVideoTaskIds.add('fast-failure')",context);
  data.tasks.push({id:'fast-failure',shotId:'s1',kind:'video',status:'failed',error:'立即失败',createdAt});
  await vm.runInContext('refresh()',context);
  assert.match(node('videoTaskAlerts').innerHTML,/立即失败/);
  vm.runInContext("projectId='p2';renderVideoResults()",context);
  assert.equal(node('videoTaskAlerts').hidden,true,'alerts must not spill into other projects');
  vm.runInContext("projectId='p1';watchedVideoTaskIds.clear();renderVideoResults()",context);
  assert.equal(node('videoTaskAlerts').hidden,true,'reopening treats completed failures as history');
});
