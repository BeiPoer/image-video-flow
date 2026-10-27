import {startWorkflowServer} from './workflow-server.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';

// Procedural test artwork, not user files or model outputs.
function bottleImage(variant) {
  const w=480,h=600,raw=Buffer.alloc((w*3+1)*h);
  const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*Math.max(0,Math.min(1,t))));
  const ellipse=(x,y,cx,cy,rx,ry)=>((x-cx)/rx)**2+((y-cy)/ry)**2<1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const glow=Math.max(0,1-Math.hypot(x-140,y-150)/650);
    let color=mix(variant?[165,160,140]:[193,177,155],variant?[237,233,209]:[249,239,223],glow);
    if(y>450)color=mix(color,[172,151,119],(y-450)/600);
    if(ellipse(x,y,260,484,125,19))color=mix(color,[90,72,44],.17);
    if(variant && x>60&&x<72&&y<360)color=mix(color,[49,65,40],.5);
    if(variant)for(let k=0;k<5;k++)if(ellipse(x,y,95+(k%2)*-45,95+k*43,40,13))color=[103+k*4,113+k*4,75+k*4];
    const left=variant?171:157,right=variant?321:307;
    if(x>=left&&x<=right&&y>=226&&y<=470){
      color=mix(variant?[58,74,57]:[112,69,28],variant?[139,153,100]:[216,164,82],(x-left)/(right-left));
      if(x<left+10)color=mix(color,[236,215,163],.4);
      if(y>450)color=mix(color,[60,49,28],.4);
      if(x>left+20&&x<right-20&&y>292&&y<402){color=[239,230,207];if(y>322&&y<326&&x>left+41&&x<right-41)color=[111,105,85];if(y>341&&y<343&&x>left+34&&x<right-34)color=[171,159,134];if(y>375&&y<377&&x>left+46&&x<right-46)color=[171,159,134];}
    }
    if(x>left+28&&x<right-28&&y>177&&y<229)color=mix([91,78,55],[196,178,127],(x-left)/(right-left));
    if(x>left+30&&x<right-30&&y>178&&y<182)color=[220,203,163];
    const at=y*(w*3+1)+1+x*3;for(let i=0;i<3;i++)raw[at+i]=color[i];
  }
  function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
  function chunk(name,data){const type=Buffer.from(name),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([len,type,data,sum]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const app=await startWorkflowServer();
const date='2026-10-21T06:00:00.000Z';
await writeFile(join(app.dir,'state.json'),JSON.stringify({
  projects:[{id:'project-preview',name:'森间 · 秋日香氛',description:'独立测试画布',createdAt:date,canvas:{positions:{'asset-original':{x:70,y:150},'result-warm':{x:420,y:150},'result-green':{x:420,y:540}},viewport:{x:0,y:0,zoom:.85},assetIds:[]}}],
  shots:[{id:'shot-warm',projectId:'project-preview',name:'暖光版本',selectedImageId:'result-warm',assetIds:[]},{id:'shot-green',projectId:'project-preview',name:'植物版本',selectedImageId:'result-green',assetIds:[]}],
  assets:[{id:'asset-original',projectId:'project-preview',name:'香氛 · 原始素材',kind:'image',mime:'image/png',source:'uploaded',dataUrl:bottleImage(0),createdAt:date}],
  results:[{id:'result-warm',taskId:'task-warm',shotId:'shot-warm',name:'午后暖光 · 方向一',kind:'image',dataUrl:bottleImage(0),provider:'openai',createdAt:date},{id:'result-green',taskId:'task-green',shotId:'shot-green',name:'森林气息 · 方向二',kind:'image',dataUrl:bottleImage(1),provider:'openai',createdAt:date}],
  tasks:[{id:'task-warm',shotId:'shot-warm',kind:'image',referenceImageIds:['asset-original'],prompt:'保留香氛瓶身，以午后的暖光勾勒轮廓，米色背景，干净克制的商业摄影。',model:'gpt-image-2',status:'completed',createdAt:date},{id:'task-green',shotId:'shot-green',kind:'image',referenceImageIds:['asset-original'],prompt:'保留产品形态，加入自然枝叶与鼠尾草绿色调，柔和的光影，安静的森林气息。',model:'gpt-image-2',status:'completed',createdAt:date}]
},null,2));
console.log('PREVIEW_URL='+app.base);
process.stdin.setEncoding('utf8');
process.stdin.on('data',async data=>{if(data.trim()==='stop'){await app.stop();process.exit(0);}});
