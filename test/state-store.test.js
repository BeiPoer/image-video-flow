import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:buffer';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStateStore } from '../state-store.js';
import { expireResources, retentionMs } from '../media-retention.js';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-state-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'ai-flow-state-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('media exceeding the aggregate string limit saves and reloads without building a giant JSON string', async t => {
  const dir = await directory(t), store = createStateStore(dir), state = await store.read();
  const source = 'data:image/png;base64,' + 'a'.repeat(1024 * 1024);
  const count = Math.ceil(constants.MAX_STRING_LENGTH / source.length) + 1;
  state.assets = Array.from({ length: count }, (_, i) => ({ id: 'asset-' + i, dataUrl: source }));
  state.tasks.push({ inputImageUrl: source, params: { referenceImages: [source] } });
  assert.ok(count * source.length > constants.MAX_STRING_LENGTH);
  await store.save(state);
  const metadata = await readFile(join(dir, 'state.json'), 'utf8');
  assert.ok(metadata.length < count * 200); assert.doesNotMatch(metadata, /base64,/);
  assert.equal((await readdir(join(dir, 'inline-media'))).length, 1, 'shared media is written only once');
  const restored = await createStateStore(dir).read();
  assert.equal(restored.assets.length, count);
  assert.ok(restored.assets.every(asset => asset.dataUrl === source));
  assert.equal(restored.tasks[0].inputImageUrl, source);
  assert.deepEqual(restored.tasks[0].params.referenceImages, [source]);
});

test('legacy data migrates losslessly and shared files survive until all references expire', async t => {
  const dir = await directory(t), time = Date.now(), source = 'data:audio/mpeg;base64,YQ==';
  const old = new Date(time - retentionMs).toISOString(), fresh = new Date(time).toISOString();
  const legacy = { projects: [], shots: [], results: [], assets: [{ id: 'old', createdAt: old, dataUrl: source }, { id: 'fresh', createdAt: fresh, dataUrl: source }], tasks: [{ createdAt: old, inputImageUrl: source }] };
  await writeFile(join(dir, 'state.json'), JSON.stringify(legacy));
  const store = createStateStore(dir), state = await store.read();
  assert.deepEqual(state, legacy);
  await store.save(state);
  await expireResources(state, dir, store.save, time); await store.prune();
  assert.equal((await readdir(join(dir, 'inline-media'))).length, 1);
  assert.equal((await createStateStore(dir).read()).assets[1].dataUrl, source);
  await expireResources(state, dir, store.save, time + retentionMs); await store.prune();
  assert.deepEqual(await readdir(join(dir, 'inline-media')), []);
  const restored = await createStateStore(dir).read();
  assert.ok(restored.assets.every(asset => asset.deletedAt && !asset.dataUrl));
});

test('failed writes keep the last committed state and media; queued snapshots and later retries remain usable', async t => {
  const dir = await directory(t), store = createStateStore(dir), state = await store.read();
  state.assets.push({ id: 'original', dataUrl: 'data:image/png;base64,YQ==' }); await store.save(state);
  const previous = await readFile(join(dir, 'state.json'), 'utf8');
  const blocker = join(dir, 'state.json.tmp'); await mkdir(blocker);
  state.assets[0].dataUrl = 'data:image/png;base64,Yg==';
  await assert.rejects(store.save(state));
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), previous);
  assert.deepEqual(await store.prune(), []);
  assert.equal((await createStateStore(dir).read()).assets[0].dataUrl, 'data:image/png;base64,YQ==');
  await rmdir(blocker);
  const first = store.save(state); state.assets[0].name = 'latest'; const second = store.save(state);
  await Promise.all([first, second]); await store.prune();
  assert.deepEqual(await createStateStore(dir).read(), state);
  assert.equal((await readdir(join(dir, 'inline-media'))).length, 1);
});

test('invalid or missing media references fail instead of silently discarding saved data', async t => {
  const dir = await directory(t);
  for (const hash of ['../outside', '0'.repeat(64)]) {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ $inlineMedia: 1, dataUrl: { $media: hash } }));
    await assert.rejects(createStateStore(dir).read());
  }
});

test('literal marker-shaped input survives legacy migration and new-format reloads', async t => {
  const dir = await directory(t), state = { projects: [], shots: [], assets: [], results: [], tasks: [{ params: { custom: { $media: '../literal' }, nested: { $literal: { $media: 'data:image/png;base64,YQ==' } } } }] };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  const store = createStateStore(dir);
  assert.deepEqual(await store.read(), state);
  await store.save(state);
  assert.deepEqual(await createStateStore(dir).read(), state);
});
