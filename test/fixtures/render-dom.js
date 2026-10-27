import {renderVideoCards as renderCards} from '../../public/stable-render.js';

export function createRenderElement() {
  const element={children:[],dataset:{},writes:0,moves:0,ownerDocument:{createElement:createRenderElement}};
  let html='';
  Object.defineProperty(element,'innerHTML',{
    get(){return this.children.length?this.children.map(child=>child.innerHTML).join(''):html;},
    set(value){html=value;this.children=[];this.writes++;this.player=value.includes('<video')?{currentTime:0}:null;},
  });
  element.insertBefore=function(child,before){
    child.remove();const index=before?this.children.indexOf(before):this.children.length;
    this.children.splice(index,0,child);child.parent=this;this.moves++;
  };
  element.remove=function(){if(this.parent){const index=this.parent.children.indexOf(this);this.parent.children.splice(index,1);this.parent=null;}};
  return element;
}

// Other frontend tests use lightweight DOM stubs; give just the video container tree operations.
export function renderVideoCards(element,cards) {
  if(!element.ownerDocument){
    const tree=createRenderElement();
    for(const key of ['children','dataset','writes','moves','ownerDocument','insertBefore','remove'])element[key]=tree[key];
    Object.defineProperty(element,'innerHTML',Object.getOwnPropertyDescriptor(tree,'innerHTML'));
  }
  renderCards(element,cards);
}
