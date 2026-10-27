import test from 'node:test';
import assert from 'node:assert/strict';
import {canvasGraph,layoutGraph,taskSources,worldPoint,zoomAt} from '../public/canvas-model.js';
import {startWorkflowServer,png} from './fixtures/workflow-server.js';

test('canvas derives branches from uploaded/generated references, retains positions when tasks finish, and isolates projects',()=>{
  const state={projects:[{id:'p2'},{id:'p1'}],shots:[{id:'s1',projectId:'p1'},{id:'s2',projectId:'p2'}],assets:[{id:'a1',kind:'image'},{id:'a2',projectId:'p2'}],results:[{id:'r1',shotId:'s1',taskId:'t1',kind:'image'}],tasks:[{id:'t1',shotId:'s1',referenceImageIds:['a1']},{id:'t2',shotId:'s1',params:{kyyMedia:{firstImageId:'r1',lastImageId:'a1'}}}]};
  let graph=canvasGraph(state,'p1');assert.deepEqual(graph.nodes.map(n=>n.id),['a1','r1','t2']);
  assert.deepEqual(graph.edges,[{from:'a1',to:'r1'},{from:'r1',to:'t2'},{from:'a1',to:'t2'}]);
  const layout=layoutGraph(graph);assert.ok(layout.a1.x<layout.r1.x);assert.ok(layout.r1.x<layout.t2.x);
  layout.t2={x:777,y:456};state.results.push({id:'r2',taskId:'t2',shotId:'s1',kind:'video'});
  graph=canvasGraph(state,'p1');assert.deepEqual(layoutGraph(graph,layout).r2,{x:777,y:456});
  assert.deepEqual(canvasGraph(state,'p2').nodes.map(n=>n.id),['a1','a2']);
  assert.deepEqual(taskSources({inputImageId:'a1',params:{kyyMedia:{referenceImageIds:['a1'],referenceAudioIds:['sound']}}}),['a1','sound']);
});
test('pointer conversion and zoom preserve the world point under the cursor',()=>{
  const view={x:80,y:-50,zoom:.7},point={x:400,y:300},before=worldPoint(point,{left:0,top:0},view),after=zoomAt(view,1.5,point);
  const actual=worldPoint(point,{left:0,top:0},after);assert.ok(Math.abs(actual.x-before.x)<.00001);assert.ok(Math.abs(actual.y-before.y)<.00001);
  assert.equal(zoomAt(view,9,point).zoom,2);assert.equal(zoomAt(view,.01,point).zoom,.2);
});
test('canvas layout persists via API, rejects malformed coordinates and assigns imports to their project',async t=>{
  const app=await startWorkflowServer();t.after(app.stop);
  const call=async(path,body,method='POST')=>{const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const p=(await call('/api/projects',{name:'画布'})).value;
  const a=(await call('/api/assets',{name:'图片',projectId:p.id,kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,'+png})).value;
  assert.equal(a.projectId,p.id);
  const canvas={workflow:'confirmed-materials-v1',positions:{[a.id]:{x:120.5,y:-90}},viewport:{x:5,y:6,zoom:.7},assetIds:[a.id]};
  assert.equal((await call('/api/projects/'+p.id,{canvas},'PATCH')).status,200);
  const state=await (await app.fetch(app.base+'/api/bootstrap')).json();assert.deepEqual(state.projects[0].canvas,canvas);
  assert.equal(state.projects[0].canvas.workflow,'confirmed-materials-v1');
  for(const invalid of [{...canvas,positions:{unknown:{x:0,y:0}}},{...canvas,viewport:{x:0,y:0,zoom:0}},{...canvas,positions:{[a.id]:{x:1e9,y:0}}},{...canvas,assetIds:['unknown']}])assert.equal((await call('/api/projects/'+p.id,{canvas:invalid},'PATCH')).status,400);
  assert.equal((await call('/api/assets',{name:'bad',projectId:'missing',dataUrl:'data:image/png;base64,'+png})).status,404);
  const legacy = {...canvas, workflow:undefined, assetIds:[]};
  assert.equal((await call('/api/projects/'+p.id,{canvas:legacy},'PATCH')).status,200);
  const legacyState = await (await app.fetch(app.base+'/api/bootstrap')).json();
  assert.equal(Object.hasOwn(legacyState.projects[0].canvas,'workflow'),false,'legacy free-canvas assets must not be silently marked confirmed');
});
