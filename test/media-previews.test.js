import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createMediaPreviews} from '../media-previews.js';
import {startWorkflowServer} from './fixtures/workflow-server.js';
import {setTimeout as delay} from 'node:timers/promises';

const createdAt = new Date().toISOString();
const record = id => ({id, kind:'image', createdAt, dataUrl:'data:image/png;base64,eA=='});
async function directory() {
  await mkdir('data-test', {recursive:true});
  return mkdtemp(join('data-test','previews-'));
}

test('preview cache deduplicates requests, survives restart and limits decoding to two jobs', async () => {
  const dir = await directory();
  let active=0, peak=0, calls=0;
  const render=async () => {
    calls++;active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,15));
    active--;return Buffer.from('thumbnail');
  };
  const cache=createMediaPreviews(dir,render);
  const first=record('asset-one');
  await Promise.all([cache.get(first),cache.get(first),...Array.from({length:6},(_,i)=>cache.get(record('asset-'+i)))]);
  assert.equal(calls,7);assert.equal(peak,2);
  assert.equal((await createMediaPreviews(dir,()=>{throw Error('must use disk');}).get(first)).toString(),'thumbnail');
  assert.equal((await readdir(join(dir,'previews'))).length,7);
  await assert.rejects(cache.get({...first,deletedAt:createdAt}),{status:410});
  await assert.rejects(cache.get({...first,id:'../outside'}),{status:415});
});

test('failed decodes are throttled and never fall back to the original media', async () => {
  let calls=0;
  const cache=createMediaPreviews(await directory(),async()=>{calls++;throw Error('bad media');});
  const item=record('asset-broken');
  const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}});
  for(let i=0;i<2;i++){
    const res=response();await cache.serve({method:'GET'},res,item);
    assert.equal(res.headers['cache-control'],'no-store');
    assert.match(res.body.toString(),/预览暂不可用/);
    assert.doesNotMatch(res.body.toString(),/data:image|asset-broken/);
  }
  assert.equal(calls,1);
});

test('background warmup shares the display job, skips audio and absorbs preview failures', async () => {
  let calls=0, release;
  const gate=new Promise(resolve=>{release=resolve;});
  const cache=createMediaPreviews(await directory(),async()=>{calls++;await gate;return Buffer.from('preview');});
  const item=record('asset-warm');
  const background=cache.warm(item),display=cache.get(item);
  release();
  assert.equal(await background,true);
  assert.equal((await display).toString(),'preview');assert.equal(calls,1);
  assert.equal(await cache.warm({...item,kind:'audio'}),false);assert.equal(calls,1);
  const failing=createMediaPreviews(await directory(),async()=>{throw Error('decode failed');});
  assert.equal(await failing.warm(record('asset-invalid')),false);
});

test('real HTTP thumbnails preserve originals, resize images, extract first video frame and cache privately', async t => {
  const original=await sharp({create:{width:1600,height:900,channels:3,background:'#e32a1b'}}).png().toBuffer();
  const {stdout:video}=await promisify(execFile)(process.env.FFMPEG_PATH||ffmpeg,[
    '-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=640x360:r=10',
    '-t','0.2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',
    '-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1',
  ],{encoding:'buffer',maxBuffer:1024*1024,timeout:30000,windowsHide:true});
  const asset={...record('asset-photo'),name:'照片',projectId:'project-p',dataUrl:'data:image/png;base64,'+original.toString('base64')};
  const clip={...record('result-video'),kind:'video',shotId:'shot-s',dataUrl:'data:video/mp4;base64,'+video.toString('base64')};
  const remote={...asset,id:'asset-remote',dataUrl:'https://unavailable.invalid/original.png'};
  // Preserve fixture files: this workspace requires confirmation before deleting files.
  const app=await startWorkflowServer({projects:[{id:'project-p'}],shots:[{id:'shot-s',projectId:'project-p'}],assets:[asset,remote],results:[clip],tasks:[]},{},{keepFiles:true,imageBase64:original.toString('base64'),videoBytes:video});
  t.after(app.stop);
  const bootstrap=await (await app.fetch(app.base+'/api/bootstrap')).json();
  assert.equal(bootstrap.assets[0].thumbnailUrl,'/api/thumbnails/asset-photo');
  assert.doesNotMatch(JSON.stringify(bootstrap),/base64,/);
  assert.equal(bootstrap.assets[1].dataUrl,remote.dataUrl);
  assert.ok(!(await readdir(app.dir)).includes('original-images'));
  assert.equal((await fetch(app.base+bootstrap.assets[0].thumbnailUrl)).status,401);
  for(const item of [bootstrap.assets[0],bootstrap.results[0]]){
    const response=await app.fetch(app.base+item.thumbnailUrl);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');
    assert.match(response.headers.get('cache-control'),/^private, max-age=\d+$/);
    const bytes=Buffer.from(await response.arrayBuffer()),meta=await sharp(bytes).metadata();
    assert.equal(meta.width,480);assert.equal(meta.height,270);
    const {data}=await sharp(bytes).raw().toBuffer({resolveWithObject:true});
    assert.ok(data[0]>180&&data[1]<80&&data[2]<80,'thumbnail must contain the red image/first frame');
    const again=await app.fetch(app.base+item.thumbnailUrl);
    assert.deepEqual(Buffer.from(await again.arrayBuffer()),bytes);
    const head=await app.fetch(app.base+item.thumbnailUrl,{method:'HEAD'});
    assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal(await head.text(),'');
    const full=await app.fetch(app.base+item.dataUrl);
    if(item.kind==='image')assert.match(full.headers.get('cache-control'),/^private, max-age=[1-9]\d*$/);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),item.kind==='video'?video:original);
  }
  const uploaded=await (await app.fetch(app.base+'/api/assets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'新上传',kind:'image',dataUrl:asset.dataUrl})})).json();
  assert.match(uploaded.thumbnailUrl,/^\/api\/thumbnails\/asset-/);
  assert.doesNotMatch(uploaded.dataUrl,/^data:/);
  async function waitForPreview(id) {
    for(let i=0;i<100;i++){
      try { return await readFile(join(app.dir,'previews',id+'.webp')); }
      catch(err){if(err.code!=='ENOENT')throw err;}
      await delay(30);
    }
    assert.fail('background preview was not written: '+id);
  }
  // Check the disk without ever requesting these thumbnail URLs.
  assert.equal((await sharp(await waitForPreview(uploaded.id)).metadata()).format,'webp');
  async function api(path,body,method='POST',headers={}) {
    const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
  }
  const uploadedVideo=await api('/api/assets',{name:'上传视频',kind:'video',dataUrl:clip.dataUrl});
  assert.equal((await sharp(await waitForPreview(uploadedVideo.id)).metadata()).format,'webp');
  const settings=await api('/api/settings',null,'GET');
  await api('/api/settings',{VIDEO_API_TYPE:'openai',SEEDANCE_BASE_URL:settings.OPENAI_BASE_URL},'PUT',{'x-settings-token':settings.settingsToken});
  for(const kind of ['image','video']){
    const task=await api('/api/tasks',{shotId:'shot-s',kind,prompt:'预生成测试',...(kind==='image'?{params:{n:2}}:{})});
    let results;
    for(let i=0;i<100;i++){
      const state=await api('/api/bootstrap',null,'GET'),current=state.tasks.find(item=>item.id===task.id);
      assert.notEqual(current.status,'failed',current.error);
      if(current.status==='completed'){results=state.results.filter(item=>item.taskId===task.id);break;}
      await delay(30);
    }
    assert.equal(results?.length,kind==='image'?2:1);
    for(const result of results)assert.equal((await sharp(await waitForPreview(result.id)).metadata()).format,'webp');
  }
  const invalid=await api('/api/assets',{name:'无法解码',kind:'image',dataUrl:'data:image/png;base64,YWJj'});
  await delay(100);
  assert.ok((await api('/api/bootstrap',null,'GET')).assets.some(item=>item.id===invalid.id),'failed preview must not undo successful upload');
  assert.equal((await app.fetch(app.base+'/api/thumbnails/asset-missing')).status,404);
  assert.equal((await app.fetch(app.base+'/api/thumbnails/asset-photo',{method:'POST'})).status,404);
  assert.equal((await readFile(join(app.dir,'previews','asset-photo.webp'))).length>0,true);
});
