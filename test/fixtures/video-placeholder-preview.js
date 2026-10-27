import {startWorkflowServer,png} from './workflow-server.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const app=await startWorkflowServer(),createdAt=new Date().toISOString();
await writeFile(join(app.dir,'state.json'),JSON.stringify({
  projects:[{id:'p-preview',name:'视频生成 · 界面验证',canvas:{workflow:'confirmed-materials-v1',assetIds:['a-preview'],positions:{},viewport:{x:0,y:0,zoom:1}}}],
  shots:[{id:'s-preview',projectId:'p-preview'}],
  assets:[{id:'a-preview',projectId:'p-preview',name:'测试参考图',kind:'image',dataUrl:'data:image/png;base64,'+png}],results:[],
  tasks:[
    {id:'video-running',shotId:'s-preview',kind:'video',status:'running',createdAt,params:{duration:10,ratio:'9:16',resolution:'720p'},prompt:'女士缓缓打开礼盒，镜头轻轻推近，暖光映照金色腕表，保持产品细节清晰。'},
    {id:'video-queued',shotId:'s-preview',kind:'video',status:'queued',createdAt,params:{duration:6,ratio:'16:9',resolution:'1080p'},prompt:'阳光透过枝叶，镜头缓慢移动，突出自然质感。'},
  ],
}));
console.log('PREVIEW_URL='+app.base);
process.stdin.setEncoding('utf8');
process.stdin.on('data',async data=>{if(data.trim()==='stop'){await app.stop();process.exit(0);}});
