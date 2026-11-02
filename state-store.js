import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function createStateStore(dataDir) {
  const statePath = join(dataDir, 'state.json'), mediaDir = join(dataDir, 'inline-media');
  let ready, writes = Promise.resolve(), mediaBySource = new Map(), liveFiles = new Set();
  const filesOnDisk = new Set();
  // shortcut: one process owns this store; use a database before adding multiple workers.
  function read() {
    return ready ||= (async () => {
      await mkdir(dataDir, { recursive: true });
      let state;
      try { state = JSON.parse(await readFile(statePath, 'utf8')); }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return { projects: [], assets: [], shots: [], tasks: [], results: [] };
      }
      if (state.$inlineMedia !== 1) return state;
      delete state.$inlineMedia;
      const sources = new Map();
      async function restore(value) {
        if (!value || typeof value !== 'object') return value;
        if (Object.keys(value).length === 1 && Object.hasOwn(value, '$literal')) {
          if (!Array.isArray(value.$literal) || value.$literal.some(pair => !Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string')) throw new Error('无效的状态对象');
          return Object.fromEntries(await restore(value.$literal));
        }
        if (Object.keys(value).length === 1 && Object.hasOwn(value, '$media')) {
          const hash = value.$media;
          if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('无效的媒体文件引用');
          if (!sources.has(hash)) sources.set(hash, await readFile(join(mediaDir, hash + '.data'), 'utf8'));
          const source = sources.get(hash);
          mediaBySource.set(source, hash); filesOnDisk.add(hash); liveFiles.add(hash);
          return source;
        }
        for (const key of Object.keys(value)) value[key] = await restore(value[key]);
        return value;
      }
      return restore(state);
    })();
  }
  function save(state) {
    const media = new Map();
    // Replace payloads before stringify joins them into a single size-limited string.
    const snapshot = JSON.stringify({ ...state, $inlineMedia: 1 }, (key, value) => {
      if (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 1 && (Object.hasOwn(value, '$media') || Object.hasOwn(value, '$literal'))) return { $literal: Object.entries(value) };
      if (typeof value !== 'string' || !value.startsWith('data:')) return value;
      const hash = mediaBySource.get(value) || createHash('sha256').update(value).digest('hex');
      mediaBySource.set(value, hash); media.set(hash, value);
      return { $media: hash };
    }, 2);
    mediaBySource = new Map([...media].map(([hash, source]) => [source, hash]));
    const write = writes.then(async () => {
      await mkdir(mediaDir, { recursive: true });
      for (const [hash, source] of media) if (!filesOnDisk.has(hash)) {
        const file = join(mediaDir, hash + '.data');
        await writeFile(file + '.tmp', source);
        await rename(file + '.tmp', file);
        filesOnDisk.add(hash);
      }
      await writeFile(statePath + '.tmp', snapshot);
      await rename(statePath + '.tmp', statePath);
      liveFiles = new Set(media.keys());
    });
    writes = write.catch(() => {});
    return write;
  }
  function prune() {
    const sweep = writes.then(async () => {
      const errors = [];
      let entries;
      try { entries = await readdir(mediaDir); }
      catch (err) { if (err.code === 'ENOENT') return errors; throw err; }
      for (const name of entries) {
        const match = /^([a-f0-9]{64})\.data(\.tmp)?$/.exec(name);
        if (!match || (!match[2] && liveFiles.has(match[1]))) continue;
        try {
          await rm(join(mediaDir, name), { force: true });
          if (!match[2]) filesOnDisk.delete(match[1]);
        } catch (err) { errors.push(err); }
      }
      return errors;
    });
    writes = sweep.catch(() => {});
    return sweep;
  }
  return { read, save, prune };
}
