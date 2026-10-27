import {layoutGraph, worldPoint, zoomAt, CARD_WIDTH, CARD_HEIGHT} from './canvas-model.js';

// The canvas is confined to stage 1; selection and confirmation remain separate workflow state.
export function bindPrepCanvas({$, card, onReference, onChange, onEdit, onGenerate, onDelete, onActivate}) {
  const host=$('#prepCanvas'),world=$('#prepWorld'),nodes=$('#prepNodes'),lines=$('#prepEdges');
  let projectId,graph={nodes:[],edges:[]},positions={},view={x:0,y:0,zoom:.8},refs=[],gesture,suppressClick=false;
  let activeGeneratorId=null;
  const stamps=new Map();
  function transform() {
    world.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
    host.style.backgroundPosition=`${view.x}px ${view.y}px`;host.style.backgroundSize=`${24*view.zoom}px ${24*view.zoom}px`;
    $('#prepZoomLabel').textContent=Math.round(view.zoom*100)+'%';
  }
  function path(a,b,selected=false) {
    const x=a.x+CARD_WIDTH,y=a.y+140,bend=Math.max(60,Math.abs(b.x-x)/2);
    return `<path class="${selected?'draft-edge':''}" d="M ${x} ${y} C ${x+bend} ${y},${b.x-bend} ${b.y+140},${b.x} ${b.y+140}"/>`;
  }
  function edges() {
    lines.innerHTML=graph.edges.filter(e=>positions[e.from]&&positions[e.to]).map(e=>path(positions[e.from],positions[e.to],e.draft)).join('');
    if(gesture?.type==='link' && gesture.end)lines.innerHTML+=path(positions[gesture.id],{x:gesture.end.x,y:gesture.end.y-140},true);
  }
  function changed(){onChange({positions:structuredClone(positions),viewport:{...view}});}
  function render() {
    if(gesture)return;
    for(const id of Object.keys(positions))if(id.startsWith('gen-')&&!graph.nodes.some(node=>node.id===id))delete positions[id];
    positions=layoutGraph(graph,positions);
    const ids=new Set(graph.nodes.map(item=>item.id));
    for(const element of [...nodes.children])if(!ids.has(element.dataset.nodeId)){stamps.delete(element.dataset.nodeId);element.remove();}
    for(const item of graph.nodes){
      let element=nodes.querySelector('[data-node-id="'+item.id+'"]');
      if(!element){element=document.createElement('div');element.className='prep-node';element.dataset.nodeId=item.id;element.tabIndex=0;nodes.append(element);}
      element.classList.toggle('generator-node',Boolean(item.generator));
      element.setAttribute('aria-label',item.generator?'生图节点':item.name+'，预处理素材');
      const html='<div class="prep-handle"><span>'+(item.generator?'✦ 生图节点':item.pending?'图片任务':'素材')+'</span><button type="button" class="node-delete" data-delete-node="'+item.id+'" aria-label="移除此节点" title="从画布移除，原始素材仍保留">×</button></div>'+card(item)+(!item.pending&&!item.generator?'<button type="button" class="prep-output" data-output="'+item.id+'" aria-label="连接参考图">＋</button>':'');
      // Preserve the focused editor and caret while polling other nodes or saving drafts.
      if(stamps.get(item.id)!==html && !element.contains(document.activeElement)){element.innerHTML=html;stamps.set(item.id,html);}
      const p=positions[item.id];element.style.left=p.x+'px';element.style.top=p.y+'px';
      element.classList.toggle('reference-selected',refs.includes(item.id)||item.id===activeGeneratorId);
      if(item.generator){const button=element.querySelector('[data-run-generator]');if(button)button.disabled=Boolean(item.busy);}
    }
    $('#prepEmptyHint').hidden=graph.nodes.length>0;
    transform();edges();
  }
  function update(id,nextGraph,canvas,referenceIds,activeId) {
    if(projectId!==id){projectId=id;positions=structuredClone(canvas?.positions||{});view={...(canvas?.viewport||{x:0,y:0,zoom:.8})};nodes.replaceChildren();stamps.clear();}
    graph=nextGraph;refs=[...referenceIds];activeGeneratorId=activeId;render();
  }
  function fit(){
    if(!graph.nodes.length)return;
    const points=graph.nodes.map(node=>positions[node.id]),minX=Math.min(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y));
    const w=Math.max(...points.map(p=>p.x))+CARD_WIDTH-minX,h=Math.max(...points.map(p=>p.y))+(graph.nodes.some(node=>node.generator)?570:CARD_HEIGHT)-minY;
    const zoom=Math.max(.2,Math.min(1,(host.clientWidth-70)/w,(host.clientHeight-70)/h));
    view={x:(host.clientWidth-w*zoom)/2-minX*zoom,y:(host.clientHeight-h*zoom)/2-minY*zoom,zoom};transform();changed();
  }
  host.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const port=event.target.closest('[data-output]'),node=event.target.closest('[data-node-id]');
    if(!port && event.target.closest('button,a,input,textarea,select,.generator-content,.prep-tools'))return;
    if(node&&!port&&!event.target.closest('.prep-handle'))return;
    host.setPointerCapture(event.pointerId);event.preventDefault();
    gesture={type:port?'link':node?'node':'pan',id:node?.dataset.nodeId,start:{x:event.clientX,y:event.clientY},origin:node?{...positions[node.dataset.nodeId]}:{...view},moved:false};
  });
  host.addEventListener('pointermove',event=>{
    if(!gesture)return;
    const dx=event.clientX-gesture.start.x,dy=event.clientY-gesture.start.y;
    if(Math.abs(dx)+Math.abs(dy)>4)gesture.moved=true;
    if(gesture.type==='link'){gesture.end=worldPoint({x:event.clientX,y:event.clientY},host.getBoundingClientRect(),view);edges();}
    else if(gesture.type==='node'){
      const p={x:Math.max(-100000,Math.min(100000,gesture.origin.x+dx/view.zoom)),y:Math.max(-100000,Math.min(100000,gesture.origin.y+dy/view.zoom))};positions[gesture.id]=p;
      const el=nodes.querySelector(`[data-node-id="${gesture.id}"]`);el.style.left=p.x+'px';el.style.top=p.y+'px';edges();
    }else{view.x=Math.max(-200000,Math.min(200000,gesture.origin.x+dx));view.y=Math.max(-200000,Math.min(200000,gesture.origin.y+dy));transform();}
  });
  function finish(event,cancelled=false){
    if(!gesture)return;const last=gesture;gesture=null;
    if(host.hasPointerCapture(event.pointerId))host.releasePointerCapture(event.pointerId);
    if(last.type==='link'&&!cancelled){const target=document.elementFromPoint(event.clientX,event.clientY);const generator=target?.closest('[data-node-id]');if(!last.moved)onReference(last.id);else if(graph.nodes.some(node=>node.id===generator?.dataset.nodeId&&node.generator))onReference(last.id,generator.dataset.nodeId);}
    if(last.moved&&last.type!=='link')changed();
    suppressClick=true;setTimeout(()=>suppressClick=false,0);render();
  }
  host.addEventListener('pointerup',event=>finish(event));host.addEventListener('pointercancel',event=>finish(event,true));
  nodes.addEventListener('click',event=>{
    if(suppressClick)return;
    const remove=event.target.closest('[data-delete-node]');if(remove)return onDelete(remove.dataset.deleteNode);
    const port=event.target.closest('[data-output]');if(port)return onReference(port.dataset.output);
    const run=event.target.closest('[data-run-generator]');if(run)return onGenerate(run.dataset.runGenerator);
    const ref=event.target.closest('[data-unlink-ref]');if(ref)return onReference(ref.dataset.unlinkRef,ref.closest('[data-node-id]').dataset.nodeId);
    const node=event.target.closest('[data-node-id]');if(graph.nodes.some(item=>item.generator&&item.id===node?.dataset.nodeId))onActivate(node.dataset.nodeId);
  });
  nodes.addEventListener('input',event=>{const node=event.target.closest('[data-node-id]');if(node&&event.target.dataset.generatorField)onEdit(node.dataset.nodeId,event.target.dataset.generatorField,event.target.value);});
  nodes.addEventListener('focusout',()=>{setTimeout(render,0);});
  nodes.addEventListener('keydown',event=>{if(event.target.matches('[data-node-id]')&&['Enter','Delete','Backspace'].includes(event.key)){event.preventDefault();if(event.key!=='Enter')return onDelete(event.target.dataset.nodeId);if(mediaNode(event.target.dataset.nodeId))onReference(event.target.dataset.nodeId);}});
  function mediaNode(id){return graph.nodes.some(node=>node.id===id&&!node.pending&&!node.generator);}
  host.addEventListener('wheel',event=>{
    if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();
    const rect=host.getBoundingClientRect();view=zoomAt(view,view.zoom*Math.exp(-event.deltaY*.002),{x:event.clientX-rect.left,y:event.clientY-rect.top});transform();changed();
  },{passive:false});
  for(const [id,factor]of [['prepZoomIn',1.2],['prepZoomOut',1/1.2]])$('#'+id).addEventListener('click',()=>{view=zoomAt(view,view.zoom*factor,{x:host.clientWidth/2,y:host.clientHeight/2});transform();changed();});
  $('#prepFit').addEventListener('click',fit);$('#prepArrange').addEventListener('click',()=>{positions=layoutGraph(graph);render();fit();});
  return {update,center:()=>worldPoint({x:host.getBoundingClientRect().left+host.clientWidth/2-120,y:host.getBoundingClientRect().top+45},host.getBoundingClientRect(),view),point:(x,y)=>worldPoint({x,y},host.getBoundingClientRect(),view),place(id,point,focus=true){positions[id]={...point};render();if(focus){view.x=host.clientWidth/2-(point.x+CARD_WIDTH/2)*view.zoom;view.y=35-point.y*view.zoom;transform();}changed();}};
}
