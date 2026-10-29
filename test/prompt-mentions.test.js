import * as generationConfig from '../public/generation-config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import {imageRatios} from '../public/image-sizes.js';

test('image and video mentions filter current references and insert at the caret with keyboard, pointer and IME support',async()=>{
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const nodes=new Map(),calls=[],events={},caretRect={left:40,top:8,height:16};
  const document={body:node('body'),activeElement:null,querySelector:s=>node(s.slice(1)),querySelectorAll:()=>[],createElement:()=>({style:{},append(){},remove(){},getClientRects:()=>[caretRect],getBoundingClientRect:()=>({left:0,top:0})})};
  function node(id){
    if(!nodes.has(id))nodes.set(id,{
      id,value:'',innerHTML:'',textContent:'',hidden:true,maxLength:32000,selectionStart:0,selectionEnd:0,handlers:{},attrs:{},
      style:{},clientWidth:300,clientHeight:100,offsetWidth:96,offsetLeft:0,offsetTop:20,clientLeft:1,clientTop:1,scrollLeft:0,scrollTop:0,parentElement:{clientWidth:300},append(){},
      addEventListener(type,fn){this.handlers[type]=fn;},setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];},
      focus(){if(document.activeElement!==this){document.activeElement=this;this.handlers.focus?.();}},scrollIntoView(){},
      dispatchEvent(event){this.handlers[event.type]?.(event);},
      setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;},
    });
    return nodes.get(id);
  }
  const data={projects:[{id:'p1',name:'项目',canvas:{workflow:'confirmed-materials-v1',assetIds:['a1','a2']}}],shots:[],assets:[
    {id:'a1',projectId:'p1',kind:'image',name:'人物 <演员>.png',dataUrl:'/api/media/asset-a1'},
    {id:'a2',projectId:'p1',kind:'image',name:'风景.png',dataUrl:'/api/media/asset-a2'},
  ],results:[],tasks:[],models:{},providers:{},videoApiType:'openai'};
  const context=vm.createContext({generationConfig,projectVideos,setStableMarkup,renderVideoCards,imageRatios,document,Event,ResizeObserver:class{observe(){}},getComputedStyle:()=>({}),window:{location:{hash:'#/project/p1'},addEventListener(type,fn){(events[type]||=[]).push(fn);}},console,structuredClone,setTimeout(){},clearTimeout(){},bindSettings(){},fetch:async(path,options)=>{
    const body=options?.body?JSON.parse(options.body):null;calls.push({path,body});
    return {ok:true,json:async()=>structuredClone(path==='/api/shots'?{id:'s1',...body}:path==='/api/tasks'?{id:'t1',status:'queued',...body}:data)};
  }});
  const run=code=>vm.runInContext(code,context);
  run(script);await run('refresh()');run("addImageReference('a1');addImageReference('a2');chooseImage('a2');chooseImage('a1');");
  function type(id,value,caret=value.length){const input=node(id);document.activeElement=input;input.value=value;input.selectionStart=input.selectionEnd=caret;input.handlers.input();return input;}
  function key(input,key,extra={}){const event={key,prevented:false,preventDefault(){this.prevented=true;},...extra};input.handlers.keydown(event);return event;}
  const input=type('imagePrompt','让 @ 在海边',3),menu=node('imagePromptMentions');
  assert.equal(menu.hidden,false);assert.match(menu.innerHTML,/>图1</);assert.match(menu.innerHTML,/>图2</);
  assert.doesNotMatch(menu.innerHTML,/<img|<small|mention-heading|人物/);assert.equal(input.attrs['aria-expanded'],'true');
  assert.equal(menu.style.left,'41px');assert.equal(menu.style.top,'49px');
  caretRect.top=40;input.scrollTop=12;input.handlers.scroll();assert.equal(menu.style.top,'69px','follow the caret line and textarea scroll');
  caretRect.left=290;events.resize.forEach(fn=>fn());assert.equal(menu.style.left,'204px','keep the menu inside the field at its right edge');
  assert.equal(key(input,'ArrowDown').prevented,true);assert.equal(input.attrs['aria-activedescendant'],'imagePromptMention1');
  assert.equal(key(input,'Enter').prevented,true);assert.equal(input.value,'让 @图2 在海边');assert.equal(input.selectionStart,5);assert.equal(menu.hidden,true);
  assert.match(node('imagePromptHighlight').innerHTML,/让 <span class="prompt-mention-token" data-reference="2">@图2<\/span> 在海边/);
  assert.equal(node('imagePromptHighlight').scrollTop,input.scrollTop);
  type('imagePrompt','<img src=x> @图1 和@图12\n@图0 test@图2');
  assert.equal(node('imagePromptHighlight').innerHTML,'&lt;img src=x&gt; <span class="prompt-mention-token" data-reference="1">@图1</span> 和<span class="prompt-mention-token" data-reference="12">@图12</span>\n@图0 test@图2\u200b');
  type('imagePrompt','参考@风景');assert.doesNotMatch(menu.innerHTML,/>图1</);assert.match(menu.innerHTML,/>图2</);
  assert.match(menu.innerHTML,/data-reference="2"[^>]*>图2</,'filtering preserves the original reference color');
  assert.match(node('imageReferenceTray').innerHTML,/class="reference-number">图2</);
  key(input,'Tab');assert.equal(input.value,'参考@图2 ');
  type('imagePrompt','@1');key(input,'Enter');assert.equal(input.value,'@图1 ');
  type('imagePrompt','@');key(input,'ArrowUp');key(input,'Enter');assert.equal(input.value,'@图2 ');
  type('imagePrompt','@');key(input,'Escape');run('renderPrep()');assert.equal(menu.hidden,true,'polling must not reopen dismissed suggestions');
  type('imagePrompt','@不存在');assert.match(menu.innerHTML,/没有匹配/);assert.equal(key(input,'Enter').prevented,false);
  type('imagePrompt','hello@example');assert.equal(menu.hidden,true);
  type('imagePrompt','@');input.handlers.compositionstart();assert.equal(menu.hidden,true);
  assert.equal(key(input,'Enter',{isComposing:true}).prevented,false);assert.equal(input.value,'@');
  input.value='@图';input.selectionStart=input.selectionEnd=2;input.handlers.compositionend();assert.equal(menu.hidden,false);
  assert.equal(key(input,'Enter',{keyCode:229}).prevented,false);assert.equal(input.value,'@图');
  let prevented=false;menu.handlers.pointerdown({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  menu.handlers.click({target:{closest:()=>({dataset:{mentionIndex:'1'}})}});assert.equal(input.value,'@图2 ');
  type('imagePrompt','@');input.maxLength=2;key(input,'Enter');assert.equal(input.value,'@');assert.match(node('toast').textContent,/长度上限/);input.maxLength=32000;
  input.handlers.blur();assert.equal(menu.hidden,true);assert.equal(input.attrs['aria-activedescendant'],undefined);
  type('imagePrompt','@');run("removeImageReference('a1')");assert.match(menu.innerHTML,/>图1</);assert.doesNotMatch(menu.innerHTML,/>图2</);
  run("removeImageReference('a2')");assert.match(menu.innerHTML,/请先/);assert.equal(key(input,'Tab').prevented,false);
  run("addImageReference('a1');addImageReference('a2')");type('imagePrompt','@图2 保留背景');await run('generateImage()');
  const request=calls.filter(call=>call.path==='/api/tasks').at(-1).body;
  assert.equal(request.prompt,'@图2 保留背景');assert.deepEqual(request.referenceImageIds,['a1','a2']);
  const video=type('videoPrompt','@风景');assert.match(node('videoPromptMentions').innerHTML,/>图1</);key(video,'Enter');assert.equal(video.value,'@图1 ');
  assert.match(node('videoPromptHighlight').innerHTML,/<span class="prompt-mention-token" data-reference="1">@图1<\/span>/);
  node('videoFrameMode').value='frames';run('renderVideo()');assert.match(node('videoPicker').innerHTML,/图1 · 首帧/);assert.match(node('videoPicker').innerHTML,/图2 · 尾帧/);
  node('videoExternalImage').value='assetId://external';type('videoPrompt','@');assert.match(node('videoPromptMentions').innerHTML,/>图1</);assert.doesNotMatch(node('videoPromptMentions').innerHTML,/>图2<|<img/);
});

test('each of the nine supported references has a distinct readable foreground and background',async()=>{
  const css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
  const colors=[...css.matchAll(/\[data-reference="(\d+)"\]\{--reference-ink:(#[a-f0-9]{6});--reference-bg:(#[a-f0-9]{6})\}/g)];
  assert.deepEqual(colors.map(match=>Number(match[1])),[1,2,3,4,5,6,7,8,9]);
  assert.equal(new Set(colors.map(match=>match[2])).size,9);
  const luminance=hex=>hex.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  for(const [,number,ink,background] of colors)assert.ok((luminance(background)+.05)/(luminance(ink)+.05)>=4.5,'图'+number+' meets normal-text contrast');
});
