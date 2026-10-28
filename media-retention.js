import {createHash} from 'node:crypto';
import {readdir,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';

export const retentionMs = 7 * 24 * 60 * 60 * 1000;
const pendingSaves = new WeakSet();
export function mediaExpired(record, time = Date.now()) {
  return Boolean(record?.deletedAt) || time - Date.parse(record?.createdAt) >= retentionMs;
}
export function requireMedia(record) {
  if (!record) throw Object.assign(new Error('找不到素材'), {status:404});
  if (mediaExpired(record)) throw Object.assign(new Error('资源已删除（超过 7 天），请重新上传或选择其他素材'), {status:410});
  return record;
}
function filesFor(record) {
  const local = /^\/api\/video-results\/(task-[a-f0-9-]+\.mp4)$/.exec(record.dataUrl || '');
  if (local) return ['videos/' + local[1]];
  if (record.kind === 'video' && /^https?:\/\//.test(record.dataUrl || '')) return ['video-downloads/' + createHash('sha256').update(record.dataUrl).digest('hex') + '.mp4'];
  return [];
}
// Keep pending filenames on tombstones so a failed disk deletion is retried after restart.
export async function expireResources(state, dataDir, save, time = Date.now(), scanFiles = true) {
  const records = [...state.assets, ...state.results], expired = new Set();
  const errors = [];
  async function persist() { pendingSaves.add(state); await save(state); pendingSaves.delete(state); }
  let changed = false;
  for (const record of records) {
    if (!Number.isFinite(Date.parse(record.createdAt))) { record.createdAt = new Date(time).toISOString(); changed = true; }
    if (!mediaExpired(record,time)) continue;
    expired.add(record.id);
    if (!record.deletedAt || record.dataUrl) {
      record.purgeFiles = [...new Set([...(record.purgeFiles || []), ...filesFor(record)])];
      record.deletedAt ||= new Date(time).toISOString();
      delete record.dataUrl; delete record.cloudUpload;
      changed = true;
    }
  }
  for (const shot of state.shots) {
    for (const field of ['selectedImageId','selectedVideoId']) if (expired.has(shot[field])) { shot[field] = null; changed = true; }
    if (shot.assetIds?.some(id=>expired.has(id))) { shot.assetIds = shot.assetIds.filter(id=>!expired.has(id)); changed = true; }
  }
  for (const project of state.projects) for (const node of project.canvas?.generators || []) {
    if (node.referenceImageIds?.some(id=>expired.has(id))) { node.referenceImageIds = node.referenceImageIds.filter(id=>!expired.has(id)); changed = true; }
  }
  for (const task of state.tasks) if (mediaExpired(task,time)) {
    if (task.inputImageUrl) { delete task.inputImageUrl; changed = true; }
    for (const field of ['referenceImages','referenceVideos','referenceAudios','firstImage','lastImage']) if (task.params?.[field]) { delete task.params[field]; changed = true; }
  }
  if (changed || pendingSaves.has(state)) await persist();
  changed = false;
  const liveFiles = new Set(records.filter(record=>!mediaExpired(record,time)).flatMap(filesFor));
  for (const record of records) if (record.deletedAt && record.purgeFiles?.length) {
    for (const file of [...record.purgeFiles]) {
      if (!/^(?:videos\/task-[a-f0-9-]+|video-downloads\/[a-f0-9]{64})\.mp4$/.test(file)) throw new Error('无效的过期资源文件路径');
      try { if (!liveFiles.has(file)) await rm(join(dataDir,file),{force:true}); }
      catch (err) { errors.push(err); continue; }
      record.purgeFiles = record.purgeFiles.filter(value=>value!==file); changed = true;
    }
  }
  if (changed) await persist();
  if (!scanFiles) return errors;
  // Also remove old orphan downloads, recovered videos and interrupted temporary files.
  for (const folder of ['videos','video-downloads','recovered-videos']) {
    let entries;
    try { entries = await readdir(join(dataDir,folder),{withFileTypes:true}); }
    catch (err) { if (err.code!=='ENOENT') errors.push(err); continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mp4|tmp)$/.test(entry.name) || liveFiles.has(folder+'/'+entry.name)) continue;
      const file=join(dataDir,folder,entry.name);
      try {
        const task=folder==='recovered-videos'?state.tasks.find(task=>entry.name===task.remoteTaskId+'.mp4'):null;
        const created=task?Date.parse(task.completedAt||task.createdAt):(await stat(file)).mtimeMs;
        if (time-created>=retentionMs) await rm(file,{force:true});
      } catch (err) { if(err.code!=='ENOENT')errors.push(err); }
    }
  }
  return errors;
}
