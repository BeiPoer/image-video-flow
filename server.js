import { imageSizes } from './public/image-sizes.js';
import { projectVideos } from './public/video-confirmation.js';
import { videoFile, downloadName } from './video-download.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, rename, rm } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createSettingsStore } from './model-settings.js';
import { generateVideo, videoRequest } from './video-api.js';
import { createCosStore } from './cos-storage.js';
import { downloadImage } from './image-source.js';
import { createAccessControl } from './access-control.js';
import { expireResources, mediaExpired, requireMedia, retentionMs } from './media-retention.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const dataDir = resolve(process.env.AI_FLOW_DATA_DIR || join(root, 'data'));
const statePath = join(dataDir, 'state.json');
const access = await createAccessControl(dataDir);
const modelSettings = await createSettingsStore(dataDir);
const cosStorage = await createCosStore(dataDir);
const settingsToken = crypto.randomBytes(32).toString('hex');
const port = Number(process.env.AI_FLOW_PORT || 4173);
const kyyMimeTypes = new Set(['image/png','image/jpeg','image/webp','image/gif','image/bmp','image/tiff','image/heic','image/heif','video/mp4','video/quicktime','audio/wav','audio/mpeg']);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4' };

function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function now() { return new Date().toISOString(); }
async function ensureState() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(statePath)) await writeFile(statePath, JSON.stringify({ projects: [], assets: [], shots: [], tasks: [], results: [] }, null, 2));
}
let stateReady;
let stateWrites = Promise.resolve();
// ponytail: one process owns this JSON store; use a database before adding multiple workers.
async function readState() {
  return stateReady ||= readFile(statePath, 'utf8').then(text => JSON.parse(text));
}
function saveState(state) {
  const snapshot = JSON.stringify(state, null, 2);
  const write = stateWrites.then(async () => {
    await writeFile(statePath + '.tmp', snapshot);
    await rename(statePath + '.tmp', statePath);
  });
  stateWrites = write.catch(() => {});
  return write;
}
async function jsonBody(req, limit = 12_000_000) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('请求体过大'), { status: 413 }); }
  return body ? JSON.parse(body) : {};
}
function send(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }
let retentionPending;
function cleanExpiredMedia(scanFiles = false) {
  return retentionPending ||= readState().then(state=>expireResources(state,dataDir,saveState,Date.now(),scanFiles)).then(errors=>{for(const err of errors)console.error('过期文件删除失败，将重试：',err.message);}).finally(()=>{retentionPending=undefined;});
}
async function cleanExpiredCloud() {
  if (!cosStorage.enabled) return;
  const state=await readState();
  for (const record of [...state.assets,...state.results]) if (mediaExpired(record)) {
    try { await cosStorage.remove(record.id); }
    catch (err) { console.error('过期云端素材删除失败，将重试：',err.message); }
  }
}
function error(res, message, status = 400) { send(res, status, { error: message }); }
function sampleResult(kind, prompt) {
  const title = kind === 'video' ? 'VIDEO PREVIEW' : 'IMAGE PREVIEW';
  const accent = kind === 'video' ? '#a77bf3' : '#ef9a67';
  const safe = String(prompt || '').slice(0, 50).replace(/[<&>]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960" viewBox="0 0 720 960"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101b34"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs><rect width="720" height="960" fill="url(#g)"/><circle cx="510" cy="220" r="150" fill="#fff1d6" fill-opacity=".3"/><path d="M0 720 L170 460 340 650 500 410 720 700V960H0Z" fill="#06101e" fill-opacity=".75"/><rect x="54" y="74" width="280" height="48" rx="24" fill="#ffffff" fill-opacity=".14"/><text x="78" y="107" fill="white" font-family="Arial" font-size="22" font-weight="700">${title}</text><text x="54" y="852" fill="white" font-family="Arial" font-size="26">${safe}</text><text x="54" y="900" fill="#ffe0b0" font-family="Arial" font-size="20">LOCAL DEMO OUTPUT</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function configured(provider, config = modelSettings.current()) {
  return provider === 'openai' ? Boolean(config.OPENAI_API_KEY) : Boolean(config.SEEDANCE_API_KEY);
}
async function openaiImage(prompt, size, config, references = []) {
  const fields = { model: config.OPENAI_IMAGE_MODEL || 'gpt-image-2', prompt, size, quality: 'auto' };
  const headers = { authorization: `Bearer ${config.OPENAI_API_KEY}` };
  let body;
  if (references.length) {
    body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    for (const [index, image] of references.entries()) body.append('image[]', new Blob([image.bytes], { type: image.mime }), `reference-${index + 1}.${image.mime.split('/')[1]}`);
  } else { headers['content-type'] = 'application/json'; body = JSON.stringify(fields); }
  const response = await fetch(`${config.OPENAI_BASE_URL.replace(/\/+$/, '')}/images/${references.length ? 'edits' : 'generations'}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(600000), redirect: 'error' });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`图片接口未返回 JSON（HTTP ${response.status}），请检查服务商是否支持${references.length ? '参考图生图 /images/edits' : '图片生成'}`); }
  if (!response.ok) throw new Error((references.length ? '参考图生图失败：' : '') + (payload?.error?.message || `OpenAI 请求失败 (${response.status})`));
  const item = payload?.data?.[0];
  if (!item) throw new Error('OpenAI 没有返回图片结果');
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error('OpenAI 返回中没有可用图片');
}
async function storeVideo(response, taskId) {
  const directory = join(dataDir, 'videos');
  await mkdir(directory, { recursive: true });
  const file = join(directory, taskId + '.mp4');
  let bytes = 0;
  const limit = new Transform({ transform(chunk, encoding, done) {
    bytes += chunk.length;
    done(bytes > 256 * 1024 * 1024 ? new Error('视频超过 256 MB 保存上限') : null, chunk);
  } });
  try {
    if (!response.body) throw new Error('视频内容为空');
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file + '.tmp'));
    if (!bytes) throw new Error('视频内容为空');
    await rename(file + '.tmp', file);
    return '/api/video-results/' + taskId + '.mp4';
  } finally { await rm(file + '.tmp', { force: true }); }
}
async function serveVideo(req, res, name) {
  if (!/^task-[a-f0-9-]+\.mp4$/.test(name)) return error(res, '找不到视频', 404);
  const state=await readState();
  requireMedia(state.results.find(record=>record.taskId===name.slice(0,-4)));
  const file = join(dataDir, 'videos', name);
  if (!existsSync(file)) return error(res, '找不到视频', 404);
  const { size } = await stat(file);
  let start = 0, end = size - 1;
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
  }
  res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'private, no-store', ...(req.headers.range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + size } : {}) });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}
function kyyRecordMime(record) {
  const source = record?.dataUrl;
  const mime = /^data:([^;,]+)/.exec(source || '')?.[1] || record?.mime || ({image:'image/png',video:'video/mp4',audio:'audio/mpeg'}[record?.kind] || '');
  return mime;
}
async function kyyReferenceUrl(record, sourceId) {
  requireMedia(record);
  const mime=kyyRecordMime(record);
  if (!kyyMimeTypes.has(mime)) throw new Error('参考素材格式不受 kyyReactApi 支持');
  if (cosStorage.enabled && (isLocalMedia(record) || record.provider === 'openai')) return cloudReferenceUrl(record, sourceId);
  if (record.dataUrl?.startsWith('data:') || /^\/api\/video-results\/task-[a-f0-9-]+\.mp4$/.test(record.dataUrl || '')) return modelSettings.createAssetUrl(sourceId,mime);
  let remote;
  try { remote=new URL(record.dataUrl); } catch { throw new Error('素材没有可供 kyyReactApi 读取的公网地址'); }
  if (remote.protocol!=='https:'||remote.username||remote.password) throw new Error('外部参考素材地址必须使用 HTTPS');
  return remote.href;
}
function kyyRecordKind(record) { return record?.kind || ({ image: 'image', video: 'video', audio: 'audio' }[kyyRecordMime(record)?.split('/')[0]] || ''); }
function findMedia(state, sourceId) { return state.assets.find(item => item.id === sourceId) || state.results.find(item => item.id === sourceId); }
async function imageReference(record) {
  requireMedia(record);
  const source = isLocalMedia(record) ? record : { ...record, dataUrl: await downloadImage(record.dataUrl) };
  requireMedia(record);
  const mime = kyyRecordMime(source);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('参考图生图支持 PNG、JPEG、WebP，请替换其他格式或演示图片');
  return { mime, bytes: await localMediaBytes(source) };
}
function isLocalMedia(record) {
  return record?.dataUrl?.startsWith('data:') || /^\/api\/video-results\/task-[a-f0-9-]+\.mp4$/.test(record?.dataUrl || '');
}
async function localMediaBytes(record) {
  requireMedia(record);
  const mime = kyyRecordMime(record);
  const maxBytes = (mime.startsWith('image/') ? 30 : mime.startsWith('video/') ? 50 : 15) * 1024 * 1024;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(record.dataUrl || '');
  let bytes;
  if (match) bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  else if (/^\/api\/video-results\/task-[a-f0-9-]+\.mp4$/.test(record.dataUrl || '')) {
    const file = join(dataDir, 'videos', record.dataUrl.split('/').pop());
    if ((await stat(file)).size > maxBytes) throw new Error('参考素材超过允许大小');
    bytes = await readFile(file);
  } else throw new Error('参考素材必须是有效的本地文件');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('参考素材为空或超过允许大小');
  return bytes;
}
async function syncCloudMedia(record, state) {
  if (!cosStorage.enabled || (!isLocalMedia(record) && record.provider !== 'openai')) return;
  try {
    await cloudReferenceUrl(record, record.id);
    record.cloudUpload = { status: 'uploaded' };
  } catch (err) { record.cloudUpload = { status: 'failed', message: err.message }; }
  await saveState(state);
}
async function cloudReferenceUrl(record, sourceId) {
  requireMedia(record);
  if (!isLocalMedia(record) && record.provider === 'openai') {
    const downloaded = await downloadImage(record.dataUrl);
    requireMedia(record);
    record.dataUrl = downloaded;
    await saveState(await readState());
  }
  try {
    const url = await cosStorage.ensure(sourceId, await localMediaBytes(record), kyyRecordMime(record), Date.parse(record.createdAt)+retentionMs);
    requireMedia(record);
    record.cloudUpload = { status: 'uploaded' };
    await saveState(await readState());
    return url;
  } catch (err) {
    record.cloudUpload = { status: 'failed', message: err.message };
    await saveState(await readState());
    throw err;
  }
}
async function runTask(task, state, config = modelSettings.current()) {
  task.status = 'running'; task.startedAt = now(); await saveState(state);
  try {
    let dataUrl = sampleResult(task.kind, task.prompt);
    let provider = 'local-demo';
    if (task.kind === 'image' && configured('openai', config)) {
      const references = []; let totalBytes = 0;
      for (const sourceId of task.referenceImageIds || []) {
        const image = await imageReference(findMedia(state, sourceId));
        totalBytes += image.bytes.length;
        if (totalBytes > 50 * 1024 * 1024) throw new Error('本次参考图片总大小不能超过 50 MB');
        references.push(image);
      }
      dataUrl = await openaiImage(task.prompt, task.params?.size || '1024x1536', config, references); provider = 'openai';
    }
    if (task.kind === 'video' && configured('seedance', config)) {
      let videoParams = task.params;
      if (task.videoApiType === 'kyyReactApi' && task.params.kyyMedia) {
        const selections=task.params.kyyMedia; videoParams={...task.params}; delete videoParams.kyyMedia;
        for(const [source,target] of [['referenceImageIds','referenceImages'],['referenceVideoIds','referenceVideos'],['referenceAudioIds','referenceAudios']]){
          const ids=selections[source]||[];
          videoParams[target]=await Promise.all(ids.map(sourceId=>{const record=state.assets.find(item=>item.id===sourceId)||state.results.find(item=>item.id===sourceId);return kyyReferenceUrl(record,sourceId);}));
          if(!videoParams[target].length)delete videoParams[target];
        }
        for(const [source,target] of [['firstImageId','firstImage'],['lastImageId','lastImage']])if(selections[source])videoParams[target]=await kyyReferenceUrl(state.assets.find(item=>item.id===selections[source])||state.results.find(item=>item.id===selections[source]),selections[source]);
      }
      const inputImageUrl = task.inputImageId
        ? (cosStorage.enabled || task.videoApiType === 'kyyReactApi' ? await kyyReferenceUrl(findMedia(state, task.inputImageId), task.inputImageId) : requireMedia(findMedia(state, task.inputImageId)).dataUrl)
        : task.inputImageUrl;
      const video = await generateVideo(task.prompt, inputImageUrl, videoParams, config, async update => {
        Object.assign(task, update); await saveState(state);
      });
      if (video.response) { task.upstreamStatus = 'saving'; await saveState(state); }
      dataUrl = video.url || await storeVideo(video.response, task.id);
      provider = video.type;
    }
    await new Promise((resolve) => setTimeout(resolve, provider === 'local-demo' ? 650 : 0));
    const result = { id: id('result'), shotId: task.shotId, taskId: task.id, kind: task.kind, status: 'completed', name: `${task.kind === 'image' ? '图片' : '视频'}结果 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`, dataUrl, provider, prompt: task.prompt, createdAt: now() };
    state.results.push(result); await saveState(state);
    if (task.kind === 'image' && provider !== 'local-demo') await syncCloudMedia(result, state);
    const shot = state.shots.find(item => item.id === task.shotId);
    if (task.kind === 'image' && shot && shot.selectedImageId === task.previousImageId) shot.selectedImageId = result.id;
    task.status = 'completed'; task.provider = provider; task.resultIds = [result.id]; task.completedAt = now(); await saveState(state);
  } catch (err) { task.status = err.uncertain ? 'unknown' : 'failed'; task.error = [config.OPENAI_API_KEY, config.SEEDANCE_API_KEY].filter(Boolean).reduce((message, key) => message.split(key).join('[REDACTED]'), err.message); if (cosStorage.enabled) task.error = cosStorage.redactError(task.error); task.completedAt = now(); await saveState(state); }
}
async function api(req, res, pathname, url) {
  await cleanExpiredMedia();
  if (pathname.startsWith('/api/video-results/') && ['GET','HEAD'].includes(req.method)) return serveVideo(req,res,pathname.slice('/api/video-results/'.length));
  if (pathname.startsWith('/api/kyy-assets/') && ['GET','HEAD'].includes(req.method)) {
    const sourceId=pathname.slice('/api/kyy-assets/'.length), mime=url.searchParams.get('type')||'', expires=url.searchParams.get('expires')||'', signature=url.searchParams.get('signature')||'';
    if(!/^(asset|result)-[A-Za-z0-9_-]+$/.test(sourceId)||!kyyMimeTypes.has(mime)||!await modelSettings.verifyAssetUrl(sourceId,mime,expires,signature))return error(res,'素材链接无效或已过期',403);
    const current=await readState(), record=current.assets.find(item=>item.id===sourceId)||current.results.find(item=>item.id===sourceId);
    requireMedia(record);
    if(kyyRecordMime(record)!==mime)return error(res,'找不到素材',404);
    if (mime === 'video/mp4' && /^\/api\/video-results\/task-[a-f0-9-]+\.mp4$/.test(record.dataUrl || '')) {
      const name = record.dataUrl.split('/').pop();
      const file = join(dataDir, 'videos', name);
      if (!existsSync(file)) return error(res, '素材文件不存在', 404);
      if ((await stat(file)).size > 50 * 1024 * 1024) return error(res, '视频素材超过 50 MB', 413);
      return serveVideo(req, res, name);
    }
    const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(record.dataUrl||'');
    if(!match||match[1]!==mime)return error(res,'素材格式不匹配',415);
    const bytes=Buffer.from(match[2].replace(/\s/g,''),'base64'), maxBytes=(mime.startsWith('image/')?30:mime.startsWith('video/')?50:15)*1024*1024;
    if(bytes.length>maxBytes)return error(res,'素材超过允许大小',413);
    let start = 0, end = bytes.length - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, { 'content-range': 'bytes */' + bytes.length }); return res.end(); }
      start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
      end = range[1] && range[2] ? Math.min(bytes.length - 1, Number(range[2])) : bytes.length - 1;
      if (start > end || start >= bytes.length) { res.writeHead(416, { 'content-range': 'bytes */' + bytes.length }); return res.end(); }
    }
    res.writeHead(req.headers.range ? 206 : 200, { 'content-type': mime, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', ...(req.headers.range ? { 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length } : {}) });
    return res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
  }
  if (pathname === '/api/settings') {
    if (req.method === 'GET') return send(res, 200, { ...modelSettings.publicSettings(), settingsToken });
    if (req.method === 'PUT') {
      if (req.headers['x-settings-token'] !== settingsToken || !req.headers['content-type']?.startsWith('application/json')) return error(res, '请重新打开设置后再保存', 403);
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return error(res, '不允许跨站修改配置', 403); }
        catch { return error(res, '无效的请求来源', 403); }
      }
      try { return send(res, 200, await modelSettings.update(await jsonBody(req, 32768))); }
      catch (err) { return error(res, err instanceof SyntaxError ? '配置 JSON 格式无效' : err.status ? err.message : '配置保存失败，请检查数据目录权限', err instanceof SyntaxError ? 400 : err.status || 500); }
    }
    return error(res, '不支持的配置操作', 405);
  }
  const state = await readState();
  const confirmationRoute=/^\/api\/results\/([^/]+)\/video-confirmation$/.exec(pathname);
  if (confirmationRoute && req.method==='PATCH') {
    const result=state.results.find(item=>item.id===confirmationRoute[1]);
    const projectId=state.shots.find(shot=>shot.id===result?.shotId)?.projectId;
    if(!result || !projectVideos(state,projectId).some(item=>item.id===result.id))return error(res,'找不到已完成的视频',404);
    const body=await jsonBody(req,4096);
    if(typeof body?.confirmed!=='boolean')return error(res,'确认状态必须为布尔值');
    if (body.confirmed) requireMedia(result);
    result.videoConfirmed=body.confirmed;await saveState(state);
    return send(res,200,{id:result.id,videoConfirmed:result.videoConfirmed});
  }
  const singleDownload=/^\/api\/results\/([^/]+)\/download$/.exec(pathname);
  if(req.method==='GET'&&singleDownload) {
    try{
      const result=state.results.find(item=>item.id===singleDownload[1]);
      const projectId=state.shots.find(shot=>shot.id===result?.shotId)?.projectId;
      if(!result || !projectVideos(state,projectId).some(item=>item.id===result.id))return error(res,'找不到已完成的视频',404);
      const file=await videoFile(result,dataDir);
      requireMedia(result);
      const encodedName=encodeURIComponent(downloadName(result.name)).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200,{'content-type':'video/mp4','content-disposition':`attachment; filename="video.mp4"; filename*=UTF-8''${encodedName}`,'cache-control':'private, no-store','content-length':file.size});
      await pipeline(createReadStream(file.path),res);
    }catch(err){if(res.headersSent)res.destroy();else error(res,err.message || '视频下载失败',err.status || 502);}
    return;
  }
  if (req.method === 'GET' && pathname === '/api/bootstrap') return send(res, 200, { ...state, providers: { openai: configured('openai') ? 'configured' : 'demo', seedance: configured('seedance') ? 'configured' : 'demo' }, models: { openai: modelSettings.current().OPENAI_IMAGE_MODEL, seedance: modelSettings.current().SEEDANCE_MODEL }, videoApiType: modelSettings.current().VIDEO_API_TYPE, publicAssetBaseUrl: modelSettings.current().PUBLIC_ASSET_BASE_URL, cloudMediaEnabled: cosStorage.enabled });
  if (req.method === 'PATCH' && pathname.startsWith('/api/projects/')) {
    const project = state.projects.find(item => item.id === pathname.split('/').pop());
    if (!project) return error(res, '找不到画布', 404);
    const body = await jsonBody(req, 2_000_000), canvas = body.canvas;
    if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || !canvas.positions || typeof canvas.positions !== 'object' || Array.isArray(canvas.positions)) return error(res, '画布布局无效');
    const entries = Object.entries(canvas.positions);
    const known = new Set([...state.assets, ...state.results, ...state.tasks].map(item => item.id));
    const generators = canvas.generators ?? [];
    if (!Array.isArray(generators) || generators.length > 100) return error(res, '生图节点最多 100 个');
    const generatorIds = new Set();
    for (const node of generators) {
      if (!node || typeof node.id !== 'string' || !/^gen-[a-f0-9-]{36}$/.test(node.id) || generatorIds.has(node.id) || typeof node.prompt !== 'string' || node.prompt.length > 32000 || !imageSizes.includes(node.size)) return error(res, '生图节点参数无效');
      if (!Array.isArray(node.referenceImageIds) || node.referenceImageIds.length > 8 || node.referenceImageIds.some(id => { const item = findMedia(state,id); return !item || kyyRecordKind(item) !== 'image'; })) return error(res, '生图节点参考图无效');
      node.referenceImageIds=node.referenceImageIds.filter(id=>!mediaExpired(findMedia(state,id)));
      generatorIds.add(node.id);
    }
    const hiddenNodeIds = canvas.hiddenNodeIds ?? [];
    if (!Array.isArray(hiddenNodeIds) || hiddenNodeIds.length > 10000 || hiddenNodeIds.some(id => !known.has(id))) return error(res, '隐藏节点无效');
    for (const id of generatorIds) known.add(id);
    if (entries.length > 10000 || entries.some(([id, p]) => !known.has(id) || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x)>100000 || Math.abs(p.y)>100000)) return error(res, '卡片坐标无效');
    const view = canvas.viewport;
    if (!view || !Number.isFinite(view.x) || !Number.isFinite(view.y) || Math.abs(view.x)>200000 || Math.abs(view.y)>200000 || !Number.isFinite(view.zoom) || view.zoom<.2 || view.zoom>2) return error(res, '画布视图无效');
    if (!Array.isArray(canvas.assetIds) || canvas.assetIds.length>10000 || canvas.assetIds.some(id=>!findMedia(state,id))) return error(res,'画布素材无效');
    project.canvas = { ...(canvas.workflow === 'confirmed-materials-v1' ? { workflow:'confirmed-materials-v1' } : {}), ...(canvas.generators !== undefined ? {generators:generators.map(node => ({id:node.id,prompt:node.prompt,size:node.size,referenceImageIds:[...new Set(node.referenceImageIds)]}))} : {}), ...(canvas.hiddenNodeIds !== undefined ? {hiddenNodeIds:[...new Set(hiddenNodeIds)]} : {}), positions:Object.fromEntries(entries.map(([id,p])=>[id,{x:p.x,y:p.y}])), viewport:{x:view.x,y:view.y,zoom:view.zoom}, assetIds:[...new Set(canvas.assetIds)] };
    project.updatedAt = now(); await saveState(state); return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && pathname === '/api/projects') { const body = await jsonBody(req); if (!body.name?.trim()) return error(res, '请输入项目名称'); const project = { id: id('project'), name: body.name.trim(), description: body.description?.trim() || '', createdAt: now(), updatedAt: now() }; state.projects.unshift(project); await saveState(state); return send(res, 201, project); }
  if (req.method === 'POST' && pathname === '/api/shots') { const body = await jsonBody(req); if (!body.projectId) return error(res, '缺少项目'); const shot = { id: id('shot'), projectId: body.projectId, name: body.name?.trim() || `镜头 ${state.shots.length + 1}`, order: state.shots.filter((s) => s.projectId === body.projectId).length + 1, imagePrompt: body.imagePrompt || '', videoPrompt: body.videoPrompt || '', assetIds: [], selectedImageId: null, selectedVideoId: null, createdAt: now() }; state.shots.push(shot); await saveState(state); return send(res, 201, shot); }
  if (req.method === 'PATCH' && pathname.startsWith('/api/shots/')) {
    const shot = state.shots.find(item => item.id === pathname.split('/').pop());
    if (!shot) return error(res, '找不到镜头', 404);
    const body = await jsonBody(req);
    if (Object.hasOwn(body, 'selectedImageId') && body.selectedImageId !== null) {
      const image = findMedia(state, body.selectedImageId);
      if (!image || kyyRecordKind(image) !== 'image') return error(res, '请选择有效图片', 400);
      requireMedia(image);
    }
    if (body.assetIds !== undefined && (!Array.isArray(body.assetIds) || body.assetIds.some(id => !findMedia(state, id)))) return error(res, '参考素材无效', 400);
    for (const sourceId of body.assetIds || []) requireMedia(findMedia(state,sourceId));
    if (body.selectedVideoId) requireMedia(findMedia(state,body.selectedVideoId));
    Object.assign(shot, { name: body.name ?? shot.name, imagePrompt: body.imagePrompt ?? shot.imagePrompt, videoPrompt: body.videoPrompt ?? shot.videoPrompt, assetIds: body.assetIds ?? shot.assetIds, selectedImageId: Object.hasOwn(body, 'selectedImageId') ? body.selectedImageId : shot.selectedImageId, selectedVideoId: body.selectedVideoId ?? shot.selectedVideoId });
    await saveState(state); return send(res, 200, shot);
  }
  if (req.method === 'POST' && pathname === '/api/assets') { const body = await jsonBody(req, 72_000_000); if (!body.name || !body.dataUrl) return error(res, '素材名称和文件不能为空'); if (body.projectId && !state.projects.some(item => item.id === body.projectId)) return error(res, '找不到画布', 404); const asset = { id: id('asset'), projectId: body.projectId || null, name: body.name, kind: body.kind || 'image', mime: body.mime || '', dataUrl: body.dataUrl, source: 'uploaded', createdAt: now() }; state.assets.unshift(asset); await saveState(state); await syncCloudMedia(asset, state); return send(res, 201, asset); }
  if (req.method === 'DELETE' && pathname.startsWith('/api/assets/')) {
    const assetId = pathname.slice('/api/assets/'.length);
    const index = state.assets.findIndex(asset => asset.id === assetId);
    if (index < 0) return error(res, '找不到素材', 404);
    if (state.shots.some(shot => shot.selectedImageId === assetId || (Array.isArray(shot.assetIds) && shot.assetIds.includes(assetId)))) return error(res, '素材仍被镜头引用，请先解除引用', 409);
    if (state.tasks.some(task => ['queued', 'running'].includes(task.status) && (task.inputImageId === assetId || task.referenceImageIds?.includes(assetId) || Object.values(task.params?.kyyMedia || {}).some(value => Array.isArray(value) ? value.includes(assetId) : value === assetId)))) return error(res, '素材正在生成任务中使用，请等待任务结束', 409);
    const [removed] = state.assets.splice(index, 1);
    for (const project of state.projects) if (project.canvas) { project.canvas.assetIds = project.canvas.assetIds.filter(id => id !== assetId); delete project.canvas.positions[assetId]; project.canvas.hiddenNodeIds = (project.canvas.hiddenNodeIds || []).filter(id => id !== assetId); for (const node of project.canvas.generators || []) node.referenceImageIds = node.referenceImageIds.filter(id => id !== assetId); }
    await saveState(state);
    return send(res, 200, { ok: true, id: removed.id });
  }
  if (req.method === 'POST' && pathname === '/api/tasks') {
    const body=await jsonBody(req);
    if(!body.shotId||!['image','video'].includes(body.kind)||typeof body.prompt!=='string'||!body.prompt.trim())return error(res,'镜头、任务类型和提示词不能为空');
    if(!state.shots.some(shot=>shot.id===body.shotId))return error(res,'找不到镜头',404);
    if (body.imageNodeId !== undefined) {
      const project = state.projects.find(item => item.id === state.shots.find(shot => shot.id === body.shotId).projectId);
      if (body.kind !== 'image' || !project?.canvas?.generators?.some(node => node.id === body.imageNodeId)) return error(res,'生图节点不存在',400);
      if (state.tasks.some(task => task.imageNodeId === body.imageNodeId && ['queued','running'].includes(task.status))) return error(res,'该节点正在生成，请等待完成',409);
    }
    if (body.inputImageId) {
      const record = state.results.find(item => item.id === body.inputImageId) || state.assets.find(item => item.id === body.inputImageId);
      if (body.kind !== 'video' || !record || kyyRecordKind(record) !== 'image') return error(res, '找不到参考图片', 400);
      requireMedia(record);
    }
    const config=modelSettings.current(), params=body.params||{};
    const referenceImageIds = body.referenceImageIds ?? [];
    if (!Array.isArray(referenceImageIds) || referenceImageIds.length > 8 || referenceImageIds.some(id => typeof id !== 'string')) return error(res, '参考图片最多选择 8 张', 400);
    if (body.kind !== 'image' && referenceImageIds.length) return error(res, '此参考图列表仅用于图片生成', 400);
    for (const sourceId of referenceImageIds) {
      const image = findMedia(state, sourceId);
      if (!image || kyyRecordKind(image) !== 'image') return error(res, '参考图片不存在或类型不匹配', 400);
      requireMedia(image);
      if (configured('openai', config) && !['image/png', 'image/jpeg', 'image/webp'].includes(kyyRecordMime(image))) return error(res, '参考图生图支持 PNG、JPEG、WebP，请替换其他格式或演示图片', 400);
    }
    if (body.kind === 'image' && (body.prompt.length > 32000 || !imageSizes.includes(params.size || '1024x1536'))) return error(res, '图片提示词过长或尺寸不受支持', 400);
    if(typeof params!=='object'||Array.isArray(params))return error(res,'无效的生成参数',400);
    if(body.kind==='video'&&config.VIDEO_API_TYPE==='kyyReactApi'&&body.kyyMedia){
      const media=body.kyyMedia, groups=[['referenceImageIds','image',9],['referenceVideoIds','video',3],['referenceAudioIds','audio',3]];
      if(!media||typeof media!=='object'||Array.isArray(media))return error(res,'参考素材格式无效',400);
      for (const sourceId of [...groups.flatMap(([field])=>Array.isArray(media[field])?media[field]:[]),media.firstImageId,media.lastImageId].filter(Boolean)) requireMedia(findMedia(state,sourceId));
      const hasSelected=groups.some(([field])=>(media[field]||[]).length)||media.firstImageId||media.lastImageId;
      if(hasSelected&&!cosStorage.enabled&&!config.PUBLIC_ASSET_BASE_URL){const ids=[...(media.referenceImageIds||[]),...(media.referenceVideoIds||[]),...(media.referenceAudioIds||[]),media.firstImageId,media.lastImageId].filter(Boolean);const needsRelay=ids.some(sourceId=>{const record=state.assets.find(item=>item.id===sourceId)||state.results.find(item=>item.id===sourceId);return record?.dataUrl?.startsWith('data:') || record?.dataUrl?.startsWith('/api/video-results/');});if(needsRelay)return error(res,'请在模型设置填写公网 HTTPS 素材访问地址；本机素材需通过此地址供 kyyReactApi 读取。',400);} 
      for(const[field,kind,max]of groups){const ids=media[field]||[];if(!Array.isArray(ids)||ids.length>max)return error(res,field+' 最多选择 '+max+' 个素材',400);for(const sourceId of ids){const record=state.assets.find(item=>item.id===sourceId)||state.results.find(item=>item.id===sourceId);if(!record||kyyRecordKind(record)!==kind||!kyyMimeTypes.has(kyyRecordMime(record)))return error(res,'参考素材不存在、类型不匹配或格式不受支持',400);}}
      for(const[field,kind]of[['firstImageId','image'],['lastImageId','image']])if(media[field]){const record=state.assets.find(item=>item.id===media[field])||state.results.find(item=>item.id===media[field]);if(!record||kyyRecordKind(record)!==kind||!kyyMimeTypes.has(kyyRecordMime(record)))return error(res,'首帧或尾帧素材不存在、类型不匹配或格式不受支持',400);}
      if((media.firstImageId||media.lastImageId)&&groups.some(([field])=>(media[field]||[]).length))return error(res,'首帧/尾帧不能与多模态参考素材混用',400);
      if((media.referenceAudioIds||[]).length&&!(media.referenceImageIds||[]).length&&!(media.referenceVideoIds||[]).length)return error(res,'参考音频必须同时包含图片或视频参考素材',400);
    }
    if(body.kind==='video'&&configured('seedance',config)){
      try{
        const media=body.kyyMedia||{};
        const checked=config.VIDEO_API_TYPE==='kyyReactApi'?{...params,referenceImages:(media.referenceImageIds||[]).map(()=> 'https://asset-validation.invalid/image'),referenceVideos:(media.referenceVideoIds||[]).map(()=> 'https://asset-validation.invalid/video'),referenceAudios:(media.referenceAudioIds||[]).map(()=> 'https://asset-validation.invalid/audio'),firstImage:media.firstImageId?'https://asset-validation.invalid/first':undefined,lastImage:media.lastImageId?'https://asset-validation.invalid/last':undefined}:params;
        videoRequest(body.prompt,body.inputImageUrl,checked,config);
      }catch(err){return error(res,err.message,err.status||400);}
    }
    const taskParams={...params};if(body.kind==='video'&&body.kyyMedia)taskParams.kyyMedia=body.kyyMedia;
    const task={id:id('task'),...(body.imageNodeId ? {imageNodeId:body.imageNodeId} : {}),shotId:body.shotId,kind:body.kind,prompt:body.prompt.trim(),inputImageUrl:body.inputImageUrl||null,inputImageId:body.inputImageId||null,referenceImageIds:[...new Set(referenceImageIds)],previousImageId:state.shots.find(shot=>shot.id===body.shotId).selectedImageId,params:taskParams,status:'queued',createdAt:now(),model:body.kind==='image'?config.OPENAI_IMAGE_MODEL:config.SEEDANCE_MODEL,...(body.kind==='video'?{videoApiType:config.VIDEO_API_TYPE}:{})};
    state.tasks.unshift(task);await saveState(state);void runTask(task,state,config);return send(res,202,task);
  }
  if (req.method === 'POST' && pathname.startsWith('/api/results/')) { const result = state.results.find((r) => r.id === pathname.split('/').pop()); if (!result) return error(res, '找不到结果', 404); requireMedia(result); const body = await jsonBody(req); const shot = state.shots.find((s) => s.id === result.shotId); if (!shot) return error(res, '找不到镜头', 404); if (result.kind === 'image') shot.selectedImageId = result.id; if (result.kind === 'video') shot.selectedVideoId = result.id; await saveState(state); return send(res, 200, shot); }
  if (req.method === 'POST' && pathname === '/api/export') { const body = await jsonBody(req); const shotIds = body.shotIds || []; const shots = state.shots.filter((s) => shotIds.includes(s.id)); return send(res, 200, { ok: true, filename: `ai-media-flow-${Date.now()}.json`, manifest: shots.map((shot) => ({ name: shot.name, image: findMedia(state, shot.selectedImageId)?.name || null, video: state.results.find((r) => r.id === shot.selectedVideoId)?.name || null })) }); }
  return error(res, '接口不存在', 404);
}
async function serve(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`),pathname = decodeURIComponent(url.pathname);
    if(await access.handle(req,res,pathname))return;
    const loginFile=({'/login':'login.html','/login.js':'login.js','/login.css':'login.css'})[pathname];
    if(loginFile && ['GET','HEAD'].includes(req.method)){
      const file=join(publicDir,loginFile);
      res.writeHead(200,{'content-type':mimeTypes[extname(file)],'cache-control':'no-store','x-frame-options':'DENY','content-security-policy':"default-src 'self'; frame-ancestors 'none'; form-action 'self'"});
      return res.end(req.method==='HEAD'?undefined:await readFile(file));
    }
    // Providers cannot log in; this narrow GET/HEAD route still requires its existing expiring HMAC signature.
    const signedMedia=pathname.startsWith('/api/kyy-assets/')&&['GET','HEAD'].includes(req.method);
    if(!signedMedia&&!access.session(req)){
      if(pathname.startsWith('/api/')||pathname!=='/')return send(res,401,{error:'请先输入访问密码',code:'AUTH_REQUIRED'});
      res.writeHead(303,{location:'/login?next='+encodeURIComponent(url.pathname+url.search),'cache-control':'no-store'});return res.end();
    }
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!access.sameSite(req))return error(res,'不允许跨站修改数据',403);
    if(pathname.startsWith('/api/'))return await api(req,res,pathname,url);
    const file=pathname==='/'?join(publicDir,'index.html'):join(publicDir,pathname);
    if(!file.startsWith(publicDir+ (process.platform==='win32'?'\\':'/'))||!existsSync(file))return error(res,'页面不存在',404);
    const info=await stat(file);if(!info.isFile())return error(res,'页面不存在',404);
    res.writeHead(200,{'content-type':mimeTypes[extname(file)]||'application/octet-stream','cache-control':'no-store','x-frame-options':'DENY'});res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch(err){if(res.headersSent)return res.destroy();error(res,err instanceof URIError?'地址格式无效':err.message||'服务器错误',err instanceof URIError?400:err.status||500);}
}
await ensureState();
await cleanExpiredMedia(true);
let cloudCleanupPending;
function maintainMedia() {
  return cleanExpiredMedia(true).then(()=>{
    cloudCleanupPending ||= cleanExpiredCloud().catch(err=>console.error('云端资源清理失败，将重试：',err.message)).finally(()=>{cloudCleanupPending=undefined;});
  }).catch(err=>console.error('过期资源清理失败，将重试：',err.message));
}
void maintainMedia();
setInterval(maintainMedia,60000).unref();
createServer(serve).listen(port, '0.0.0.0', function () {
  const url = `http://localhost:${this.address().port}`;
  console.log(`AI Media Flow running on ${url}`);
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    execFile('cmd.exe', ['/d', '/c', 'start', '', url], (err) => {
      if (err) console.error(`Could not open the browser. Open ${url} manually.`);
    });
  }
});
