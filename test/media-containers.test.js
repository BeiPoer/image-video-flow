import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('media containers cap actual rows at four, collapse independently, and keep hidden cards out of keyboard navigation', async()=>{
  const script=await readFile(new URL('../public/media-containers.js',import.meta.url),'utf8');
  const containers=['images','videos'].map(id=>({id,style:{},scrollTop:200,children:Array.from({length:10},(_,index)=>({offsetTop:100+Math.floor(index/2)*120,offsetHeight:index%2?100:90})),getClientRects:()=>[{}],toggleAttribute(name,value){this[name]=value;}}));
  const buttons=containers.map(()=>({attributes:{},addEventListener(type,handler){this[type]=handler;},setAttribute(name,value){this.attributes[name]=value;}}));
  const resizes=[],mutations=[];
  let pending;
  const context=vm.createContext({document:{querySelectorAll:()=>containers,querySelector:selector=>buttons[selector.includes('images')?0:1]},getComputedStyle:()=>({paddingTop:'12px',paddingBottom:'12px',borderTopWidth:'1px',borderBottomWidth:'1px'}),requestAnimationFrame(callback){pending=callback;return 1;},cancelAnimationFrame(){},ResizeObserver:class{constructor(callback){resizes.push(callback);}observe(){}disconnect(){}},MutationObserver:class{constructor(callback){mutations.push(callback);}observe(){}}});
  vm.runInContext(script,context);
  for(const callback of resizes){callback();pending();}
  assert.equal(containers[0].style.maxHeight,'487px');
  assert.equal(containers[1].style.maxHeight,'487px');
  buttons[0].click();
  assert.equal(containers[0].style.maxHeight,'127px');assert.equal(containers[0].scrollTop,0);
  assert.equal(buttons[0].attributes['aria-expanded'],'false');assert.equal(buttons[0].textContent,'展开素材');
  assert.equal(containers[0].children.filter(child=>!child.inert).length,2);
  assert.equal(containers[1].style.maxHeight,'487px','other containers stay expanded');
  containers[0].children.push({offsetTop:700,offsetHeight:100});mutations[0]();pending();
  assert.equal(containers[0].children.at(-1).inert,true,'new results respect the collapsed state');
  buttons[0].click();assert.equal(containers[0].style.maxHeight,'487px');
  assert.ok(containers[0].children.every(child=>!child.inert));
  containers[0].children.forEach((child,index)=>{child.offsetTop=100+index*120;});resizes[0]();pending();
  assert.equal(containers[0].style.maxHeight,'487px','narrow layouts still show four rows');
  containers[0].children=containers[0].children.slice(0,1);mutations[0]();pending();
  assert.equal(buttons[0].hidden,true);assert.equal(containers[0].style.maxHeight,'');
  containers[0].children=[];mutations[0]();pending();assert.equal(containers[0].style.maxHeight,'');
});
