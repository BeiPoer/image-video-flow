import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {loginFetch,testPassword} from './auth.js';

export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=';
export async function startWorkflowServer(initialState) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-workflow-'));
  const calls = [];
  let child, rejectEdits = false;
  let holdImages = false;
  const imageReleases = [];
  function releaseImages() { holdImages=false; for(const release of imageReleases.splice(0))release(); }
  const mock = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), type = req.headers['content-type'] || '';
      let body;
      if (type.startsWith('multipart/form-data')) {
        const form = await new Request('http://localhost', { method:'POST', headers:{'content-type':type}, body:raw }).formData();
        body = Object.fromEntries([...form].filter(([,value]) => typeof value === 'string'));
        body.images = await Promise.all(form.getAll('image[]').map(async file => ({ mime:file.type, bytes:Buffer.from(await file.arrayBuffer()) })));
      } else body = raw.length ? JSON.parse(raw) : null;
      calls.push({ path:req.url, body, type });
      res.setHeader('content-type','application/json');
      if (req.url === '/v1/images/edits' && rejectEdits) { res.statusCode=400; return res.end(JSON.stringify({error:{message:'edits are unavailable'}})); }
      if (req.url.startsWith('/v1/images/')) {
        if(holdImages)await new Promise(resolve=>imageReleases.push(resolve));
        return res.end(JSON.stringify({ data:[{b64_json:png}] }));
      }
      if (req.url === '/v3/contents/generations/tasks') return res.end(JSON.stringify({id:'mock-video',status:'succeeded',content:{video_url:'https://example.test/video.mp4'}}));
      if (req.url === '/v1/videos') return res.end(JSON.stringify({id:'local-video',status:'completed'}));
      if (req.url === '/v1/videos/local-video/content') {res.setHeader('content-type','video/mp4');return res.end('123456789');}
      res.statusCode=404; res.end('{}');
    } catch { res.statusCode=500; res.end('{}'); }
  });
  async function stop() {
    releaseImages();
    if (child && child.exitCode === null && child.signalCode === null) { const exited=once(child,'exit'); child.kill(); await exited; }
    mock.closeAllConnections(); await new Promise(resolve=>mock.close(resolve));
    if (!resolve(dir).startsWith(resolve(tmpdir()) + (process.platform==='win32'?'\\':'/')+'ai-flow-workflow-')) throw Error('Unsafe test directory');
    await rm(dir,{recursive:true,force:true});
  }
  try {
    if (initialState) await writeFile(join(dir,'state.json'),JSON.stringify(initialState));
    await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
    const provider='http://127.0.0.1:'+mock.address().port;
    child=spawn(process.execPath,['server.js'],{cwd:new URL('../../',import.meta.url),env:{...process.env,APP_ACCESS_PASSWORD:testPassword,APP_COOKIE_SECURE:'false',AI_FLOW_PORT:'0',AI_FLOW_DATA_DIR:dir,COS_ENABLED:'false',OPENAI_API_KEY:'mock-key',OPENAI_BASE_URL:provider+'/v1',OPENAI_IMAGE_MODEL:'gpt-image-2',SEEDANCE_API_KEY:'mock-video-key',SEEDANCE_BASE_URL:provider+'/v3',VIDEO_API_TYPE:'volcengine'},stdio:['ignore','pipe','pipe']});
    const base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('startup timeout')),5000);
      child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});
      child.once('error',err=>{clearTimeout(timer);reject(err);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('server exited'));});
    });
    return {base,calls,stop,dir,fetch:await loginFetch(base),holdImages(){holdImages=true;},releaseImages,set rejectEdits(value){rejectEdits=value;}};
  } catch(err) {await stop();throw err;}
}
