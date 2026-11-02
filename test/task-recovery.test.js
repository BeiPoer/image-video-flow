import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkflowServer, png } from './fixtures/workflow-server.js';
import { retentionMs } from '../media-retention.js';

test('startup repairs saved results, resumes known videos and marks interrupted jobs without resubmitting', async t => {
  const createdAt = new Date().toISOString(), old = new Date(Date.now() - retentionMs - 1000).toISOString();
  const video = { kind: 'video', status: 'running', shotId: 's', createdAt, prompt: 'resume', params: {}, videoApiType: 'volcengine', remoteTaskId: 'mock-video' };
  const initial = {
    projects: [{ id: 'p' }], shots: [{ id: 's', projectId: 'p', selectedImageId: null }],
    assets: [{ id: 'asset-old', kind: 'image', dataUrl: 'data:image/png;base64,' + png, createdAt: old }],
    results: [{ id: 'result-saved', taskId: 'task-image', shotId: 's', kind: 'image', provider: 'openai', createdAt, dataUrl: 'data:image/png;base64,' + png }],
    tasks: [
      { ...video, id: 'task-aaaa', inputImageId: 'asset-old' },
      { ...video, id: 'task-bbbb', status: 'unknown' },
      { ...video, id: 'task-other-type', videoApiType: 'openai' },
      { ...video, id: 'task-other-server', videoBaseUrl: 'https://previous.example/v3' },
      { ...video, id: 'task-expired', createdAt: old },
      { ...video, id: 'task-failed', status: 'failed', error: 'upstream failed' },
      { id: 'task-image', kind: 'image', status: 'running', shotId: 's', previousImageId: null, createdAt },
      { id: 'task-interrupted', kind: 'image', status: 'running', shotId: 's', createdAt },
      { id: 'task-queued', kind: 'video', status: 'queued', shotId: 's', createdAt },
    ],
  };
  const app = await startWorkflowServer(initial); t.after(app.stop);
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = await (await app.fetch(app.base + '/api/bootstrap')).json();
    if (snapshot.tasks.every(task => !['queued', 'running'].includes(task.status))) break;
    await delay(20);
  }
  for (const id of ['task-aaaa', 'task-bbbb', 'task-image']) assert.equal(snapshot.tasks.find(task => task.id === id).status, 'completed');
  for (const id of ['task-other-type', 'task-other-server', 'task-expired', 'task-interrupted', 'task-queued']) assert.equal(snapshot.tasks.find(task => task.id === id).status, 'unknown');
  assert.equal(snapshot.tasks.find(task => task.id === 'task-failed').status, 'failed');
  assert.equal(snapshot.shots[0].selectedImageId, 'result-saved');
  assert.equal(snapshot.results.length, 3, 'saved results must not be generated twice');
  assert.equal(app.calls.length, 2);
  assert.ok(app.calls.every(call => call.path === '/v3/contents/generations/tasks/mock-video' && call.body === null), 'recovery only queries existing paid jobs');
});

test('persistent state write failures leave the application responsive and expose uncertainty', async t => {
  const app = await startWorkflowServer(); t.after(app.stop); app.holdImages();
  async function api(path, body) {
    const response = await app.fetch(app.base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok); return response.json();
  }
  const project = await api('/api/projects', { name: 'persistence failure' });
  const shot = await api('/api/shots', { projectId: project.id });
  const submitted = await api('/api/tasks', { kind: 'image', shotId: shot.id, prompt: 'held image' });
  for (let i = 0; i < 100 && !app.calls.length; i++) await delay(10);
  assert.equal(app.calls.length, 1);
  const blocker = join(app.dir, 'state.json.tmp'); await mkdir(blocker); app.releaseImages();
  let task;
  for (let i = 0; i < 100; i++) {
    task = (await api('/api/bootstrap')).tasks.find(task => task.id === submitted.id);
    if (task.status === 'unknown') break;
    await delay(20);
  }
  assert.equal(task.status, 'unknown'); assert.match(task.error, /保存失败/);
  assert.equal(app.calls.length, 1);
  await rmdir(blocker);
  await api('/api/projects', { name: 'server still works' });
});
