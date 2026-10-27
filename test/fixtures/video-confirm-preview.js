import {startWorkflowServer} from './workflow-server.js';
import {setTimeout as delay} from 'node:timers/promises';

const app=await startWorkflowServer();
async function api(path,body,method=body?'POST':'GET',headers={}){
  const response=await app.fetch(app.base+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error('Preview setup failed');return response.json();
}
const settings=await api('/api/settings');
await api('/api/settings',{VIDEO_API_TYPE:'openai',SEEDANCE_BASE_URL:settings.OPENAI_BASE_URL},'PUT',{'x-settings-token':settings.settingsToken});
const project=await api('/api/projects',{name:'视频确认与下载 · 测试项目'});
for(const prompt of ['片段一 · 镜头缓缓推近主体','片段二 · 展示产品与环境细节']){
  const shot=await api('/api/shots',{projectId:project.id,name:prompt});await api('/api/tasks',{shotId:shot.id,kind:'video',prompt});
}
for(let i=0;i<100;i++){if((await api('/api/bootstrap')).results.length===2)break;await delay(20);}
console.log('PREVIEW_URL='+app.base);
process.stdin.setEncoding('utf8');process.stdin.on('data',async value=>{if(value.trim()==='stop'){await app.stop();process.exit(0);}});
