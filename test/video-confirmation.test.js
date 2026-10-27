import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startWorkflowServer} from './fixtures/workflow-server.js';
import {projectVideos} from '../public/video-confirmation.js';
import {videoFile,remoteVideo,downloadName} from '../video-download.js';

test('videos default to confirmed; removal/re-add persist, single downloads preserve the video bytes', {timeout:15000},async t=>{
  const app=await startWorkflowServer();t.after(app.stop);
  async function api(path,body,method=body?'POST':'GET',headers={}){const r=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;}
  const settings=await api('/api/settings');
  await api('/api/settings',{VIDEO_API_TYPE:'openai',SEEDANCE_BASE_URL:settings.OPENAI_BASE_URL},'PUT',{'x-settings-token':settings.settingsToken});
  const project=await api('/api/projects',{name:'确认视频测试'}),other=await api('/api/projects',{name:'其他项目'});
  async function generate(projectId,prompt){
    const shot=await api('/api/shots',{projectId,name:prompt});const task=await api('/api/tasks',{shotId:shot.id,kind:'video',prompt});
    for(let i=0;i<100;i++){const state=await api('/api/bootstrap'),current=state.tasks.find(t=>t.id===task.id);if(current.status==='completed')return state.results.find(r=>r.taskId===task.id);assert.notEqual(current.status,'failed',current.error);await delay(20);}
    assert.fail('video did not complete');
  }
  const first=await generate(project.id,'第一段'),second=await generate(project.id,'第二段');await generate(other.id,'另一个项目');
  let state=await api('/api/bootstrap');assert.equal(projectVideos(state,project.id).filter(r=>r.videoConfirmed!==false).length,2);
  await api('/api/results/'+first.id+'/video-confirmation',{confirmed:false},'PATCH');
  state=await api('/api/bootstrap');assert.equal(state.results.find(r=>r.id===first.id).videoConfirmed,false);
  assert.equal(projectVideos(state,project.id).filter(r=>r.videoConfirmed!==false).length,1);
  const disk=JSON.parse(await readFile(join(app.dir,'state.json'),'utf8'));assert.equal(disk.results.find(r=>r.id===first.id).videoConfirmed,false);
  assert.ok(state.results.some(r=>r.id===first.id),'removing confirmation must retain generated output');
  const page=await (await app.fetch(app.base+'/')).text();assert.doesNotMatch(page,/downloadConfirmedVideos|全部下载 ZIP/);
  const single=await app.fetch(app.base+'/api/results/'+second.id+'/download');assert.equal(single.headers.get('content-type'),'video/mp4');assert.match(single.headers.get('content-disposition'),/attachment;.*filename\*/);assert.equal(await single.text(),'123456789');
  await api('/api/results/'+first.id+'/video-confirmation',{confirmed:true},'PATCH');
  assert.equal(projectVideos(await api('/api/bootstrap'),project.id).filter(r=>r.videoConfirmed!==false).length,2);
  for(const result of [first,second])await api('/api/results/'+result.id+'/video-confirmation',{confirmed:false},'PATCH');
  assert.equal((await app.fetch(app.base+'/api/projects/'+project.id+'/confirmed-videos/download')).status,404);
  assert.equal((await app.fetch(app.base+'/api/results/missing/download')).status,404);
  assert.equal((await app.fetch(app.base+'/api/results/'+first.id+'/video-confirmation',{method:'PATCH',headers:{'content-type':'application/json'},body:'{"confirmed":"false"}'})).status,400);
});

test('remote downloads reject private URLs and cached files preserve exact bytes',async()=>{
  for(const url of ['http://example.com/video.mp4','https://127.0.0.1/x','https://169.254.169.254/x','https://[::1]/x','https://user:pass@example.com/x'])await assert.rejects(remoteVideo(url));
  const dir=await mkdtemp(join(tmpdir(),'ai-flow-video-download-'));
  try{
    let requests=0;const source={dataUrl:'https://video.example/test.mp4'};
    const open=async()=>{requests++;return Readable.from([Buffer.from('1234'),Buffer.from('56789')]);};
    const [a,b]=await Promise.all([videoFile(source,dir,open),videoFile(source,dir,open)]);assert.equal(a.path,b.path);assert.equal(requests,1);
    await videoFile(source,dir,open);assert.equal(requests,1);
    assert.equal((await readFile(a.path)).toString(),'123456789');
    await assert.rejects(videoFile({dataUrl:'https://video.example/bad.mp4'},dir,async()=>Readable.from([])));
    assert.equal((await readdir(join(dir,'video-downloads'))).filter(name=>name.endsWith('.tmp')).length,0);
    assert.doesNotMatch(downloadName('../bad\r\nname'),/[\/\\\r\n]/);
  }finally{
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+(process.platform==='win32'?'\\':'/')+'ai-flow-video-download-'));
    await rm(dir,{recursive:true,force:true});
  }
});
