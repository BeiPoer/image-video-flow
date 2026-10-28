import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {imageRatios} from '../public/image-sizes.js';

test('video choices are inline radios; duration slider and number stay synchronized and respect protocol limits',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const options=html.slice(html.indexOf('id="videoOptions"'),html.indexOf('<details class="advanced-video">'));
  assert.doesNotMatch(options,/<select/);assert.match(options,/type="range"/);
  for(const field of ['videoRatio','videoResolution','videoFrameMode','videoSize'])assert.ok(options.includes(`data-video-option="${field}"`));
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',handlers:{},hidden:false,addEventListener(type,fn){this.handlers[type]=fn;}});return nodes.get(id);};
  node('videoDuration').value='6';node('videoDurationRange').value='6';
  const data={projects:[],shots:[],assets:[],results:[],tasks:[],models:{},providers:{},videoApiType:'kyyReactApi'};
  const context=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,document:{body:node('body'),querySelector:s=>node(s.slice(1)),querySelectorAll:()=>[]},window:{addEventListener(){}},console,structuredClone,setTimeout(){},clearTimeout(){},bindSettings(){},fetch:async()=>({ok:true,json:async()=>structuredClone(data)})});
  vm.runInContext(script,context);await vm.runInContext('refresh()',context);
  assert.equal(node('videoDurationRange').min,'4');assert.equal(node('videoDurationRange').max,'15');
  node('videoDurationRange').value='12';node('videoDurationRange').handlers.input();assert.equal(node('videoDuration').value,'12');
  node('videoDuration').value='9';node('videoDuration').handlers.input();assert.equal(node('videoDurationRange').value,'9');
  node('videoDuration').value='';node('videoDuration').handlers.input();vm.runInContext('render()',context);assert.equal(node('videoDuration').value,'','polling must not interrupt an unfinished edit');
  node('videoDuration').handlers.change();assert.equal(node('videoDuration').value,'9');
  node('videoDuration').value='99';node('videoDuration').handlers.change();assert.equal(node('videoDuration').value,'15');
  node('videoDuration').value='2';node('videoDuration').handlers.change();assert.equal(node('videoDuration').value,'4');
  node('videoDuration').value='6.4';node('videoDuration').handlers.change();assert.equal(node('videoDuration').value,'6');
  for(const [field,value] of [['videoRatio','16:9'],['videoResolution','1080p'],['videoFrameMode','frames'],['videoSize','1280x720']]){
    node('videoOptions').handlers.change({target:{dataset:{videoOption:field},value}});
    assert.equal(node(field).value,value);
  }
  vm.runInContext("state.videoApiType='openai';updateVideoMode()",context);
  assert.equal(node('videoRatioWrap').hidden,true);assert.equal(node('videoSizeWrap').hidden,false);assert.equal(node('videoDurationRange').max,'60');
  node('videoDuration').value='40';node('videoDuration').handlers.input();assert.equal(node('videoDurationRange').value,'40');
  vm.runInContext("state.videoApiType='kyyReactApi';updateVideoMode()",context);
  assert.equal(node('videoDuration').value,'15');assert.equal(node('videoDurationRange').value,'15');
  vm.runInContext("state.videoApiType='openai';state.assets=Array.from({length:10},(_,i)=>({id:'a'+i,kind:'image',name:'图'+i,dataUrl:'data:image/png;base64,YQ=='}));confirmedIds=state.assets.map(item=>item.id);selectedImageIds=[];updateVideoMode()",context);
  assert.equal(node('videoFrameModeWrap').hidden,false);
  node('videoFrameMode').value='reference';
  vm.runInContext("for(const item of state.assets)chooseImage(item.id)",context);
  assert.equal(vm.runInContext('selectedImageIds.length',context),9);
  assert.match(node('toast').textContent,/最多添加 9 张/);
  node('videoFrameMode').value='frames';vm.runInContext("selectedImageIds=[];chooseImage('a0');chooseImage('a1');chooseImage('a2')",context);
  assert.equal(vm.runInContext('selectedImageIds.length',context),2);
  assert.match(node('toast').textContent,/最多添加 2 张/);
  assert.match(node('videoPicker').innerHTML,/首帧/);assert.match(node('videoPicker').innerHTML,/尾帧/);
});
