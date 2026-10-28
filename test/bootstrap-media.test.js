import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startWorkflowServer,png} from './fixtures/workflow-server.js';
import {retentionMs} from '../media-retention.js';

test('bootstrap excludes inline media and copied task inputs; authenticated media requests preserve original bytes and ranges',async t=>{
  const bytes=Buffer.alloc(2*1024*1024,123),source='data:image/png;base64,'+bytes.toString('base64'),createdAt=new Date().toISOString();
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><text>demo</text></svg>';
  const state={projects:[{id:'p',name:'项目'}],shots:[{id:'s',projectId:'p'}],assets:[
    {id:'asset-large',projectId:'p',kind:'image',name:'原图',createdAt,dataUrl:source},
    {id:'asset-audio',kind:'audio',createdAt,dataUrl:'data:audio/mpeg;base64,YWJjZGU='},
    {id:'asset-video',kind:'video',createdAt,dataUrl:'data:video/mp4;base64,YWJjZGU='},
    {id:'asset-expired',kind:'image',createdAt:new Date(Date.now()-retentionMs-1000).toISOString(),dataUrl:source},
    {id:'asset-html',kind:'image',createdAt,dataUrl:'data:text/html;base64,PGgxPmJhZDwvaDE+'},
  ],results:[
    {id:'result-image',shotId:'s',kind:'image',createdAt,dataUrl:'data:image/png;base64,'+png},
    {id:'result-demo',shotId:'s',kind:'image',provider:'local-demo',createdAt,dataUrl:'data:image/svg+xml,'+encodeURIComponent(svg)},
    {id:'result-remote',shotId:'s',kind:'video',createdAt,dataUrl:'https://example.test/remote.mp4'},
  ],tasks:[{id:'task-old',shotId:'s',kind:'video',status:'completed',createdAt,inputImageUrl:source,params:{duration:8,referenceImages:[source],referenceVideos:[source],referenceAudios:[source],firstImage:source,lastImage:source,videoMedia:{referenceImageIds:['asset-large']}}}]};
  const app=await startWorkflowServer(state);t.after(app.stop);
  const text=await (await app.fetch(app.base+'/api/bootstrap')).text();
  assert.ok(Buffer.byteLength(text)<10000,'bootstrap must remain small even with multi-megabyte media');
  assert.doesNotMatch(text,/data:image\/|base64,/);
  const payload=JSON.parse(text),asset=payload.assets[0];
  assert.equal(asset.dataUrl,'/api/media/asset-large');assert.equal(asset.mime,'image/png');assert.equal(asset.name,'原图');
  assert.equal(payload.tasks[0].inputImageUrl,undefined);assert.deepEqual(payload.tasks[0].params,{duration:8,videoMedia:{referenceImageIds:['asset-large']}});
  assert.equal(payload.results[2].dataUrl,'https://example.test/remote.mp4');
  assert.equal((await fetch(app.base+asset.dataUrl)).status,401);
  const image=await app.fetch(app.base+asset.dataUrl);
  assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
  const head=await app.fetch(app.base+asset.dataUrl,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal(await head.text(),'');
  const generated=await app.fetch(app.base+payload.results[0].dataUrl);assert.deepEqual(Buffer.from(await generated.arrayBuffer()),Buffer.from(png,'base64'));
  const demo=await app.fetch(app.base+payload.results[1].dataUrl);assert.equal(await demo.text(),svg);assert.match(demo.headers.get('content-security-policy'),/sandbox/);
  for(const name of ['audio','video']){
    const range=await app.fetch(app.base+'/api/media/asset-'+name,{headers:{range:'bytes=1-3'}});
    assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 1-3/5');assert.equal(await range.text(),'bcd');
    assert.equal((await app.fetch(app.base+'/api/media/asset-'+name,{headers:{range:'bytes=9-'}})).status,416);
  }
  assert.equal((await app.fetch(app.base+'/api/media/asset-expired')).status,410);
  assert.equal((await app.fetch(app.base+'/api/media/asset-missing')).status,404);
  assert.equal((await app.fetch(app.base+'/api/media/asset-html')).status,415);
  assert.equal((await app.fetch(app.base+'/api/media/asset-large',{method:'POST'})).status,404);
  const stored=JSON.parse(await readFile(join(app.dir,'state.json'),'utf8'));
  assert.equal(stored.assets[0].dataUrl,source);assert.equal(stored.tasks[0].inputImageUrl,source,'display serialization must not change provider inputs');
});
