import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startWorkflowServer} from './fixtures/workflow-server.js';
import {taskSources} from '../public/canvas-model.js';
import {retentionMs} from '../media-retention.js';

test('OpenAI video media IDs reach the provider as all references or ordered frames; invalid selections never submit',async t=>{
  const initial={projects:[],shots:[],tasks:[],results:[],assets:[{id:'asset-expired',kind:'image',createdAt:new Date(Date.now()-retentionMs-1000).toISOString(),dataUrl:'data:image/png;base64,YQ=='}]};
  const app=await startWorkflowServer(initial);t.after(app.stop);
  async function api(path,body,method=body?'POST':'GET',headers={}){
    const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json()};
  }
  const settings=(await api('/api/settings')).value;
  assert.equal((await api('/api/settings',{VIDEO_API_TYPE:'openai',SEEDANCE_BASE_URL:settings.OPENAI_BASE_URL},'PUT',{'x-settings-token':settings.settingsToken})).status,200);
  const project=(await api('/api/projects',{name:'多图视频'})).value,shot=(await api('/api/shots',{projectId:project.id,name:'镜头'})).value;
  const assets=[];
  for(let i=0;i<10;i++)assets.push((await api('/api/assets',{name:'image-'+i,kind:'image',projectId:project.id,dataUrl:'data:image/png;base64,'+Buffer.from('image-'+i).toString('base64')})).value);
  async function generate(videoMedia,params={}){
    const response=await api('/api/tasks',{shotId:shot.id,kind:'video',prompt:'test multiple references',videoMedia,params});assert.equal(response.status,202,JSON.stringify(response.value));
    for(let i=0;i<100;i++){
      const current=(await api('/api/bootstrap')).value.tasks.find(task=>task.id===response.value.id);
      if(current.status==='completed')return current;
      assert.notEqual(current.status,'failed',current.error);await delay(20);
    }
    assert.fail('video did not complete');
  }
  const ids=assets.slice(0,9).map(asset=>asset.id),task=await generate({referenceImageIds:ids});
  let submitted=app.calls.filter(call=>call.path==='/v1/videos');
  assert.equal(submitted.length,1);assert.deepEqual(submitted[0].body.metadata.content.map(item=>item.image_url.url),assets.slice(0,9).map(asset=>asset.dataUrl));
  assert.ok(submitted[0].body.metadata.content.every(item=>item.role==='reference_image'));
  assert.deepEqual(taskSources(task),ids);assert.deepEqual(task.params.videoMedia.referenceImageIds,ids);
  await generate({firstImageId:assets[1].id,lastImageId:assets[0].id});
  submitted=app.calls.filter(call=>call.path==='/v1/videos');assert.equal(submitted.length,2);
  assert.deepEqual(submitted[1].body.metadata.content,[{type:'image_url',image_url:{url:assets[1].dataUrl},role:'first_frame'},{type:'image_url',image_url:{url:assets[0].dataUrl},role:'last_frame'}]);
  const before=app.calls.length;
  for(const media of [{referenceImageIds:assets.map(asset=>asset.id)},{referenceImageIds:[assets[0].id],firstImageId:assets[1].id},{lastImageId:assets[0].id},{referenceImageIds:['missing']}]){
    const rejected=await api('/api/tasks',{shotId:shot.id,kind:'video',prompt:'invalid',videoMedia:media});assert.ok([400,404].includes(rejected.status),JSON.stringify(rejected));
  }
  assert.equal((await api('/api/tasks',{shotId:shot.id,kind:'video',prompt:'expired',videoMedia:{referenceImageIds:['asset-expired']}})).status,410);
  assert.equal(app.calls.length,before,'validation failures must never contact the paid provider');
});
