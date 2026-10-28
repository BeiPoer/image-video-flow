import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import {imageRatios} from '../public/image-sizes.js';

test('expired images and videos retain placeholders, clear drafts and previews, and cannot be reused or downloaded',async()=>{
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const nodes=new Map(),calls=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,handlers:{},classList:{add(){},remove(){},toggle(){}},addEventListener(type,fn){this.handlers[type]=fn;},showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();},removeAttribute(name){delete this[name];}});return nodes.get(id);}
  const data={projects:[{id:'p',canvas:{workflow:'confirmed-materials-v1',assetIds:['a'],positions:{},viewport:{x:0,y:0,zoom:1}}}],shots:[{id:'s',projectId:'p'}],assets:[{id:'a',projectId:'p',kind:'image',name:'上传图片',dataUrl:'data:image/png;base64,YQ=='}],results:[{id:'i',shotId:'s',taskId:'ti',kind:'image',name:'生成图片',dataUrl:'data:image/png;base64,Yg=='},{id:'v',shotId:'s',taskId:'tv',kind:'video',name:'生成视频',provider:'openai',dataUrl:'https://example.test/video.mp4'}],tasks:[{id:'ti',shotId:'s',kind:'image',status:'completed'},{id:'tv',shotId:'s',kind:'video',status:'completed'}],models:{},providers:{},videoApiType:'openai'};
  const context=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,structuredClone,console,setTimeout(){},clearTimeout(){},bindSettings(){},document:{body:node('body'),querySelector:selector=>node(selector.slice(1)),querySelectorAll:()=>[]},window:{location:{hash:'#/project/p'},addEventListener(){}},fetch:async(path,options)=>{calls.push({path,options});return{ok:true,json:async()=>structuredClone(data)};}});
  vm.runInContext(script,context);await vm.runInContext('refresh()',context);
  vm.runInContext("addImageReference('a');chooseImage('a');openImagePreview('a')",context);
  assert.equal(node('imagePreviewDialog').open,true);
  for(const record of [...data.assets,...data.results]){record.deletedAt=new Date().toISOString();delete record.dataUrl;}
  await vm.runInContext('refresh()',context);
  for(const id of ['uploadedMaterials','generatedMaterials','confirmedGrid','videoResults','confirmedVideos']){
    assert.match(node(id).innerHTML,/已删除/);assert.doesNotMatch(node(id).innerHTML,/<img|<video|draggable="true"/);
  }
  assert.doesNotMatch(node('uploadedMaterials').innerHTML,/data-action="use-image"|data-action="confirm"/);
  assert.match(node('confirmedVideos').innerHTML,/data-download-video="v" disabled/);
  assert.doesNotMatch(node('videoResults').innerHTML,/data-confirm-video=/);
  assert.equal(node('imagePreviewDialog').open,false);assert.equal(node('imagePreviewFull').src,undefined);
  assert.equal(vm.runInContext('imageReferenceIds.length+selectedImageIds.length',context),0);
  const previousCalls=calls.length;
  await vm.runInContext("addImageReference('a');chooseImage('a');downloadVideo('v')",context);
  assert.equal(calls.length,previousCalls);assert.equal(vm.runInContext('imageReferenceIds.length+selectedImageIds.length',context),0);
  assert.equal(projectVideos(data,'p').length,1,'confirmed video tombstone must remain visible');
});
