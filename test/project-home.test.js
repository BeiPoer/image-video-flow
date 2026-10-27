import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {projectVideos} from '../public/video-confirmation.js';
import {setStableMarkup} from '../public/stable-render.js';
import {renderVideoCards} from './fixtures/render-dom.js';
import {imageRatios} from '../public/image-sizes.js';

test('home lists projects without auto-entering, project routes restore on reload and returning home preserves drafts',async()=>{
  const script=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'');
  const data={projects:[{id:'p1',name:'香氛项目',description:'广告短片',createdAt:'2026-10-25T01:00:00Z'},{id:'p2',name:'<测试项目>',createdAt:'2026-10-25T02:00:00Z'}],shots:[{id:'s1',projectId:'p1'}],assets:[{id:'a1',projectId:'p1',kind:'image',name:'图片',dataUrl:'data:image/png;base64,aA=='}],results:[],tasks:[{id:'t1',kind:'image',shotId:'s1',status:'running',createdAt:'2026-10-25T03:00:00Z'}],providers:{},models:{},videoApiType:'kyyReactApi'};
  function browser(hash=''){
    const nodes=new Map(),calls=[],events={},location={hash};
    const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',value:'',textContent:'',hidden:false,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},querySelector(){return node('submit');},reset(){this.wasReset=true;},closest(){return node('projectDialog');},showModal(){this.open=true;},close(){this.open=false;}});return nodes.get(id);};
    const history={pushState(a,b,url){location.hash=url;},replaceState(a,b,url){location.hash=url;}};
    const ctx=vm.createContext({projectVideos,setStableMarkup,renderVideoCards,imageRatios,document:{body:node('body'),querySelector:s=>node(s.slice(1)),querySelectorAll:()=>[]},window:{location,history,scrollTo(){},addEventListener(name,fn){events[name]=fn;}},console,structuredClone,setTimeout(){},clearTimeout(){},bindSettings(){},FormData:class{*[Symbol.iterator](){yield ['name','新建测试'];}},fetch:async(path,options)=>{
      const body=options?.body?JSON.parse(options.body):null;calls.push({path,body,method:options?.method});let result=data;
      if(path==='/api/projects'){result={id:'p3',...body};data.projects.unshift(result);}
      if(path.startsWith('/api/projects/')){data.projects.find(p=>p.id===path.split('/').pop()).canvas=structuredClone(body.canvas);result={ok:true};}
      return{ok:true,json:async()=>structuredClone(result)};
    }});
    vm.runInContext(script,ctx);return{ctx,node,calls,location,events};
  }
  const home=browser();await vm.runInContext('refresh()',home.ctx);
  assert.equal(home.node('homePage').hidden,false);assert.equal(home.node('workspacePage').hidden,true);
  assert.equal(home.node('historyButton').hidden,true);assert.equal(vm.runInContext('projectId',home.ctx),null);
  assert.match(home.node('homeProjectGrid').innerHTML,/香氛项目/);assert.match(home.node('homeProjectGrid').innerHTML,/&lt;测试项目&gt;/);assert.match(home.node('homeProjectGrid').innerHTML,/1 个任务生成中/);
  assert.ok(home.calls.every(c=>!c.method||c.method==='GET'),'opening home must not create projects');
  await vm.runInContext("setProject('p1')",home.ctx);
  assert.equal(home.location.hash,'#/project/p1');assert.equal(home.node('workspacePage').hidden,false);
  home.node('imagePrompt').value='未提交的图片描述';home.node('videoPrompt').value='未提交的视频描述';home.node('videoDuration').value='12';
  await vm.runInContext('setProject(null)',home.ctx);
  assert.equal(home.location.hash,'#/');assert.equal(home.node('homePage').hidden,false);
  await vm.runInContext('refresh()',home.ctx);assert.equal(vm.runInContext('projectId',home.ctx),null,'polling must not send home back into the first project');
  await vm.runInContext("setProject('p1')",home.ctx);
  assert.equal(home.node('imagePrompt').value,'未提交的图片描述');assert.equal(home.node('videoPrompt').value,'未提交的视频描述');assert.equal(home.node('videoDuration').value,'12');
  const reload=browser(home.location.hash);await vm.runInContext('refresh()',reload.ctx);assert.equal(vm.runInContext('projectId',reload.ctx),'p1');assert.equal(reload.node('homePage').hidden,true);
  const unknown=browser('#/project/missing');await vm.runInContext('refresh()',unknown.ctx);assert.equal(unknown.node('homePage').hidden,false);assert.equal(unknown.location.hash,'#/');
  const creating=browser();await vm.runInContext('refresh()',creating.ctx);creating.node('homeNewProjectButton').handlers.click();assert.equal(creating.node('projectDialog').open,true);
  await creating.node('projectForm').handlers.submit({preventDefault(){},currentTarget:creating.node('projectForm')});assert.equal(creating.location.hash,'#/project/p3');assert.equal(creating.node('workspacePage').hidden,false);
  data.projects=[];const empty=browser();await vm.runInContext('refresh()',empty.ctx);assert.equal(empty.node('homeEmpty').hidden,false);assert.equal(empty.node('homeProjectGrid').innerHTML,'');
});
