import {loginFetch,testPassword} from './fixtures/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('real COS SDK and application upload → signed download → kyy asset → video; failures preserve originals and secrets stay server-side', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-cos-integration-'));
  const objects = new Map(), requests = [], downloaded = [];
  let child, rejectUploads = false, base;
  let lifecycle = '<LifecycleConfiguration><Rule><ID>keep-existing</ID><Status>Enabled</Status><Filter><Prefix>other/</Prefix></Filter><Expiration><Days>90</Days></Expiration></Rule></LifecycleConfiguration>';
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
  const imageData = 'data:image/png;base64,' + imageBytes.toString('base64');
  const mock = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + req.headers.host);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      requests.push({ method: req.method, path: url.pathname, headers: req.headers });
      if (url.searchParams.has('lifecycle')) {
        if (req.method === 'PUT') lifecycle = bytes.toString();
        res.setHeader('content-type', 'application/xml'); return res.end(req.method === 'GET' ? lifecycle : '');
      }
      if (url.pathname.startsWith('/image-video-flow/temp/')) {
        if (req.method === 'PUT') {
          if (rejectUploads) { res.writeHead(403, { 'content-type': 'application/xml' }); return res.end('<Error><Code>AccessDenied</Code><Message>cos-admin-secret cos-admin-id</Message></Error>'); }
          objects.set(url.pathname, bytes);
          res.setHeader('etag', '"mock-etag"'); return res.end();
        }
        if (!objects.has(url.pathname)) { res.writeHead(404); return res.end(); }
        res.setHeader('content-type', 'image/png');
        if (req.method === 'GET') {
          assert.ok(url.searchParams.get('q-signature'));
          const times = url.searchParams.get('q-sign-time').split(';').map(Number);
          assert.equal(times[1] - times[0], 86400);
          downloaded.push(objects.get(url.pathname));
        }
        return res.end(req.method === 'HEAD' ? '' : objects.get(url.pathname));
      }
      res.setHeader('content-type', 'application/json');
      const body = bytes.length ? JSON.parse(bytes) : {};
      if (url.pathname === '/v1/images/generations') return res.end(JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }));
      if (url.pathname === '/asset/seedance2/assetUpload') {
        assert.equal(body.assetType, 'Image');
        const reference = await fetch(body.url);
        assert.equal(reference.status, 200);
        assert.deepEqual(Buffer.from(await reference.arrayBuffer()), imageBytes);
        return res.end(JSON.stringify({ assetId: 'reviewed-image', status: 'ACTIVE' }));
      }
      if (url.pathname === '/v2/model-center/tasks') {
        assert.deepEqual(body.reference_images, ['assetId://reviewed-image']);
        return res.end(JSON.stringify({ id: 'video-complete', status: 'completed', result_url: 'https://video.example/output.mp4' }));
      }
      res.writeHead(404); res.end('{}');
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); }
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'ai-flow-cos-integration-'));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockBase = 'http://127.0.0.1:' + mock.address().port;
  child = spawn(process.execPath, ['--import', './test/fixtures/cos-local.js', 'server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, APP_ACCESS_PASSWORD:testPassword, APP_COOKIE_SECURE:'false', AI_FLOW_PORT: '0', AI_FLOW_DATA_DIR: dir, COS_ENABLED: 'true', COS_SECRET_ID: 'cos-admin-id', COS_SECRET_KEY: 'cos-admin-secret', COS_BUCKET: 'workflow-1234567890', COS_REGION: 'ap-guangzhou', COS_TEST_DOMAIN: '127.0.0.1:' + mock.address().port, OPENAI_API_KEY: 'image-key', OPENAI_BASE_URL: mockBase + '/v1', SEEDANCE_API_KEY: 'video-key', SEEDANCE_BASE_URL: mockBase, SEEDANCE_MODEL: 'sd_2.0_special', VIDEO_API_TYPE: 'kyyReactApi', PUBLIC_ASSET_BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('server exited')); });
  });
  const authenticatedFetch=await loginFetch(base);
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await authenticatedFetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  const project = await api('/api/projects', { name: 'COS integration' });
  const shot = await api('/api/shots', { projectId: project.id, name: '测试镜头' });
  const asset = await api('/api/assets', { name: 'original.png', kind: 'image', mime: 'image/png', dataUrl: imageData });
  assert.equal(asset.cloudUpload.status, 'uploaded');
  assert.equal(asset.dataUrl, imageData);
  assert.match(lifecycle, /keep-existing/);
  assert.match(lifecycle, /<Prefix>image-video-flow\/temp\/<\/Prefix>/);
  assert.match(lifecycle, /<NoncurrentVersionExpiration><NoncurrentDays>2<\/NoncurrentDays><\/NoncurrentVersionExpiration>/);
  assert.equal(requests.find(req => req.method === 'PUT' && req.path.startsWith('/image-video-flow/')).headers['x-cos-acl'], 'private');
  async function completed(task) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = (await api('/api/bootstrap')).tasks.find(item => item.id === task.id);
      if (!['queued', 'running'].includes(current.status)) { assert.equal(current.status, 'completed', current.error); return current; }
      await delay(20);
    }
    assert.fail('task timeout');
  }
  await completed(await api('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'move', kyyMedia: { referenceImageIds: [asset.id] } }));
  assert.equal(downloaded.length, 1);
  objects.clear(); // Simulate COS lifecycle deletion, then retry with the same local asset.
  await completed(await api('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'move again', kyyMedia: { referenceImageIds: [asset.id] } }));
  assert.equal(downloaded.length, 2);
  assert.equal(objects.size, 1);
  await completed(await api('/api/tasks', { shotId: shot.id, kind: 'image', prompt: 'an apple' }));
  const generated = (await api('/api/bootstrap')).results.find(result => result.kind === 'image');
  assert.equal(generated.cloudUpload.status, 'uploaded');
  assert.equal(generated.dataUrl, imageData);
  rejectUploads = true;
  const failed = await api('/api/assets', { name: 'retry.png', kind: 'image', mime: 'image/png', dataUrl: imageData });
  assert.equal(failed.cloudUpload.status, 'failed');
  assert.equal(failed.dataUrl, imageData);
  rejectUploads = false;
  await completed(await api('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'retry', kyyMedia: { referenceImageIds: [failed.id] } }));
  const bootstrap = await api('/api/bootstrap'), settings = await api('/api/settings');
  assert.equal(bootstrap.assets.find(item => item.id === failed.id).cloudUpload.status, 'uploaded');
  assert.equal(bootstrap.cloudMediaEnabled, true);
  const publicText = JSON.stringify({ bootstrap, settings });
  assert.doesNotMatch(publicText, /cos-admin-id|cos-admin-secret|COS_SECRET|workflow-1234567890|q-signature/);
  const denied = await authenticatedFetch(base + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-settings-token': settings.settingsToken }, body: JSON.stringify({ COS_SECRET_KEY: 'hacked' }) });
  assert.equal(denied.status, 400);
  for (const path of ['/.env', '/cos-storage.js', '/data/cos-objects.json', '/%2e%2e%2f.env']) assert.equal((await authenticatedFetch(base + path)).status, 404);
  assert.doesNotMatch(await readFile(join(dir, 'state.json'), 'utf8'), /cos-admin-id|cos-admin-secret|q-signature/);
});
