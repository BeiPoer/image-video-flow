import {downloadImage} from './image-source.js';
import {requireMedia} from './media-retention.js';

// Resolve source bytes for thumbnail generation or provider inputs only.
// External originals are transient; full-size browser previews use the original URL.
export async function imageOriginal(record, download = downloadImage) {
  requireMedia(record);
  if (!/^(?:asset|result)-[A-Za-z0-9_-]+$/.test(record.id)) throw Object.assign(new Error('无效的素材 ID'), {status:400});
  if (record.dataUrl?.startsWith('data:image/')) return record.dataUrl;
  if (record.kind !== 'image') throw Object.assign(new Error('素材不是图片'), {status:415});
  const source = await download(record.dataUrl);
  requireMedia(record);
  return source;
}
