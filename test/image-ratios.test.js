import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {imageRatios,imageSizes} from '../public/image-sizes.js';
import {startWorkflowServer,png} from './fixtures/workflow-server.js';

test('ratio tiles map to exact aspect ratios and valid image dimensions, preserving legacy sizes',()=>{
  assert.deepEqual(imageRatios.map(r=>r.label),['1:1','3:4','4:3','9:16','16:9']);
  for(const ratio of imageRatios){
    const [w,h]=ratio.size.split('x').map(Number),[a,b]=ratio.label.split(':').map(Number);
    assert.equal(w*b,h*a);assert.equal(w%16,0);assert.equal(h%16,0);
    assert.ok(w*h>=655360&&w*h<=8294400);
    assert.equal(ratio.width*b,ratio.height*a);
  }
  for(const size of ['auto','1024x1536','1536x1024'])assert.ok(imageSizes.includes(size));
});
test('every selectable ratio saves on a node and reaches both generation and editing requests unchanged',async t=>{
  const app=await startWorkflowServer();t.after(app.stop);
  async function api(path,body,method=body?'POST':'GET'){
    const r=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;
  }
  const project=await api('/api/projects',{name:'比例测试'});
  const asset=await api('/api/assets',{name:'参考.png',projectId:project.id,kind:'image',mime:'image/png',dataUrl:'data:image/png;base64,'+png});
  const node={id:'gen-'+randomUUID(),prompt:'test',size:'1024x1024',referenceImageIds:[]};
  for(const {size} of imageRatios){
    node.size=size;
    await api('/api/projects/'+project.id,{canvas:{generators:[node],positions:{},viewport:{x:0,y:0,zoom:1},assetIds:[]}},'PATCH');
    assert.equal((await api('/api/bootstrap')).projects[0].canvas.generators[0].size,size);
    for(const refs of [[],[asset.id]]){
      const shot=await api('/api/shots',{projectId:project.id,name:'比例'});
      const task=await api('/api/tasks',{kind:'image',shotId:shot.id,imageNodeId:node.id,prompt:'test',params:{size},referenceImageIds:refs});
      let terminal;
      for(let i=0;i<100;i++){terminal=(await api('/api/bootstrap')).tasks.find(t=>t.id===task.id);if(!['queued','running'].includes(terminal.status))break;await delay(10);}
      assert.equal(terminal.status,'completed',terminal.error);
      assert.equal(app.calls.at(-1).path,refs.length?'/v1/images/edits':'/v1/images/generations');
      assert.equal(app.calls.at(-1).body.size,size);
    }
  }
});
