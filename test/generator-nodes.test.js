import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {preprocessingGraph} from '../public/canvas-model.js';
import {startWorkflowServer,png} from './fixtures/workflow-server.js';

test('editable generator nodes and removed materials persist; generation links to the correct node and rejects foreign IDs',async t=>{
  const app=await startWorkflowServer();t.after(app.stop);
  const call=async(path,body,method=body?'POST':'GET')=>{const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,value:await response.json()};};
  const p=(await call('/api/projects',{name:'节点测试'})).value;
  const a=(await call('/api/assets',{name:'图',projectId:p.id,kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,'+png})).value;
  const gen={id:'gen-'+randomUUID(),prompt:'保留主体，改变背景',size:'1024x1024',referenceImageIds:[a.id]};
  const canvas={workflow:'confirmed-materials-v1',positions:{[gen.id]:{x:450,y:100}},viewport:{x:0,y:0,zoom:1},assetIds:[a.id],generators:[gen],hiddenNodeIds:[]};
  assert.equal((await call('/api/projects/'+p.id,{canvas},'PATCH')).status,200);
  assert.deepEqual((await call('/api/bootstrap')).value.projects[0].canvas,canvas);
  for(const invalid of [{...canvas,generators:[gen,gen]},{...canvas,generators:[{...gen,referenceImageIds:['missing']}]},{...canvas,generators:[{...gen,prompt:10}]},{...canvas,hiddenNodeIds:['missing']}])assert.equal((await call('/api/projects/'+p.id,{canvas:invalid},'PATCH')).status,400);
  const shot=(await call('/api/shots',{projectId:p.id,name:'测试'})).value;
  const payload={kind:'image',shotId:shot.id,imageNodeId:gen.id,prompt:gen.prompt,params:{size:gen.size},referenceImageIds:[a.id]};
  assert.equal((await call('/api/tasks',{...payload,imageNodeId:'gen-'+randomUUID()})).status,400);
  const p2=(await call('/api/projects',{name:'另一项目'})).value;
  const s2=(await call('/api/shots',{projectId:p2.id,name:'另一镜头'})).value;
  assert.equal((await call('/api/tasks',{...payload,shotId:s2.id})).status,400);
  const submitted=await call('/api/tasks',payload);assert.equal(submitted.status,202);assert.equal(submitted.value.imageNodeId,gen.id);
  let state;
  for(let i=0;i<100;i++){state=(await call('/api/bootstrap')).value;if(state.results.some(r=>r.taskId===submitted.value.id))break;await delay(20);}
  const result=state.results.find(r=>r.taskId===submitted.value.id);assert.ok(result);
  const graph=preprocessingGraph(state,p.id);assert.ok(graph.edges.some(e=>e.from===a.id&&e.to===gen.id));assert.ok(graph.edges.some(e=>e.from===gen.id&&e.to===result.id));
  const deleted={...canvas,generators:[],positions:{},hiddenNodeIds:[a.id],assetIds:[]};
  assert.equal((await call('/api/projects/'+p.id,{canvas:deleted},'PATCH')).status,200);
  state=(await call('/api/bootstrap')).value;
  assert.ok(state.assets.some(item=>item.id===a.id),'removing a node must retain original files');
  assert.ok(preprocessingGraph(state,p.id).nodes.some(node=>node.id===result.id),'removing a generator must keep outputs');
  assert.ok(!preprocessingGraph(state,p.id).nodes.some(node=>node.id===a.id||node.id===gen.id));
});
