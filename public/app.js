import { projectVideos } from './video-confirmation.js';
import { setStableMarkup, renderVideoCards } from './stable-render.js';
import { imageRatios } from './image-sizes.js';
import { bindSettings } from './settings.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const media = id => state.assets.find(item => item.id === id) || state.results.find(item => item.id === id);
const mime = item => item?.dataUrl?.match(/^data:([^;,]+)/)?.[1] || item?.mime || ({ image:'image/png', video:'video/mp4', audio:'audio/mpeg' }[item?.kind] || '');
const sourceUrl = value => /^(?:https?:\/\/|data:(?:image|video|audio)\/|\/api\/(?:video-results|media)\/)/i.test(value || '') ? value : '';
const state = { projects:[], shots:[], assets:[], results:[], tasks:[], models:{}, providers:{}, videoApiType:'openai' };
let projectId = null;
let routeReady = false, navigationVersion = 0;
const videoDrafts = new Map();
let prepIds = [];
let confirmedIds = [];
let selectedImageIds = [];
let imageReferenceIds = [];
let imageSize = '864x1536';
let submittingImage = false;
const imageDrafts = new Map();
const watchedImageTaskIds = new Set();
const localCanvases = new Map();
let refreshTimer;
let refreshVersion = 0;
let toastTimer;
let uploadCount = 0;
let previewImageId = null;

let submittingVideo = false;
let projectSaveQueue = Promise.resolve();
let projectCreation;
const imageMime = new Set(['image/png','image/jpeg','image/webp']);
const taskLabels = { queued:'排队中', running:'生成中', completed:'已完成', failed:'失败', unknown:'待核实' };
const watchedVideoTaskIds = new Set();
function taskTime(task) { return new Date(task.completedAt || task.createdAt).toLocaleString('zh-CN'); }

async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers:{ 'content-type':'application/json', ...(options.headers || {}) } });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('服务响应异常，请检查后端是否运行'); }
  if(response.status===401){redirectToLogin();throw new Error('登录已过期，请重新输入访问密码');}
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}
function redirectToLogin(){const location=window.location;if(location)location.replace('/login?next='+encodeURIComponent(location.pathname+location.search+location.hash));}
$('#logoutButton').addEventListener('click',async()=>{try{await request('/api/auth/logout',{method:'POST',body:'{}'});window.location.replace('/login');}catch(error){showToast(error.message);}});
window.addEventListener('pageshow',event=>{if(event.persisted)fetch('/api/auth/status').then(response=>response.json()).then(status=>{if(!status.authenticated)redirectToLogin();}).catch(()=>{});});
const post = (path, body, method = 'POST') => request(path, { method, body: JSON.stringify(body) });
function showToast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function currentProject() { return state.projects.find(project => project.id === projectId); }
function routeProject() {
  const match=/^#\/project\/([^/]+)$/.exec(window.location?.hash || '');
  if(!match)return null;
  try{return decodeURIComponent(match[1]);}catch{return null;}
}
function setRoute(id,replace=false) {
  const hash=id?'#/project/'+encodeURIComponent(id):'#/';
  if(window.location?.hash!==hash)window.history?.[replace?'replaceState':'pushState'](null,'',hash);
}
function renderHome() {
  $('#providerStatus').textContent=state.providers.openai==='configured'||state.providers.seedance==='configured'?'● API 已配置':'○ 演示模式';
  $('#homeLoading').hidden=true;
  $('#homeProjectCount').textContent=state.projects.length;
  $('#homeEmpty').hidden=state.projects.length>0;
  const cards=state.projects.map(project=>{
    const shots=new Set(state.shots.filter(shot=>shot.projectId===project.id).map(shot=>shot.id));
    const tasks=state.tasks.filter(task=>shots.has(task.shotId));
    const results=state.results.filter(result=>shots.has(result.shotId));
    const assets=state.assets.filter(asset=>asset.projectId===project.id);
    const images=[...assets,...results].filter(item=>item.kind==='image');
    const cover=[...images].reverse().find(item=>displaySource(item));
    const active=tasks.filter(task=>['queued','running'].includes(task.status)).length;
    const time=[project.updatedAt,project.createdAt,...tasks.map(task=>task.createdAt)].filter(Boolean).sort().at(-1);
    const timeLabel=time&&Number.isFinite(Date.parse(time))?new Date(time).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'尚未开始创作';
    return {time:time||'',html:'<button type="button" class="home-project-card" data-open-project="'+esc(project.id)+'" aria-label="打开项目：'+esc(project.name||'未命名项目')+'"><div class="home-project-cover">'+(cover?preview(cover):'<span class="home-project-symbol" aria-hidden="true">✦</span>')+'<span class="home-project-badge">'+(active?active+' 个任务生成中':'创作项目')+'</span></div><div class="home-project-info"><h3>'+esc(project.name||'未命名项目')+'</h3><p>'+esc(project.description||'打开项目，上传素材或开始生成')+'</p><div class="home-project-counts"><span>'+images.length+' 张图片</span><span>'+results.filter(item=>item.kind==='video').length+' 个视频</span></div><div class="home-project-footer"><time>'+esc(timeLabel)+'</time><span>进入工作台 ↗</span></div></div></button>'};
  }).sort((a,b)=>b.time.localeCompare(a.time));
  setStableMarkup($('#homeProjectGrid'),cards.map(item=>item.html).join(''));
}
const videoDraftFields=['videoPrompt','videoDuration','videoRatio','videoSize','videoResolution','videoFrameMode','videoExternalImage'];
function rememberWorkspaceDraft() {
  rememberImageDraft();
  if(projectId)videoDrafts.set(projectId,{values:Object.fromEntries(videoDraftFields.map(id=>[id,$('#'+id).value])),references:[...selectedImageIds]});
}
function loadWorkspaceDraft() {
  loadImageDraft();
  const draft=videoDrafts.get(projectId),defaults={videoPrompt:'',videoDuration:state.videoApiType==='openai'?'8':'6',videoRatio:'9:16',videoSize:'720x1280',videoResolution:'720p',videoFrameMode:'reference',videoExternalImage:''};
  for(const id of videoDraftFields)$('#'+id).value=draft?.values[id]??defaults[id];
  selectedImageIds=draft?.references||[];
  for(const input of document.querySelectorAll('[data-video-option]'))input.checked=input.value===$('#'+input.dataset.videoOption).value;
  updateVideoMode();syncVideoDuration('number',true);
  $('#videoError').hidden=true;$('#videoDownloadStatus').textContent='';
}

function displaySource(item) { return item?.deletedAt ? '' : sourceUrl(item?.dataUrl); }
function preview(item) {
  if (!item) return '<div class="media-empty">暂无预览</div>';
  if (item.deletedAt) return '<div class="media-empty media-deleted"><strong>已删除</strong><small>超过 7 天保留期</small></div>';
  const src = esc(displaySource(item));
  if (item.kind === 'video' && src) return `<video src="${src}" controls preload="metadata" aria-label="${esc(item.name)}"></video>`;
  if (item.kind === 'audio' && src) return `<audio src="${src}" controls aria-label="${esc(item.name)}"></audio>`;
  if (item.kind === 'image' && src) return `<img src="${src}" alt="${esc(item.name)}" draggable="false" loading="lazy" />`;
  return '<div class="media-empty">无法预览</div>';
}
function reuseGenerationButton(item) {
  if(!item.taskId&&!item.prompt)return '';
  if(item.kind==='video')return '<button type="button" class="outline-button reuse-video" data-reuse-generation="'+esc(item.id)+'">回填提示词</button>';
  return '<button type="button" class="reuse-generation" data-reuse-generation="'+esc(item.id)+'" aria-label="点击回填提示词"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 17 7 7M7 17V7h10"/></svg></button>';
}
function reuseGeneration(id) {
  const result=state.results.find(item=>item.id===id);
  if(!result||!['image','video'].includes(result.kind))return;
  const task=state.tasks.find(item=>item.id===result.taskId);
  const shot=state.shots.find(item=>item.id===(task?.shotId||result.shotId));
  if(shot?.projectId!==projectId)return showToast('请在原项目中回填生成信息');
  const params=task?.params||{},selections=params.videoMedia||params.kyyMedia||{};
  const frames=Boolean(selections.firstImageId||selections.lastImageId);
  const refs=result.kind==='image'?(task?.referenceImageIds||[]):frames?[selections.firstImageId,selections.lastImageId].filter(Boolean):selections.referenceImageIds||(task?.inputImageId?[task.inputImageId]:[]);
  const missing=refs.flatMap((sourceId,index)=>{
    const source=media(sourceId),sourceProject=source?.projectId||state.shots.find(item=>item.id===source?.shotId)?.projectId;
    return !source||source.deletedAt||source.kind!=='image'||(sourceProject&&sourceProject!==projectId)?['图'+(index+1)+'（'+sourceId+'）']:[];
  });
  const warnings=[];
  if(!task)warnings.push('原任务记录缺失，仅回填结果中保存的提示词。');
  if(missing.length)warnings.push('参考素材已过期、不存在或不在当前项目：'+missing.join('、')+'。为避免编号错位，本次未回填参考图，请重新选择。');
  const restored=missing.length?[]:[...refs];
  const project=currentProject(),visible=new Set(restored.flatMap(sourceId=>[sourceId,media(sourceId)?.taskId]));
  if(project?.canvas)project.canvas.hiddenNodeIds=(project.canvas.hiddenNodeIds||[]).filter(sourceId=>!visible.has(sourceId));
  const input=$('#'+(result.kind==='image'?'imagePrompt':'videoPrompt'));
  input.value=task?.prompt??result.prompt??'';
  if(result.kind==='image'){
    imageReferenceIds=restored;imageSize=params.size||'864x1536';renderImageRatios();
  }else{
    selectedImageIds=restored;confirmedIds=[...new Set([...confirmedIds,...restored])];
    const values={videoDuration:params.duration??(state.videoApiType==='openai'?8:6),videoRatio:params.ratio||'9:16',videoSize:params.videoSize||'720x1280',videoResolution:params.resolution||'720p',videoFrameMode:frames?'frames':'reference',videoExternalImage:''};
    for(const [field,value] of Object.entries(values))$('#'+field).value=String(value);
    for(const option of document.querySelectorAll('[data-video-option]'))option.checked=option.value===$('#'+option.dataset.videoOption).value;
    updateVideoMode();syncVideoDuration('number',true);
    if(task?.videoApiType&&task.videoApiType!==state.videoApiType)warnings.push('当前视频接口与原任务不同，请确认素材模式和参数后再提交。');
    if(selections.referenceVideoIds?.length||selections.referenceAudioIds?.length)warnings.push('原任务还使用了视频或音频参考素材，当前表单仅回填图片参考。');
    if(task&&!refs.length)warnings.push('原任务没有可回填的图片素材索引；如使用外部素材，请重新填写地址。');
  }
  render();rememberWorkspaceDraft();
  const error=$('#'+(result.kind==='image'?'imageError':'videoError'));error.hidden=!warnings.length;error.textContent=warnings.join('\n');
  input.focus();input.scrollIntoView({block:'center',behavior:'smooth'});
  showToast(warnings.length?'提示词已回填，请查看生成区的素材提示':'已回填提示词、参考素材和生成参数');
  saveProjectMaterials().catch(error=>showToast('回填成功，但素材布局保存失败：'+error.message));
}
function imageCard(item) {
  if (item.deletedAt) return deletedImageCard(item,true);
  const selected=selectedImageIds.includes(item.id);
  return '<article class="material-thumb image-card confirmed '+(selected?'video-selected':'')+'" data-image-id="'+esc(item.id)+'"><div class="material-thumb-picture"><button type="button" class="material-preview-button" draggable="true" data-drag-image="'+esc(item.id)+'" data-preview-image="'+esc(item.id)+'" aria-label="预览'+esc(item.name)+'">'+preview(item)+'</button><button type="button" class="material-remove" data-action="remove-confirm" aria-label="从确认区移除'+esc(item.name)+'" title="从确认区移除">×</button>'+reuseGenerationButton(item)+'</div><span class="material-name" title="'+esc(item.name)+'">'+esc(item.name)+'</span><div class="material-thumb-actions"><button type="button" data-action="video-select">'+(selected?'✓ 视频已选':'用于视频')+'</button></div></article>';
}
function prepImages() {
  const shots = new Set(state.shots.filter(shot=>shot.projectId===projectId).map(shot=>shot.id));
  const canvas = currentProject()?.canvas || {}, hidden = new Set(canvas.hiddenNodeIds || []);
  const images = [...state.assets.filter(item=>!item.projectId||item.projectId===projectId), ...state.results.filter(item=>shots.has(item.shotId))];
  return images.filter(item=>item.kind==='image'&&!hidden.has(item.id)&&!hidden.has(item.taskId)).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
}
function prepThumbnail(item) {
  if (item.deletedAt) return deletedImageCard(item);
  if (item.pendingTask) {
    const task=item.pendingTask;
    return `<article class="material-thumb image-task-placeholder" data-image-task-id="${esc(task.id)}" aria-label="${task.status==='queued'?'图片排队中':'图片生成中'}"><div class="image-task-preview"><span class="image-task-spinner" aria-hidden="true"></span><strong>${task.status==='queued'?'排队中':'生成中'}</strong></div><p class="image-task-prompt" title="${esc(task.prompt)}">${esc(task.prompt)}</p><time>${esc(new Date(task.createdAt).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))} 提交</time></article>`;
  }
  const selected=imageReferenceIds.includes(item.id),confirmed=confirmedIds.includes(item.id);
  return '<article class="material-thumb '+(selected?'reference-selected':'')+'" data-image-id="'+esc(item.id)+'"><div class="material-thumb-picture"><button type="button" class="material-preview-button" draggable="true" data-drag-image="'+esc(item.id)+'" data-preview-image="'+esc(item.id)+'" aria-label="预览'+esc(item.name)+'" title="点击预览，拖入参考图区">'+preview(item)+'</button><button type="button" class="material-remove" data-action="remove-prep" aria-label="移除'+esc(item.name)+'" title="从工作区移除，原始图片保留">×</button>'+reuseGenerationButton(item)+'</div><span class="material-name" title="'+esc(item.name)+'">'+esc(item.name)+'</span><div class="material-thumb-actions"><button type="button" data-action="use-image" '+(selected?'disabled':'')+'>'+(selected?'已添加参考':'添加参考')+'</button><button type="button" data-action="'+(confirmed?'remove-confirm':'confirm')+'">'+(confirmed?'✓ 已确认':'加入确认区')+'</button></div></article>';
}
function referenceThumbnail(id,index,video=false) {
  const item=media(id),label='图'+(index+1)+(video&&['kyyReactApi','openai'].includes(state.videoApiType)&&$('#videoFrameMode').value==='frames'?(index===0?' · 首帧':' · 尾帧'):'');
  return '<article class="reference-image"><button type="button" data-preview-image="'+esc(id)+'" aria-label="预览'+(video?'视频':'')+'参考'+label+'：'+esc(item.name)+'">'+preview(item)+'</button><span class="reference-number">'+label+'</span><button type="button" class="material-remove" '+(video?'data-remove-video-reference':'data-remove-reference')+'="'+esc(id)+'" aria-label="取消'+(video?'视频':'')+'引用'+esc(item.name)+'" title="只取消本次引用，不移除素材">×</button><small>'+esc(item.name)+'</small></article>';
}
function deletedImageCard(item,confirmed=false) {
  return '<article class="material-thumb" data-image-id="'+esc(item.id)+'"><div class="material-thumb-picture">'+preview(item)+'<button type="button" class="material-remove" data-action="'+(confirmed?'remove-confirm':'remove-prep')+'" aria-label="移除占位'+esc(item.name)+'">×</button>'+reuseGenerationButton(item)+'</div><span class="material-name">'+esc(item.name)+'</span><small>资源已删除，不可作为参考图</small></article>';
}
function renderImageReferences() {
  setStableMarkup($('#imageReferenceTray'),imageReferenceIds.length?imageReferenceIds.map((id,index)=>referenceThumbnail(id,index)).join(''):'<div class="reference-drop-empty"><span>＋</span><b>将上方素材拖到这里作为参考图</b><small>也可直接拖入本地图片，或使用素材下方的“添加参考”</small></div>');
  imageMentions.refresh();
}
function bindPromptMentions(id,getReferences) {
  const input=$('#'+id),menu=$('#'+id+'Mentions'),highlight=$('#'+id+'Highlight');
  const textStyles=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textIndent','textTransform','textAlign','direction','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft'];
  let matches=[],active=0,range=null,composing=false;
  let resizeObserver;
  function highlightText() {
    setStableMarkup(highlight,esc(input.value).replace(/(?<![\w@])@图([1-9]\d*)/g,'<span class="prompt-mention-token" data-reference="$1">$&</span>')+'\u200b');
    if(!input.clientWidth)return;
    const style=getComputedStyle(input);
    for(const property of textStyles)highlight.style[property]=style[property];
    Object.assign(highlight.style,{left:(input.offsetLeft+input.clientLeft)+'px',top:(input.offsetTop+input.clientTop)+'px',width:input.clientWidth+'px',height:input.clientHeight+'px'});
    highlight.scrollTop=input.scrollTop;highlight.scrollLeft=input.scrollLeft;
    if(!resizeObserver){resizeObserver=new ResizeObserver(()=>{highlightText();position();});resizeObserver.observe(input);}
  }
  function close() {
    menu.hidden=true;range=null;
    input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
  }
  function position() {
    if(menu.hidden)return;
    const style=getComputedStyle(input),mirror=document.createElement('div'),caret=document.createElement('span');
    // A textarea exposes no caret rectangle; mirror its text wrapping and subtract its scroll offset.
    for(const property of textStyles)mirror.style[property]=style[property];
    Object.assign(mirror.style,{position:'fixed',left:'0',top:'0',visibility:'hidden',pointerEvents:'none',boxSizing:'border-box',width:input.clientWidth+'px',whiteSpace:'pre-wrap',overflowWrap:'break-word'});
    mirror.textContent=input.value.slice(0,input.selectionStart);
    caret.textContent=input.value.slice(input.selectionStart)||'\u200b';mirror.append(caret);document.body.append(mirror);
    const rect=caret.getClientRects()[0],origin=mirror.getBoundingClientRect();
    const x=input.offsetLeft+input.clientLeft+rect.left-origin.left-input.scrollLeft;
    const y=input.offsetTop+input.clientTop+rect.top-origin.top-input.scrollTop;
    menu.style.left=Math.max(0,Math.min(x,input.parentElement.clientWidth-menu.offsetWidth))+'px';
    menu.style.top=(y+rect.height+4)+'px';
    mirror.remove();
  }
  function refresh() {
    if(document.activeElement!==input)return;
    if(composing||input.selectionStart!==input.selectionEnd)return close();
    const before=input.value.slice(0,input.selectionStart);
    const match=/@([^\s@，。！？、；：…（）()\[\]{}]*)$/.exec(before);
    if(!match||/[\w@]/.test(before[match.index-1]||''))return close();
    const query=match[1].toLocaleLowerCase();
    const references=getReferences();
    // shortcut: @图N follows the current order; use ID-backed tokens if mentions must survive reference removal/reordering.
    matches=references.map((item,index)=>({...item,number:index+1,label:'图'+(index+1)})).filter(item=>item.label.includes(query)||item.name.toLocaleLowerCase().includes(query));
    range={start:match.index,end:input.selectionStart};active=Math.min(active,Math.max(0,matches.length-1));
    const empty=references.length?'没有匹配的参考图，试试编号或素材名':'请先在上方参考图区添加图片';
    setStableMarkup(menu,matches.length?matches.map((item,index)=>'<div id="'+id+'Mention'+index+'" class="mention-option" data-reference="'+item.number+'" role="option" aria-selected="'+(index===active)+'" data-mention-index="'+index+'">'+item.label+'</div>').join(''):'<div class="mention-empty" role="status">'+empty+'</div>');
    menu.hidden=false;input.setAttribute('aria-expanded','true');
    if(matches.length)input.setAttribute('aria-activedescendant',id+'Mention'+active);else input.removeAttribute('aria-activedescendant');
    position();
  }
  function select(index) {
    const item=matches[index];if(!item||!range)return;
    const token='@'+item.label;
    const suffix=input.value.slice(range.end);
    const text=token+(/^\s/.test(suffix)?'':' ');
    if(input.value.length-(range.end-range.start)+text.length>input.maxLength){showToast('提示词已达到长度上限，请删减后再引用');return;}
    input.setRangeText(text,range.start,range.end,'end');
    input.dispatchEvent(new Event('input',{bubbles:true}));close();input.focus();
  }
  input.addEventListener('input',()=>{highlightText();active=0;refresh();});
  input.addEventListener('click',refresh);
  input.addEventListener('focus',refresh);
  input.addEventListener('blur',close);
  input.addEventListener('scroll',()=>{highlightText();position();});
  window.addEventListener('resize',()=>{highlightText();position();});
  input.addEventListener('compositionstart',()=>{composing=true;close();});
  input.addEventListener('compositionend',()=>{composing=false;refresh();});
  input.addEventListener('keyup',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key))refresh();});
  input.addEventListener('keydown',event=>{
    if(composing||event.isComposing||event.keyCode===229||menu.hidden)return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(!matches.length)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();active=(active+(event.key==='ArrowDown'?1:-1)+matches.length)%matches.length;refresh();
      $('#'+id+'Mention'+active).scrollIntoView({block:'nearest'});
    }else if(event.key==='Enter'||(event.key==='Tab'&&!event.shiftKey)){event.preventDefault();select(active);}
  });
  menu.addEventListener('pointerdown',event=>event.preventDefault());
  menu.addEventListener('click',event=>{
    const option=event.target.closest('[data-mention-index]');if(option)select(Number(option.dataset.mentionIndex));
  });
  return {refresh(){highlightText();if(!menu.hidden)refresh();}};
}
const imageMentions=bindPromptMentions('imagePrompt',()=>imageReferenceIds.map(media).filter(item=>item&&!item.deletedAt));
const videoMentions=bindPromptMentions('videoPrompt',()=>{
  const external=$('#videoExternalImage').value.trim();
  if(external)return [{name:'外部参考图'}];
  return selectedImageIds.map(media).filter(item=>item&&!item.deletedAt);
});
function openImagePreview(id) {
  const item=media(id);if(!item||item.kind!=='image'||!displaySource(item))return;
  previewImageId=id;
  $('#imagePreviewFull').src=displaySource(item);$('#imagePreviewFull').alt=item.name;
  $('#imagePreviewTitle').textContent=item.name;
  $('#imagePreviewDialog').showModal();
}
$('#closeImagePreview').addEventListener('click',()=>$('#imagePreviewDialog').close());
$('#imagePreviewDialog').addEventListener('close',()=>{previewImageId=null;$('#imagePreviewFull').removeAttribute('src');$('#imagePreviewFull').alt='';});
$('#imagePreviewDialog').addEventListener('click',event=>{if(event.target===$('#imagePreviewDialog'))$('#imagePreviewDialog').close();});

function renderPrep() {
  const records=prepImages();prepIds=records.filter(item=>!item.deletedAt).map(item=>item.id);
  imageReferenceIds=imageReferenceIds.filter(id=>prepIds.includes(id));
  const shotIds=new Set(state.shots.filter(shot=>shot.projectId===projectId).map(shot=>shot.id));
  const tasks=state.tasks.filter(task=>task.kind==='image'&&shotIds.has(task.shotId));
  const active=tasks.filter(task=>['queued','running'].includes(task.status));
  const taskMap=new Map(tasks.map(task=>[task.id,task]));
  const hidden=new Set(currentProject()?.canvas?.hiddenNodeIds || []);
  const uploaded=records.filter(item=>!item.taskId&&item.source!=='generated');
  const generated=[...records.filter(item=>(item.taskId||item.source==='generated')&&!['queued','running'].includes(taskMap.get(item.taskId)?.status)),...active.filter(task=>!hidden.has(task.id)).map(task=>({id:task.id,createdAt:task.createdAt,pendingTask:task}))];
  // Keep a task's place in the row when it becomes an image, even if tasks finish out of order.
  const orderTime=item=>taskMap.get(item.taskId)?.createdAt || item.createdAt || '';
  generated.sort((a,b)=>orderTime(b).localeCompare(orderTime(a)) || (b.taskId||b.id).localeCompare(a.taskId||a.id));
  for(const [id,list,label] of [['uploadedMaterials',uploaded,'随时 Ctrl+V 粘贴，或点击“上传图片”'],['generatedMaterials',generated,'生成完成的图片会出现在这里']]){
    const html=list.length?list.map(prepThumbnail).join(''):'<div class="material-strip-empty">'+label+'</div>';
    setStableMarkup($('#'+id),html);
  }
  $('#uploadedCount').textContent=uploaded.length;$('#generatedCount').textContent=active.length?`${generated.length} · ${active.length} 个生成中`:generated.length;
  $('#imageSelectionHint').textContent=imageReferenceIds.length?'已添加 '+imageReferenceIds.length+' / 8 张参考图：'+imageReferenceIds.map(id=>media(id)?.name).join('、'):'未添加参考图：按文字生成';
  renderImageReferences();
  $('#clearImageSelection').disabled=!imageReferenceIds.length;
  $('#generateImageButton').disabled=submittingImage||uploadCount>0;
  $('#generateImageButton').textContent=submittingImage?'正在提交…':uploadCount?'正在导入图片…':'✦ 生成图片';
  $('#restoreMaterialsButton').hidden=!(currentProject()?.canvas?.hiddenNodeIds?.length);
  for(const task of tasks)if(['queued','running'].includes(task.status))watchedImageTaskIds.add(task.id);
  $('#imageTaskStatus').textContent=active.length?active.length+' 个图片任务生成中，完成后自动加入“生成的素材”。':'';
  const failed=tasks.find(task=>watchedImageTaskIds.has(task.id)&&['failed','unknown'].includes(task.status));
  $('#imageTaskFailure').hidden=!failed;
  $('#imageTaskFailure').textContent=failed?'图片任务'+(failed.status==='unknown'?'待核实':'失败')+' · '+taskTime(failed)+'：'+(failed.error || '请查看任务记录'):'';
}
function renderImageRatios() {
  $('#imageRatios').innerHTML=imageRatios.map(ratio=>'<label class="image-ratio-option" title="'+ratio.size+'"><input type="radio" name="imageSize" value="'+ratio.size+'" aria-label="画面比例 '+ratio.label+'" '+(imageSize===ratio.size?'checked':'')+'/><span class="ratio-icon" aria-hidden="true"><i style="width:'+ratio.width+'px;height:'+ratio.height+'px"></i></span><span>'+ratio.label+'</span></label>').join('');
}
function addImageReference(id) {
  if(media(id)?.deletedAt)return showToast('资源已删除，不能作为参考图');
  if(!prepIds.includes(id)||imageReferenceIds.includes(id))return;
  if(imageReferenceIds.length>=8)return showToast('参考生图最多添加 8 张图片');
  imageReferenceIds.push(id);renderPrep();
}
function removeImageReference(id) { imageReferenceIds=imageReferenceIds.filter(value=>value!==id);renderPrep(); }
function removePrepImage(id) {
  const project=currentProject();if(!project)return;project.canvas ||= {};
  project.canvas.hiddenNodeIds=[...new Set([...(project.canvas.hiddenNodeIds || []),id])];
  confirmedIds=confirmedIds.filter(value=>value!==id);selectedImageIds=selectedImageIds.filter(value=>value!==id);imageReferenceIds=imageReferenceIds.filter(value=>value!==id);
  render();saveProjectMaterials().catch(error=>showToast(error.message));
}
function rememberImageDraft(){if(projectId)imageDrafts.set(projectId,{prompt:$('#imagePrompt').value,size:imageSize,refs:[...imageReferenceIds]});}
function loadImageDraft(){const draft=imageDrafts.get(projectId);$('#imagePrompt').value=draft?.prompt||'';imageSize=draft?.size||'864x1536';imageReferenceIds=draft?.refs||[];$('#imageError').hidden=true;renderImageRatios();}
$('#clearImageSelection').addEventListener('click',()=>{imageReferenceIds=[];renderPrep();});
$('#imageRatios').addEventListener('change',event=>{if(imageRatios.some(ratio=>ratio.size===event.target.value))imageSize=event.target.value;});
$('#imageComposeForm').addEventListener('submit',event=>{event.preventDefault();void generateImage();});
$('#restoreMaterialsButton').addEventListener('click',()=>{if(currentProject()?.canvas){currentProject().canvas.hiddenNodeIds=[];renderPrep();saveProjectMaterials().catch(error=>showToast(error.message));}});
function renderConfirmed() {
  const records = confirmedIds.map(media).filter(Boolean);
  $('#confirmedCount').textContent = `${records.length} 张`;
  setStableMarkup($('#confirmedGrid'), records.length ? records.map(item => imageCard(item)).join('') : '<div class="empty-confirmed"><span>▧</span><p>还没有确认素材</p><small>从上方图片卡片加入</small></div>');
}
function renderVideo() {
  selectedImageIds=selectedImageIds.filter(id=>confirmedIds.includes(id)&&media(id)&&!media(id).deletedAt);
  const selected = selectedImageIds.map(media);
  setStableMarkup($('#videoPicker'),selected.length?selectedImageIds.map((id,index)=>referenceThumbnail(id,index,true)).join(''):'<div class="reference-drop-empty"><span>＋</span><b>将素材确认区的图片拖到这里</b><small>也可点击确认素材下方的“用于视频”；点击图片可预览大图</small></div>');
  videoMentions.refresh();
  $('#videoReferenceCount').textContent=selected.length?'已添加 '+selected.length+' 张参考图':'尚未添加参考图';
  $('#clearVideoReferences').disabled=!selected.length;
  $('#videoSelectionHint').textContent = selected.length ? `已选 ${selected.length} 个素材：${selected.map(item => item.name).join('、')}` : '尚未选择视频素材';
  $('#generateVideoButton').disabled = !selected.length || submittingVideo || uploadCount > 0;
  updateVideoMode();
  renderVideoResults();
}
function renderVideoResults() {
  const shotIds = new Set(state.shots.filter(shot => shot.projectId === projectId).map(shot => shot.id));
  const tasks = state.tasks.filter(task => shotIds.has(task.shotId) && task.kind === 'video');
  for (const task of tasks) if (['queued','running'].includes(task.status)) watchedVideoTaskIds.add(task.id);
  const alerts = tasks.filter(task => watchedVideoTaskIds.has(task.id) && ['failed','unknown'].includes(task.status));
  $('#videoTaskAlerts').hidden = !alerts.length;
  setStableMarkup($('#videoTaskAlerts'), alerts.length ? '<b>本次任务提醒</b>' + alerts.map(task => `<div class="video-task-alert"><strong>${task.status === 'unknown' ? '视频状态待核实' : '视频生成失败'}</strong><time>${esc(taskTime(task))}</time><p>${esc(task.error || '请打开任务记录查看详情')}${task.status === 'unknown' ? '；请先核实上游状态，避免重复提交计费。' : ''}</p><small>${esc(task.prompt)}</small></div>`).join('') + '<button type="button" class="outline-button" id="viewVideoTaskHistory">查看任务记录</button>' : '');
  const cards=tasks.filter(task=>['completed','queued','running'].includes(task.status)).flatMap(task=>{
    const result=state.results.find(item=>item.taskId===task.id);
    if(task.status==='completed'&&!result)return [];
    const done=task.status==='completed',title=done?(result.name||'视频结果'):task.status==='queued'?'视频排队中':'视频生成中';
    const progress=Number.isFinite(task.progress)?Math.floor(Math.max(0,Math.min(100,task.progress))):null;
    const progressLabel=progress===null?(task.status==='queued'?'排队中':'进度暂不可用'):progress+'%';
    const progressHint=task.upstreamStatus==='saving'?'正在保存视频…':progress===100?'生成完成，正在准备视频…':'可继续创作，完成后自动显示';
    const frame=done?preview(result):'<div class="video-pending-art"><span class="video-pending-icon" aria-hidden="true">▷</span><span class="video-pending-spinner" aria-hidden="true"></span><strong>'+title+'</strong><div class="video-progress"><progress max="100" '+(progress===null?'':'value="'+progress+'" ')+'aria-label="视频生成进度"></progress><span>'+progressLabel+'</span></div><small>'+progressHint+'</small></div>';
    const details=[task.params?.duration?task.params.duration+' 秒':'',task.params?.ratio||task.params?.videoSize||'',task.params?.resolution||''].filter(Boolean).join(' · ');
    return [{id:task.id,html:'<div class="video-result-frame" aria-label="'+esc(title)+'">'+frame+'</div><div class="video-result-info"><div class="video-result-heading"><b title="'+esc(title)+'">'+esc(title)+'</b><span class="video-state '+(done?'done':'working')+'">'+(done?(result.deletedAt?'已删除':'已完成'):'处理中')+'</span></div><p class="video-result-prompt" title="'+esc(task.prompt)+'">'+esc(task.prompt)+'</p><div class="video-result-meta"><span>'+esc(details)+'</span><time>'+esc(new Date(task.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}))+'</time></div></div>'+'<div class="video-card-actions">'+(done?reuseGenerationButton(result):'')+(done&&!result.deletedAt&&projectVideos(state,projectId).some(item=>item.id===result.id)?'<button type="button" class="outline-button" data-confirm-video="'+esc(result.id)+'">＋ 加入确认区</button>':'<small>'+(result?.deletedAt?'资源已删除':'完成后自动加入视频确认区')+'</small>')+'</div>'}];
  });
  renderVideoCards($('#videoResults'),cards);
  renderConfirmedVideos();
}
const videoConfirmationWrites=new Set(),videoDownloads=new Set();
function renderConfirmedVideos() {
  const results=projectVideos(state,projectId).filter(result=>result.videoConfirmed!==false);
  $('#confirmedVideoCount').textContent=results.length+' 个';
  $('#confirmedVideosEmpty').hidden=results.length>0;
  renderVideoCards($('#confirmedVideos'),results.map(result=>({id:result.id,html:'<div class="video-result-frame">'+preview(result)+'</div><div class="confirmed-video-info"><b>'+esc(result.name)+'</b><p title="'+esc(result.prompt||'')+'">'+esc(result.prompt||'')+'</p></div><div class="video-card-actions">'+reuseGenerationButton(result)+'<button type="button" class="primary-button" data-download-video="'+esc(result.id)+'" '+(result.deletedAt?'disabled':'')+'>↓ 下载视频</button><button type="button" class="outline-button" data-unconfirm-video="'+esc(result.id)+'">移除</button></div>'})));
}
async function confirmVideo(id,confirmed) {
  if(videoConfirmationWrites.has(id))return;
  const result=state.results.find(item=>item.id===id);if(!result)return;
  if(confirmed&&result.deletedAt)return showToast('资源已删除');
  if((result.videoConfirmed!==false)===confirmed)return showToast('视频已在确认区');
  videoConfirmationWrites.add(id);
  try{
    const saved=await post('/api/results/'+encodeURIComponent(id)+'/video-confirmation',{confirmed},'PATCH');
    const current=state.results.find(item=>item.id===id);if(current)current.videoConfirmed=saved.videoConfirmed;
    refreshVersion++;renderVideoResults();scheduleRefresh();showToast(confirmed?'已加入视频确认区':'已从确认区移除，原视频保留');
  }catch(error){showToast(error.message);}finally{videoConfirmationWrites.delete(id);}
}
async function downloadVideo(id) {
  if(media(id)?.deletedAt)return showToast('资源已删除，无法下载');
  const key=id;if(videoDownloads.has(key))return;
  const targetProject=projectId,filename=(media(id)?.name||'视频')+'.mp4';
  const path='/api/results/'+encodeURIComponent(id)+'/download';
  videoDownloads.add(key);renderConfirmedVideos();$('#videoDownloadStatus').textContent='正在准备视频下载，请稍候…';
  try{
    const response=await fetch(path);
    if(response.status===401){redirectToLogin();throw Error('请重新登录后下载');}
    if(!response.ok){let payload;try{payload=await response.json();}catch{}throw Error(payload?.error||'下载失败，请稍后重试');}
    // shortcut: the browser buffers downloads (server caps each video at 256 MB); use streaming for larger exports.
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    if(projectId===targetProject)$('#videoDownloadStatus').textContent='下载已交给浏览器，请查看下载列表。';
  }catch(error){if(projectId===targetProject)$('#videoDownloadStatus').textContent=error.message;showToast(error.message);}
  finally{videoDownloads.delete(key);renderConfirmedVideos();}
}
function renderTasks() {
  const tasks = state.tasks.filter(task => state.shots.some(shot => shot.projectId === projectId && shot.id === task.shotId));
  $('#runningCount').textContent = String(tasks.filter(task => ['queued','running'].includes(task.status)).length);
  setStableMarkup($('#taskList'), tasks.length ? tasks.map(task => `<article class="task-item"><div><b>${task.kind === 'image' ? '图片生成' : '视频生成'}</b><span class="task-status ${task.status}">${taskLabels[task.status] || esc(task.status)}</span></div><p>${esc(task.prompt)}</p><small>${new Date(task.createdAt).toLocaleString('zh-CN')} · ${esc(task.model || '')}</small>${task.error ? `<p class="error-message">${esc(task.error)}</p>` : ''}${task.remoteTaskId ? `<small>上游任务：${esc(task.remoteTaskId)}</small>` : ''}</article>`).join('') : '<p class="drawer-empty">当前项目还没有任务。</p>');
}
function render() {
  if(previewImageId&&(!media(previewImageId)||media(previewImageId).deletedAt))$('#imagePreviewDialog').close();
  const inProject=Boolean(currentProject());
  $('#homePage').hidden=inProject;$('#workspacePage').hidden=!inProject;
  $('#projectNavigation').hidden=!inProject;$('#historyButton').hidden=!inProject;
  document.title=inProject?(currentProject().name||'项目')+' · AI Media Flow':'AI Media Flow · 项目首页';
  if(!inProject){renderHome();updateVideoMode();return;}
  const projectOptions = state.projects.length ? state.projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('') : '<option value="">新建项目</option>';
  setStableMarkup($('#projectSelect'),projectOptions);
  $('#projectSelect').value = projectId || '';
  $('#providerStatus').textContent = state.providers.openai === 'configured' || state.providers.seedance === 'configured' ? '● API 已配置' : '○ 演示模式';
  $('#prepStatus').textContent = uploadCount ? '正在导入素材…' : '拖入或 Ctrl+V 的图片会自动加入预处理区。';
  renderPrep(); renderConfirmed(); renderVideo(); renderTasks();
  $('#videoModelLabel').textContent = state.models.seedance || '视频模型未设置';
}

async function refresh() {
  clearTimeout(refreshTimer);
  const version=++refreshVersion;
  const data = await request('/api/bootstrap');
  if (version!==refreshVersion) return;
  Object.assign(state, data);
  for (const project of state.projects) if (localCanvases.has(project.id)) project.canvas = structuredClone(localCanvases.get(project.id));
  if(!routeReady){routeReady=true;const requested=routeProject();projectId=state.projects.some(project=>project.id===requested)?requested:null;if(requested&&!projectId){setRoute(null,true);showToast('项目不存在，已返回首页');}if(projectId)loadWorkspaceDraft();}
  if(projectId&&!currentProject()){projectId=null;setRoute(null,true);}
  restoreProjectSelections();
  render();
  scheduleRefresh();
}
function restoreProjectSelections() {
  const projectShotIds = new Set(state.shots.filter(shot => shot.projectId === projectId).map(shot => shot.id));
  const visible = [...state.assets.filter(item => !item.projectId || item.projectId === projectId), ...state.results.filter(item => projectShotIds.has(item.shotId))];
  const visibleIds = new Set(visible.map(item => item.id));
  prepIds = [...new Set([...prepIds, ...visible.filter(item => item.kind === 'image').map(item => item.id)])].filter(id => visibleIds.has(id));
  const canvas = state.projects.find(project => project.id === projectId)?.canvas;
  const savedConfirmed = canvas?.workflow === 'confirmed-materials-v1' ? canvas.assetIds || [] : [];
  confirmedIds = [...new Set(savedConfirmed)].filter(id => visibleIds.has(id) && media(id)?.kind === 'image');
  selectedImageIds = selectedImageIds.filter(id => confirmedIds.includes(id));
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(()=>refresh().catch(error=>{showToast('任务状态刷新失败：'+error.message);scheduleRefresh();}),state.tasks.some(task=>['queued','running'].includes(task.status))?2500:60000);
}
let durationApiType;
function syncVideoDuration(source, commit=false) {
  const number=$('#videoDuration'),slider=$('#videoDurationRange');
  const input=source==='slider'?slider:number;
  let value=Number(input.value),min=Number(number.min),max=Number(number.max);
  if (!commit && (input.value==='' || !Number.isInteger(value) || value<min || value>max)) return;
  if(input.value==='' || !Number.isFinite(value))value=Number(slider.value)||6;
  value=Math.max(min,Math.min(max,Math.round(value)));
  number.value=String(value);slider.value=String(value);
}
$('#videoDurationRange').addEventListener('input',()=>syncVideoDuration('slider'));
$('#videoDuration').addEventListener('input',()=>syncVideoDuration('number'));
$('#videoDuration').addEventListener('change',()=>syncVideoDuration('number',true));
$('#videoOptions').addEventListener('change',event=>{
  const field=event.target.dataset.videoOption;
  if(!['videoRatio','videoSize','videoResolution','videoFrameMode'].includes(field))return;
  $('#'+field).value=event.target.value;
  if(field==='videoFrameMode')renderVideo();
});
function updateVideoMode() {
  const type = state.videoApiType || 'openai';
  const kyy = type === 'kyyReactApi';
  $('#videoRatioWrap').hidden = type === 'openai';
  $('#videoSizeWrap').hidden = type !== 'openai';
  $('#videoResolutionWrap').hidden = !kyy;
  $('#videoFrameModeWrap').hidden = !kyy && type !== 'openai';
  $('#videoDuration').min = kyy ? '4' : '1';
  $('#videoDuration').max = kyy ? '15' : '60';
  $('#videoDurationRange').min = $('#videoDuration').min;
  $('#videoDurationRange').max = $('#videoDuration').max;
  $('#durationMin').textContent = $('#videoDuration').min+' 秒';
  $('#durationMax').textContent = $('#videoDuration').max+' 秒';
  if(durationApiType!==type){durationApiType=type;syncVideoDuration('number',true);}
  $('#videoModelLabel').textContent = state.models.seedance || '视频模型未设置';
}
async function setProject(id,fromHistory=false) {
  const version=++navigationVersion;
  try {
    if(id&&!state.projects.some(project=>project.id===id)){showToast('项目不存在');id=null;}
    await saveProjectMaterials();if(version!==navigationVersion)return;
    rememberWorkspaceDraft();projectId=id;prepIds=[];confirmedIds=[];selectedImageIds=[];
    loadWorkspaceDraft();restoreProjectSelections();$('#taskDrawer').hidden=true;
    if(!fromHistory)setRoute(id);else if(!id)setRoute(null,true);
    render();window.scrollTo?.({top:0,behavior:'instant'});
  }catch(error){$('#projectSelect').value=projectId||'';if(fromHistory)setRoute(projectId,true);showToast(error.message);}
}
$('#homeProjectGrid').addEventListener('click',event=>{const card=event.target.closest('[data-open-project]');if(card)void setProject(card.dataset.openProject);});
$('#backHomeButton').addEventListener('click',()=>setProject(null));
$('#homeLink').addEventListener('click',event=>{event.preventDefault();void setProject(null);});
window.addEventListener('hashchange',()=>{if(routeReady)void setProject(routeProject(),true);});
$('#projectSelect').addEventListener('change', event => setProject(event.target.value));
$('#historyButton').addEventListener('click', () => { $('#taskDrawer').hidden = false; renderTasks(); });
$('#closeTaskDrawer').addEventListener('click', () => { $('#taskDrawer').hidden = true; });
$('#newProjectButton').addEventListener('click', () => $('#projectDialog').showModal());
$('#homeNewProjectButton').addEventListener('click', () => $('#projectDialog').showModal());
$('#emptyNewProjectButton').addEventListener('click', () => $('#projectDialog').showModal());
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#projectForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { const values=Object.fromEntries(new FormData(form));await saveProjectMaterials();rememberWorkspaceDraft();const project = await post('/api/projects', values); state.projects.unshift(project); projectId = project.id; prepIds = []; confirmedIds = []; selectedImageIds = []; loadWorkspaceDraft();restoreProjectSelections();setRoute(project.id);form.reset();form.closest('dialog').close();render();window.scrollTo?.({top:0,behavior:'instant'}); }
  catch (error) { showToast(error.message); } finally { button.disabled = false; }
});
function chooseImage(id) {
  if(media(id)?.deletedAt)return showToast('资源已删除，不能作为参考图');
  if(!confirmedIds.includes(id)||!media(id))return showToast('请先将这张图片加入素材确认区');
  if(selectedImageIds.includes(id))return;
  const max=['kyyReactApi','openai'].includes(state.videoApiType)?($('#videoFrameMode').value==='frames'?2:9):1;
  if(selectedImageIds.length>=max)return showToast('当前视频模式最多添加 '+max+' 张参考图，请先取消已有引用');
  selectedImageIds.push(id);renderConfirmed();renderVideo();
}
function removeVideoReference(id){selectedImageIds=selectedImageIds.filter(value=>value!==id);renderConfirmed();renderVideo();}
$('#clearVideoReferences').addEventListener('click',()=>{selectedImageIds=[];renderConfirmed();renderVideo();});
function saveProjectMaterials() {
  const project = state.projects.find(item => item.id === projectId);
  if (!project) return Promise.resolve();
  const canvas = { ...structuredClone(project.canvas || {}), workflow:'confirmed-materials-v1', positions:project.canvas?.positions || {}, viewport:project.canvas?.viewport || {x:0,y:0,zoom:1}, assetIds:[...new Set(confirmedIds)] };
  project.canvas = canvas;
  localCanvases.set(project.id, structuredClone(canvas));
  $('#saveStatus').textContent = '保存中…';
  const operation = projectSaveQueue.catch(() => {}).then(() => post('/api/projects/' + project.id, {canvas}, 'PATCH')).then(() => { if (project.id === projectId) $('#saveStatus').textContent = '已保存'; }).catch(error => { if (project.id === projectId) $('#saveStatus').textContent = '保存失败，点击重试'; throw error; });
  projectSaveQueue = operation;
  return operation;
}
function addConfirmed(id) { if(media(id)?.deletedAt)return showToast('资源已删除'); if (!confirmedIds.includes(id)) confirmedIds.push(id); render(); saveProjectMaterials().catch(error => showToast('确认素材未保存：' + error.message)); }
function removeConfirmed(id) { confirmedIds = confirmedIds.filter(value => value !== id); selectedImageIds = selectedImageIds.filter(value => value !== id); render(); saveProjectMaterials().catch(error => showToast('确认素材未保存：' + error.message)); }
$('#saveStatus').addEventListener('click', () => saveProjectMaterials().catch(error => showToast(error.message)));
document.body.addEventListener('click', async event => {
  const reuse=event.target.closest('[data-reuse-generation]');if(reuse){reuseGeneration(reuse.dataset.reuseGeneration);return;}
  const addVideo=event.target.closest('[data-confirm-video]');if(addVideo){await confirmVideo(addVideo.dataset.confirmVideo,true);return;}
  const removeVideo=event.target.closest('[data-unconfirm-video]');if(removeVideo){await confirmVideo(removeVideo.dataset.unconfirmVideo,false);return;}
  const download=event.target.closest('[data-download-video]');if(download){await downloadVideo(download.dataset.downloadVideo);return;}
  if (event.target.closest('#viewVideoTaskHistory')) { $('#taskDrawer').hidden = false; renderTasks(); return; }
  const removeVideoRef=event.target.closest('[data-remove-video-reference]');if(removeVideoRef){removeVideoReference(removeVideoRef.dataset.removeVideoReference);return;}
  const removeRef=event.target.closest('[data-remove-reference]');if(removeRef){removeImageReference(removeRef.dataset.removeReference);return;}
  const previewButton=event.target.closest('[data-preview-image]');if(previewButton){openImagePreview(previewButton.dataset.previewImage);return;}
  const card = event.target.closest('[data-image-id]');
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (card && action === 'confirm') { addConfirmed(card.dataset.imageId); return; }
  if (card && action === 'remove-confirm') { removeConfirmed(card.dataset.imageId); return; }
  if (card && action === 'video-select') { chooseImage(card.dataset.imageId); return; }
  if (card && action === 'use-image') { addImageReference(card.dataset.imageId); return; }
  if (card && action === 'remove-prep') { removePrepImage(card.dataset.imageId); return; }
  if (event.target.closest('#generateVideoButton')) return generateVideo();
});
async function ensureProject() {
  if (projectId) return projectId;
  projectCreation ||= post('/api/projects', {name:'我的创作'}).then(project => { state.projects.unshift(project); projectId=project.id; return project.id; }).finally(() => { projectCreation=null; });
  return projectCreation;
}
async function createShot(kind, prompt) {
  const id = await ensureProject();
  return post('/api/shots', { projectId:id, name:prompt.slice(0,32) || (kind === 'image' ? '图片创作' : '视频创作'), imagePrompt:kind === 'image' ? prompt : '', videoPrompt:kind === 'video' ? prompt : '' });
}
async function generateImage() {
  if(submittingImage||uploadCount)return;
  const prompt=$('#imagePrompt').value.trim(),refs=[...imageReferenceIds],size=imageSize;
  $('#imageError').hidden=true;
  const invalid=!prompt?'请填写图片提示词':refs.some(id=>!prepIds.includes(id)||!media(id)||media(id).deletedAt)?'参考图片已不存在，请重新选择':refs.length>8?'参考生图最多选择 8 张图片':state.providers.openai==='configured'&&refs.some(id=>!imageMime.has(mime(media(id))))?'参考生图支持 PNG、JPEG、WebP':'';
  if(invalid){$('#imageError').textContent=invalid;$('#imageError').hidden=false;return;}
  submittingImage=true;renderPrep();let targetProject=projectId;
  try{
    targetProject ||= await ensureProject();
    const shot=await post('/api/shots',{projectId:targetProject,name:prompt.slice(0,32),imagePrompt:prompt});state.shots.unshift(shot);
    const task=await post('/api/tasks',{shotId:shot.id,kind:'image',prompt,referenceImageIds:refs,params:{size}});state.tasks.unshift(task);watchedImageTaskIds.add(task.id);
    refreshVersion++;render();scheduleRefresh();
    showToast('已在后台生成，可继续提交下一张');
  }catch(error){if(projectId===targetProject){$('#imageError').textContent=error.message;$('#imageError').hidden=false;}else showToast(error.message);}
  finally{submittingImage=false;renderPrep();}
}
async function generateVideo() {
  if (submittingVideo || uploadCount) return showToast('请等待素材导入完成');
  syncVideoDuration('number',true);
  const prompt = $('#videoPrompt').value.trim(); if (!prompt) return showToast('请填写视频提示词');
  if(selectedImageIds.some(id=>media(id)?.deletedAt))return showToast('参考图片已删除，请重新选择');
  const records = selectedImageIds.filter(id => confirmedIds.includes(id)).map(media).filter(Boolean); if (!records.length) return showToast('请先从素材确认区选择视频素材');
  const type = state.videoApiType || 'openai'; const external = $('#videoExternalImage').value.trim();
  if (['kyyReactApi','openai'].includes(type) && $('#videoFrameMode').value === 'reference' && records.length > 9) return showToast('最多选择 9 张参考图片');
  const params = { duration:Number($('#videoDuration').value), ...(type === 'openai' ? { videoSize:$('#videoSize').value } : { ratio:$('#videoRatio').value }), ...(type === 'kyyReactApi' ? { resolution:$('#videoResolution').value } : {}) };
  let body = { kind:'video', prompt, params, inputImageUrl:external || null };
  if (['kyyReactApi','openai'].includes(type)) {
    if ($('#videoFrameMode').value === 'frames') { if (records.length > 2 || !records.length) return showToast('首尾帧模式请选择 1 或 2 张图片'); body.videoMedia = external ? {} : { firstImageId:records[0].id, lastImageId:records[1]?.id || '' }; if(external){body.params.firstImage=external;body.inputImageUrl=null;} }
    else body.videoMedia = { referenceImageIds:external ? [] : records.map(item => item.id), referenceVideoIds:[], referenceAudioIds:[] };
  } else { if (records.length > 1) return showToast('当前接口只支持一张参考图片'); body.inputImageId = external ? null : records[0].id; }
  submittingVideo = true; $('#generateVideoButton').disabled = true; $('#generateVideoButton').textContent = '正在提交…'; $('#videoError').hidden = true;
  try { const shot = await createShot('video', prompt); const task = await post('/api/tasks', { ...body, shotId:shot.id }); watchedVideoTaskIds.add(task.id); state.shots.unshift(shot); state.tasks.unshift(task); await refresh(); showToast('视频任务已提交，结果会出现在下方'); }
  catch (error) { $('#videoError').textContent = error.message; $('#videoError').hidden = false; } finally { submittingVideo = false; renderVideo(); $('#generateVideoButton').textContent = '▷ 提交视频任务'; }
}
async function uploadFiles(files, asReferences = false) {
  if(!projectId)return showToast('请先打开或新建项目，再上传图片');
  const accepted = files.filter(file => /^image\//.test(file.type)); if (!accepted.length) return showToast('请选择图片文件');
  uploadCount += accepted.length; render();
  try {
    const project = await ensureProject();
    for (const file of accepted) {
      try { const dataUrl = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(new Error('无法读取文件')); reader.readAsDataURL(file); }); const asset = await post('/api/assets', { projectId:project, name:file.name || '粘贴素材', kind:file.type.split('/')[0], mime:file.type, dataUrl }); if (asset.kind === 'image' && project === projectId) { state.assets.unshift(asset); renderPrep(); if(asReferences)addImageReference(asset.id); } }
      catch (error) { showToast(`导入 ${file.name || '素材'} 失败：${error.message}`); }
    }
    await refresh();
  } finally { uploadCount = Math.max(0, uploadCount - accepted.length); render(); }
}
$('#uploadButton').addEventListener('click', () => $('#assetInput').click());
$('#assetInput').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; uploadFiles(files).catch(error => showToast(error.message)); });
window.addEventListener('paste', event => { if ($('#settingsDialog').open) return; const files = [...(event.clipboardData?.files || [])].filter(file => /^(image|video|audio)\//.test(file.type)); if (files.length) { event.preventDefault(); uploadFiles(files).catch(error => showToast(error.message)); } });
const materialDragType='application/x-flow-image';
let dragDepth=0,draggingMaterial=false;
function isMaterialDrag(event){return [...(event.dataTransfer?.types||[])].includes(materialDragType);}
function clearDrop(){dragDepth=0;$('#dropOverlay').hidden=true;for(const id of ['imageReferenceZone','videoReferenceZone'])$('#'+id).classList.remove('drag-over');}
function dropReference(event,video=false){
  let value;try{value=JSON.parse(event.dataTransfer.getData(materialDragType));}catch{return;}
  if(value.projectId!==projectId||typeof value.id!=='string')return;
  if(video)chooseImage(value.id);else addImageReference(value.id);
}
window.addEventListener('dragstart',event=>{
  const source=event.target.closest('[data-drag-image]');if(!source||!media(source.dataset.dragImage))return;
  draggingMaterial=true;event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData(materialDragType,JSON.stringify({id:source.dataset.dragImage,projectId}));
});
window.addEventListener('dragend',()=>{draggingMaterial=false;clearDrop();});
window.addEventListener('dragenter',event=>{
  const files=[...(event.dataTransfer?.types||[])].includes('Files');
  if(isMaterialDrag(event)||files){event.preventDefault();if(files&&!draggingMaterial){dragDepth++;$('#dropOverlay').hidden=false;}for(const id of ['imageReferenceZone','videoReferenceZone'])if(event.target.closest('#'+id))$('#'+id).classList.add('drag-over');}
});
window.addEventListener('dragover',event=>{
  if(isMaterialDrag(event)||[...(event.dataTransfer?.types||[])].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';for(const id of ['imageReferenceZone','videoReferenceZone'])$('#'+id).classList.toggle('drag-over',Boolean(event.target.closest('#'+id)));}
});
window.addEventListener('dragleave',()=>{if(--dragDepth<=0)clearDrop();});window.addEventListener('blur',clearDrop);
window.addEventListener('drop',event=>{
  const onReference=Boolean(event.target.closest('#imageReferenceZone')),onVideo=Boolean(event.target.closest('#videoReferenceZone'));clearDrop();
  if(isMaterialDrag(event)){event.preventDefault();if(onReference||onVideo)dropReference(event,onVideo);draggingMaterial=false;return;}
  const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;
  event.preventDefault();if(onVideo)return showToast('请先上传并确认素材，再拖入视频参考图区');uploadFiles(files,onReference).catch(error=>showToast(error.message));
});
renderImageRatios();
bindSettings({ $, request, state, showToast, render, updateMode:updateVideoMode });
refresh().catch(error => {$('#homeLoading').textContent='项目读取失败，请刷新重试。';showToast(error.message);});
