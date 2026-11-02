import test from 'node:test';
import assert from 'node:assert/strict';
import { startWorkflowServer } from './fixtures/workflow-server.js';

const app = await startWorkflowServer();
const json = (path, options) => app.fetch(app.base + path, { headers: { 'content-type': 'application/json' }, ...options }).then(async response => ({ response, value: await response.json() }));

test('deletes unreferenced assets and protects referenced assets', async () => {
  const project = await json('/api/projects', { method: 'POST', body: JSON.stringify({ name: '素材测试' }) });
  const asset = await json('/api/assets', { method: 'POST', body: JSON.stringify({ name: 'paste.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }) });
  assert.equal(asset.response.status, 201);
  const shot = await json('/api/shots', { method: 'POST', body: JSON.stringify({ projectId: project.value.id, name: '引用素材' }) });
  const patch = await json('/api/shots/' + shot.value.id, { method: 'PATCH', body: JSON.stringify({ assetIds: [asset.value.id] }) });
  assert.equal(patch.response.status, 200, JSON.stringify(patch.value));
  const blocked = await json('/api/assets/' + asset.value.id, { method: 'DELETE' });
  assert.equal(blocked.response.status, 409);
  await json('/api/shots/' + shot.value.id, { method: 'PATCH', body: JSON.stringify({ assetIds: [] }) });
  const deleted = await json('/api/assets/' + asset.value.id, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const bootstrap = await json('/api/bootstrap');
  assert.equal(bootstrap.value.assets.some(item => item.id === asset.value.id), false);
});

test.after(app.stop);
