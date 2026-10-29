import * as generationConfig from '../public/generation-config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('settings mask existing keys without submitting the mask and retain replacement and clear actions',async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  for(const name of ['OPENAI_API_KEY','SEEDANCE_API_KEY'])assert.match(html,new RegExp('name="'+name+'" type="password"'));
  const script=(await readFile(new URL('../public/settings.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'').replace('export function','function');
  const nodes=new Map(),calls=[],state={};
  function node(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,style:{setProperty(name,value){this[name]=value;}},handlers:{},addEventListener(type,fn){this.handlers[type]=fn;},showModal(){},close(){this.handlers.close?.();},querySelectorAll(){return[];}});return nodes.get(id);}
  const values={...generationConfig.defaults,OPENAI_BASE_URL:'https://example.test/v1',OPENAI_IMAGE_MODEL:'image-model',OPENAI_IMAGE_MAX_COUNT:'7',SEEDANCE_BASE_URL:'https://example.test/v1',SEEDANCE_MODEL:'video-model',VIDEO_API_TYPE:'openai',PUBLIC_ASSET_BASE_URL:'',OPENAI_API_KEY_CONFIGURED:true,SEEDANCE_API_KEY_CONFIGURED:true,settingsToken:'test-token',OPENAI_API_KEY:'old-server-image-key',SEEDANCE_API_KEY:'old-server-video-key'};
  const form=node('settingsForm');form.elements=Object.fromEntries([...Object.keys(values),'CLEAR_OPENAI_API_KEY','CLEAR_SEEDANCE_API_KEY'].map(name=>[name,{value:'',checked:false}]));
  const supported=generationConfig.resolutions.map(value=>({value,checked:true}));
  form.querySelectorAll=selector=>selector==='[data-supported-resolution]'?supported:[];
  form.reset=()=>{for(const field of Object.values(form.elements)){field.value='';field.checked=false;}};
  nodes.set('videoApiType',form.elements.VIDEO_API_TYPE);form.elements.VIDEO_API_TYPE.addEventListener=()=>{};
  const context=vm.createContext({generationConfig,state,$:selector=>node(selector.slice(1)),document:{querySelectorAll:()=>[]},request:async(path,options)=>{calls.push({path,options});return values;},FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){for(const[name,field]of Object.entries(this.form.elements))yield[name,field.value];}}});
  vm.runInContext(script+'\nbindSettings({$,request,state,showToast(){},render(){},updateMode(){}});',context);
  await node('settingsButton').handlers.click();
  for(const name of ['OPENAI_API_KEY','SEEDANCE_API_KEY']){
    assert.equal(form.elements[name].value,'');assert.match(form.elements[name].placeholder,/\*{8}.*留空保留/);
  }
  await form.handlers.submit({preventDefault(){},currentTarget:form});
  let submitted=JSON.parse(calls.at(-1).options.body);
  assert.equal(submitted.OPENAI_IMAGE_MAX_COUNT,'7');assert.equal(state.imageMaxCount,7);
  assert.equal(submitted.VIDEO_RESOLUTIONS,'480p,720p,1080p,4k');
  assert.equal(node('videoMaxSecondsValue').textContent,'30 秒');
  assert.equal(node('videoMinSecondsValue').textContent,'1 秒');
  assert.equal(node('videoDurationBounds').style['--range-min'],'0%');assert.equal(node('videoDurationBounds').style['--range-max'],'100%');
  assert.equal(submitted.OPENAI_API_KEY,'');assert.equal(submitted.SEEDANCE_API_KEY,'');
  assert.doesNotMatch(calls.at(-1).options.body,/\*{8}|old-server-/);
  await node('settingsButton').handlers.click();form.elements.OPENAI_API_KEY.value='new-image-key';form.elements.CLEAR_SEEDANCE_API_KEY.checked=true;
  supported[0].checked=false;supported[3].checked=false;
  form.elements.OPENAI_IMAGE_PRICE.value='0.1';form.elements.VIDEO_PRICE_1080P.value='0.2';
  form.elements.VIDEO_MAX_SECONDS.value='12';node('videoMaxSeconds').handlers.input();
  assert.equal(node('videoMaxSecondsValue').textContent,'12 秒');
  form.elements.VIDEO_MIN_SECONDS.value='15';node('videoMinSeconds').handlers.input({target:form.elements.VIDEO_MIN_SECONDS});
  assert.equal(form.elements.VIDEO_MAX_SECONDS.value,'15');
  form.elements.VIDEO_MAX_SECONDS.value='12';node('videoMaxSeconds').handlers.input({target:form.elements.VIDEO_MAX_SECONDS});
  assert.equal(form.elements.VIDEO_MIN_SECONDS.value,'12');
  form.elements.VIDEO_MIN_SECONDS.value='5';node('videoMinSeconds').handlers.input({target:form.elements.VIDEO_MIN_SECONDS});
  assert.equal(node('videoDurationBounds').style['--range-min'],4/29*100+'%');assert.equal(node('videoDurationBounds').style['--range-max'],11/29*100+'%');
  await form.handlers.submit({preventDefault(){},currentTarget:form});submitted=JSON.parse(calls.at(-1).options.body);
  assert.equal(submitted.OPENAI_API_KEY,'new-image-key');assert.equal(submitted.SEEDANCE_API_KEY,'');assert.equal(submitted.CLEAR_SEEDANCE_API_KEY,true);
  assert.equal(submitted.VIDEO_RESOLUTIONS,'720p,1080p');assert.equal(submitted.OPENAI_IMAGE_PRICE,'0.1');assert.equal(submitted.VIDEO_PRICE_1080P,'0.2');assert.equal(submitted.VIDEO_MAX_SECONDS,'12');
  assert.equal(submitted.VIDEO_MIN_SECONDS,'5');
  assert.equal(form.elements.OPENAI_API_KEY.value,'','closing the dialog must clear the newly entered secret');
  assert.doesNotMatch(JSON.stringify(state),/old-server-|new-image-key/);
});
