import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {imageOriginal} from './image-originals.js';
import {videoFile} from './video-download.js';
import {requireMedia, retentionMs} from './media-retention.js';

const execute = promisify(execFile);
const validId = /^(?:asset|result)-[A-Za-z0-9_-]+$/;
const fallback = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320"><rect width="480" height="320" fill="#eeeae5"/><text x="240" y="160" text-anchor="middle" fill="#766e65" font-size="18">预览暂不可用</text></svg>');

function inlineBytes(source) {
  const match = /^data:((?:image|video)\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match) throw new Error('不支持的预览格式');
  const bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('素材为空或过大');
  return bytes;
}

export async function renderMediaPreview(record, dataDir) {
  if (!validId.test(record.id)) throw new Error('无效的素材 ID');
  let input;
  if (record.kind === 'image' || record.dataUrl?.startsWith('data:image/')) {
    const source = await imageOriginal(record);
    input = inlineBytes(source);
  } else if (record.kind === 'video') {
    let path;
    if (record.dataUrl?.startsWith('data:video/')) {
      path = join(dataDir, 'previews', record.id + '.source.mp4');
      await mkdir(join(dataDir, 'previews'), {recursive:true});
      await writeFile(path, inlineBytes(record.dataUrl), {mode:0o600});
    } else {
      ({path} = await videoFile(record, dataDir));
    }
    // Decode local media only. Remote downloads use the existing DNS/size checks.
    const {stdout} = await execute(process.env.FFMPEG_PATH || ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi',
      '-i', path, '-map', '0:v:0', '-frames:v', '1', '-an',
      '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
      '-threads', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ], {encoding:'buffer', timeout:30000, maxBuffer:4*1024*1024, windowsHide:true});
    input = stdout;
  } else throw new Error('此素材不支持缩略图');
  return sharp(input, {limitInputPixels:64*1024*1024}).rotate()
    .resize({width:480, height:480, fit:'inside', withoutEnlargement:true})
    .webp({quality:76}).toBuffer();
}

export function createMediaPreviews(dataDir, render = renderMediaPreview) {
  const pending = new Map(), failures = new Map(), queue = [];
  let active = 0;
  async function limited(work) {
    if (active >= 2) await new Promise(resolve => queue.push(resolve));
    else active++;
    try { return await work(); }
    finally { if (queue.length) queue.shift()(); else active--; }
  }
  async function get(record) {
    requireMedia(record);
    if (!validId.test(record.id) || !['image','video'].includes(record.kind)) throw Object.assign(new Error('素材不支持预览'), {status:415});
    // Media IDs are immutable; cache across refreshes and server restarts.
    if (pending.has(record.id)) return pending.get(record.id);
    if (failures.get(record.id) > Date.now()) throw new Error('预览生成暂不可用');
    if (pending.size >= 256) throw new Error('预览生成繁忙');
    const operation = limited(async () => {
      const path = join(dataDir, 'previews', record.id + '.webp');
      try { return await readFile(path); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      requireMedia(record);
      const bytes = await render(record, dataDir);
      requireMedia(record);
      await mkdir(join(dataDir, 'previews'), {recursive:true});
      await writeFile(path+'.tmp', bytes, {mode:0o600});
      await rename(path+'.tmp', path);
      return bytes;
    }).catch(err => {
      if (failures.size >= 256) failures.delete(failures.keys().next().value);
      failures.set(record.id, Date.now()+60000);
      throw err;
    }).finally(() => pending.delete(record.id));
    pending.set(record.id, operation);
    return operation;
  }
  async function serve(req, res, record) {
    requireMedia(record);
    let bytes;
    try { bytes = await get(record); }
    catch (err) {
      requireMedia(record);
      if (err.status) throw err;
      res.writeHead(200, {'content-type':'image/svg+xml; charset=utf-8', 'cache-control':'no-store', 'content-length':fallback.length, 'x-content-type-options':'nosniff'});
      return res.end(req.method === 'HEAD' ? undefined : fallback);
    }
    requireMedia(record);
    const remaining = Math.floor((Date.parse(record.createdAt)+retentionMs-Date.now())/1000);
    const headers = {'content-type':'image/webp', 'cache-control':'private, max-age='+Math.max(0,Math.min(3600,remaining || 0)), 'x-content-type-options':'nosniff'};
    res.writeHead(200, {...headers, 'content-length':bytes.length});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  return {get, serve};
}
