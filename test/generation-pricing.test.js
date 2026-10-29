import test from 'node:test';
import assert from 'node:assert/strict';
import * as generationConfig from '../public/generation-config.js';
import {videoRequest} from '../video-api.js';
import {startWorkflowServer} from './fixtures/workflow-server.js';

test('estimates use decimal unit prices and video requests enforce configured capabilities',()=>{
  const config={...generationConfig.defaults,OPENAI_IMAGE_PRICE:'0.1',VIDEO_PRICE_1080P:'0.1234',VIDEO_RESOLUTIONS:'1080p,4k',VIDEO_MAX_SECONDS:'12',VIDEO_API_TYPE:'openai'};
  assert.equal(generationConfig.formatPrice(generationConfig.estimate('image',{n:7},config)),'0.70');
  assert.equal(generationConfig.formatPrice(generationConfig.estimate('video',{duration:7,resolution:'1080p'},config)),'0.8638');
  assert.equal(generationConfig.estimate('image',{n:1},{OPENAI_IMAGE_PRICE:''}),null);
  assert.equal(generationConfig.estimate('image',{n:1},{OPENAI_IMAGE_PRICE:'0'}),0);
  assert.equal(generationConfig.estimate('video',{duration:7,resolution:'4k'},config),null);
  assert.throws(()=>videoRequest('test',null,{resolution:'720p'},config),/未.*启用/);
  assert.throws(()=>videoRequest('test',null,{duration:13,resolution:'1080p'},config),/1–12/);
  assert.throws(()=>videoRequest('test',null,{resolution:'1080p',videoSize:'720x1280'},config),/不匹配/);
  assert.equal(videoRequest('test',null,{resolution:'4k',ratio:'16:9'},config).body.size,'3840x2160');
  assert.equal(videoRequest('test',null,{resolution:'1080p'},{...config,VIDEO_API_TYPE:'volcengine'}).body.resolution,'1080p');
  const bounded={...config,VIDEO_MIN_SECONDS:'10',VIDEO_MAX_SECONDS:'30'};
  assert.equal(videoRequest('test',null,{resolution:'1080p'},bounded).body.seconds,'10');
  assert.throws(()=>videoRequest('test',null,{duration:9,resolution:'1080p'},bounded),/10–30/);
  assert.equal(videoRequest('test',null,{duration:30,resolution:'1080p'},{...bounded,VIDEO_API_TYPE:'kyyReactApi'}).body.duration,30);
  assert.equal(generationConfig.videoLimits({VIDEO_MAX_SECONDS:'60'}).max,30);
});

test('model prices and capabilities reach bootstrap, block invalid submissions, and preserve task price snapshots',async t=>{
  const app=await startWorkflowServer();t.after(app.stop);app.holdImages();
  const api=async(path,body,method=body?'POST':'GET',headers={})=>{
    const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json()};
  };
  const {settingsToken}= (await api('/api/settings')).value;
  const save=body=>api('/api/settings',body,'PUT',{'x-settings-token':settingsToken});
  assert.equal((await save({OPENAI_IMAGE_PRICE:'0.1',VIDEO_PRICE_1080P:'0.25',VIDEO_RESOLUTIONS:'1080p',VIDEO_MIN_SECONDS:'7',VIDEO_MAX_SECONDS:'10'})).status,200);
  assert.equal((await api('/api/bootstrap')).value.generation.VIDEO_RESOLUTIONS,'1080p');
  const project=(await api('/api/projects',{name:'计价测试'})).value;
  const shot=(await api('/api/shots',{projectId:project.id,name:'测试'})).value;
  const image=await api('/api/tasks',{shotId:shot.id,kind:'image',prompt:'seven',params:{n:7}});
  assert.equal(image.status,202);assert.equal(image.value.estimatedCost,7000);
  const video=await api('/api/tasks',{shotId:shot.id,kind:'video',prompt:'video',params:{resolution:'1080p',duration:8}});
  assert.equal(video.status,202);assert.equal(video.value.estimatedCost,20000);
  for(const params of [{resolution:'720p',duration:8},{resolution:'1080p',duration:11},{resolution:'1080p',duration:6}])assert.equal((await api('/api/tasks',{shotId:shot.id,kind:'video',prompt:'invalid',params})).status,400);
  await save({OPENAI_IMAGE_PRICE:'1',VIDEO_PRICE_1080P:'1'});
  const tasks=(await api('/api/bootstrap')).value.tasks;
  assert.equal(tasks.find(task=>task.id===image.value.id).estimatedCost,7000);
  assert.equal(tasks.find(task=>task.id===video.value.id).estimatedCost,20000);
});
