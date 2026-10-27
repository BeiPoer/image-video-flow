import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkflowServer, png } from './fixtures/workflow-server.js';

test('uploaded and generated images feed real multipart image edits and subsequent video tasks', {timeout:15000}, async t => {
  const app=await startWorkflowServer();t.after(app.stop);
  async function api(path, body, method=body?'POST':'GET') {
    const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json()};
  }
  async function run(body) {
    const submitted=await api('/api/tasks',body);assert.equal(submitted.status,202,JSON.stringify(submitted.value));
    for(let i=0;i<120;i++) {
      const data=(await api('/api/bootstrap')).value,task=data.tasks.find(task=>task.id===submitted.value.id);
      if(!['queued','running'].includes(task.status)) return {task,data,result:data.results.find(result=>result.taskId===task.id)};
      await delay(20);
    }
    assert.fail('task timed out');
  }
  const project=(await api('/api/projects',{name:'连续创作'})).value;
  const shot=(await api('/api/shots',{projectId:project.id,name:'素材创作'})).value;
  const source='data:image/png;base64,'+png;
  const asset=(await api('/api/assets',{name:'参考原图.png',kind:'image',mime:'image/png',dataUrl:source})).value;
  const text=await run({shotId:shot.id,kind:'image',prompt:'文字生图'});
  assert.equal(text.task.status,'completed');
  assert.equal(app.calls.at(-1).path,'/v1/images/generations');
  const first=await run({shotId:shot.id,kind:'image',prompt:'保留主体，更换背景',referenceImageIds:[asset.id],params:{size:'1024x1024'}});
  assert.equal(first.task.status,'completed',first.task.error);
  const edit=app.calls.at(-1);
  assert.equal(edit.path,'/v1/images/edits');assert.match(edit.type,/multipart\/form-data; boundary=/);
  assert.equal(edit.body.model,'gpt-image-2');assert.equal(edit.body.prompt,'保留主体，更换背景');
  assert.equal(edit.body.images.length,1);assert.equal(edit.body.images[0].mime,'image/png');
  assert.deepEqual(edit.body.images[0].bytes,Buffer.from(png,'base64'));
  const next=await run({shotId:shot.id,kind:'image',prompt:'继续调整灯光',referenceImageIds:[first.result.id,asset.id]});
  assert.equal(next.task.status,'completed');assert.equal(app.calls.at(-1).body.images.length,2);
  assert.equal(next.data.shots.find(item=>item.id===shot.id).selectedImageId,next.result.id);
  for(const imageId of [asset.id,next.result.id]) {
    const selected=await api('/api/shots/'+shot.id,{selectedImageId:imageId},'PATCH');assert.equal(selected.status,200);
    assert.equal((await api('/api/assets/'+asset.id,undefined,'DELETE')).status,imageId===asset.id?409:200);
    const video=await run({shotId:shot.id,kind:'video',prompt:'镜头缓慢推近',inputImageId:imageId});
    assert.equal(video.task.status,'completed',video.task.error);
    assert.equal(app.calls.at(-1).body.content[1].image_url.url,source);
  }
  assert.equal((await api('/api/tasks',{shotId:shot.id,kind:'image',prompt:'bad',referenceImageIds:['missing']})).status,400);
  assert.equal((await api('/api/tasks',{shotId:shot.id,kind:'image',prompt:'bad',referenceImageIds:Array(9).fill(first.result.id)})).status,400);
  assert.equal((await api('/api/shots/'+shot.id,{selectedImageId:'missing'},'PATCH')).status,400);
  app.rejectEdits=true; const before=app.calls.length;
  const failed=await run({shotId:shot.id,kind:'image',prompt:'fail',referenceImageIds:[first.result.id]});
  assert.equal(failed.task.status,'failed');assert.match(failed.task.error,/参考图生图失败/);
  assert.equal(app.calls.length,before+1,'never silently retry as text-only generation');
  assert.equal(failed.data.results.some(item=>item.id===first.result.id),true);
});
