import {loginFetch,testPassword} from './fixtures/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';

const port = 4192;
const dataDir = './data-assets-test';
const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, APP_ACCESS_PASSWORD:testPassword, APP_COOKIE_SECURE:'false', AI_FLOW_PORT: String(port), AI_FLOW_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server start timeout')), 3000); child.stdout.on('data', chunk => { if (String(chunk).includes('running')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); });
const fetch=await loginFetch(`http://localhost:${port}`);
const json = (path, options) => fetch(`http://localhost:${port}${path}`, { headers: { 'content-type': 'application/json' }, ...options }).then(async response => ({ response, value: await response.json() }));

test('deletes unreferenced assets and protects referenced assets', async () => {
  const project = await json('/api/projects', { method: 'POST', body: JSON.stringify({ name: '素材测试' }) });
  const asset = await json('/api/assets', { method: 'POST', body: JSON.stringify({ name: 'paste.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }) });
  assert.equal(asset.response.status, 201);
  const shot = await json('/api/shots', { method: 'POST', body: JSON.stringify({ projectId: project.value.id, name: '引用素材' }) });
  const patch = await json('/api/shots/' + shot.value.id, { method: 'PATCH', body: JSON.stringify({ assetIds: [asset.value.id] }) });
  assert.equal(patch.response.status, 200);
  const blocked = await json('/api/assets/' + asset.value.id, { method: 'DELETE' });
  assert.equal(blocked.response.status, 409);
  await json('/api/shots/' + shot.value.id, { method: 'PATCH', body: JSON.stringify({ assetIds: [] }) });
  const deleted = await json('/api/assets/' + asset.value.id, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const bootstrap = await json('/api/bootstrap');
  assert.equal(bootstrap.value.assets.some(item => item.id === asset.value.id), false);
});

test.after(async () => { child.kill(); await once(child, 'exit').catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
