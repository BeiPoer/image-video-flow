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
import { createSettingsStore } from '../model-settings.js';

async function cleanup(dir) {
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'ai-flow-settings-'));
  await rm(dir, { recursive: true, force: true });
}

test('settings encrypt, persist, preserve blank keys and explicitly override environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-settings-'));
  try {
    const env = { OPENAI_API_KEY: 'env-test-key' };
    let store = await createSettingsStore(dir, env);
    assert.equal(store.publicSettings().OPENAI_API_KEY, undefined);
    assert.equal(store.publicSettings().OPENAI_API_KEY_CONFIGURED, true);
    assert.equal(store.current().OPENAI_API_KEY, 'env-test-key');
    assert.equal(store.publicSettings().VIDEO_API_TYPE, 'openai');
    assert.equal(store.publicSettings().OPENAI_IMAGE_MAX_COUNT, '8');
    for (const value of ['0','11','1.5','', 'abc',7]) await assert.rejects(store.update({OPENAI_IMAGE_MAX_COUNT:value}), {status:400});
    await store.update({OPENAI_IMAGE_MAX_COUNT:'7'});
    for (const value of ['-1','NaN','Infinity','0.00001','1000001']) await assert.rejects(store.update({OPENAI_IMAGE_PRICE:value}), {status:400});
    for (const value of ['','720p,720p','8k']) await assert.rejects(store.update({VIDEO_RESOLUTIONS:value}), {status:400});
    for (const value of ['0','31','2.5']) await assert.rejects(store.update({VIDEO_MAX_SECONDS:value}), {status:400});
    for (const value of ['0','31','2.5']) await assert.rejects(store.update({VIDEO_MIN_SECONDS:value}), {status:400});
    await assert.rejects(store.update({VIDEO_MIN_SECONDS:'20',VIDEO_MAX_SECONDS:'10'}), {status:400});
    await store.update({VIDEO_MIN_SECONDS:'5'});
    await store.update({OPENAI_IMAGE_PRICE:'0.1234',VIDEO_PRICE_1080P:'0.15',VIDEO_RESOLUTIONS:'720p,1080p',VIDEO_MAX_SECONDS:'12'});
    assert.equal(store.current().OPENAI_BASE_URL, 'https://new.every-ai.cc/v1');
    assert.equal(store.current().SEEDANCE_BASE_URL, 'https://new.every-ai.cc/v1');
    assert.equal(store.current().SEEDANCE_MODEL, 'doubao-seedance-2-0-mini-260615');
    await store.update({ OPENAI_API_KEY: 'saved-test-key', OPENAI_BASE_URL: 'https://example.com/v1///', SEEDANCE_API_KEY: 'video-test-key' });
    assert.equal(store.current().OPENAI_BASE_URL, 'https://example.com/v1');
    await assert.rejects(store.update({ PUBLIC_ASSET_BASE_URL: 'http://media.example.test' }), { status: 400 });
    await assert.rejects(store.update({ PUBLIC_ASSET_BASE_URL: 'https://localhost' }), { status: 400 });
    await assert.rejects(store.update({ PUBLIC_ASSET_BASE_URL: 'https://192.168.1.10' }), { status: 400 });
    await store.update({ PUBLIC_ASSET_BASE_URL: 'https://media.example.test' });
    const signedAsset = new URL(await store.createAssetUrl('asset-test', 'image/png'));
    assert.equal(signedAsset.origin, 'https://media.example.test');
    assert.equal(await store.verifyAssetUrl('asset-test', 'image/png', signedAsset.searchParams.get('expires'), signedAsset.searchParams.get('signature')), true);
    assert.equal(await store.verifyAssetUrl('asset-other', 'image/png', signedAsset.searchParams.get('expires'), signedAsset.searchParams.get('signature')), false);
    const disk = await readFile(join(dir, 'settings.enc'));
    assert.ok(!disk.includes(Buffer.from('saved-test-key')));
    store = await createSettingsStore(dir, env);
    assert.equal(store.current().OPENAI_IMAGE_MAX_COUNT, '7');
    assert.equal(store.current().OPENAI_IMAGE_PRICE, '0.1234');assert.equal(store.current().VIDEO_PRICE_1080P, '0.15');
    assert.equal(store.current().VIDEO_RESOLUTIONS, '720p,1080p');assert.equal(store.current().VIDEO_MAX_SECONDS, '12');
    assert.equal(store.current().VIDEO_MIN_SECONDS, '5');
    assert.equal(store.current().OPENAI_API_KEY, 'saved-test-key');
    await Promise.all([store.update({ OPENAI_API_KEY: '', OPENAI_IMAGE_MODEL: 'image-custom' }), store.update({ SEEDANCE_MODEL: 'video-custom' })]);
    assert.equal(store.current().OPENAI_API_KEY, 'saved-test-key');
    assert.equal(store.current().OPENAI_IMAGE_MODEL, 'image-custom');
    assert.equal(store.current().SEEDANCE_MODEL, 'video-custom');
    await assert.rejects(store.update({ SEEDANCE_BASE_URL: 'http://example.com/v3' }), { status: 400 });
    await assert.rejects(store.update({ OPENAI_IMAGE_MODEL: '' }), { status: 400 });
    await assert.rejects(store.update({ OPENAI_API_KEY: 'new-key', CLEAR_OPENAI_API_KEY: true }), { status: 400 });
    await store.update({ CLEAR_OPENAI_API_KEY: true, VIDEO_API_TYPE: 'kyyReactApi' });
    store = await createSettingsStore(dir, env);
    assert.equal(store.current().OPENAI_API_KEY, '');
    assert.equal(store.publicSettings().OPENAI_API_KEY_CONFIGURED, false);
    assert.equal(store.publicSettings().VIDEO_API_TYPE, 'kyyReactApi');
    assert.equal(store.current().SEEDANCE_API_KEY, 'video-test-key');
  } finally { await cleanup(dir); }
});

test('page settings feed both providers live, protect keys and retain in-flight video configuration', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-settings-'));
  const requests = [];
  let child;
  let appBase = '';
  let rejectImages = false;
  const mock = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/images/generations') {
      res.statusCode = rejectImages ? 400 : 200;
      return res.end(JSON.stringify(rejectImages ? { error: { message: 'invalid image-test-key' } } : { data: [{ b64_json: 'aW1hZ2U=' }] }));
    }
    if (req.url === '/v3/contents/generations/tasks') return res.end(JSON.stringify({ id: 'mock-video' }));
    if (req.url === '/v3/contents/generations/tasks/mock-video') return res.end(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://example.com/test-video.mp4' } }));
    if (req.url === '/v1/videos') return res.end(JSON.stringify({ id: 'openai-server-video', status: 'completed' }));
    if (req.url === '/v1/videos/openai-server-video/content') { res.setHeader('content-type', 'video/mp4'); return res.end('mock-mp4-file'); }
    if (req.url === '/kyyReactApiServer/asset/seedance2/assetDetail') return res.end(JSON.stringify({ assetId: body.assetId, status: 'ACTIVE' }));
    if (req.url === '/kyyReactApiServer/asset/seedance2/assetUpload') {
      if (body?.url?.startsWith('https://media.example.test/')) {
        const signed = new URL(body.url), served = await fetch(appBase + signed.pathname + signed.search);
        const bytes = Buffer.from(await served.arrayBuffer());
        const expected = { Image: 'local-reference-image', Video: 'local-reference-video', Audio: 'local-reference-audio' }[body.assetType];
        if (!served.ok || bytes.toString() !== expected) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'signed local asset could not be read' } })); }
        requests.push({ path: 'local-signed-asset', status: served.status, contentType: served.headers.get('content-type'), size: bytes.length, url: body.url, assetType: body.assetType });
      }
      const assetId = body?.url ? 'asset-' + body.assetType.toLowerCase() : 'asset-server';
      return res.end(JSON.stringify({ assetId, status: 'ACTIVE' }));
    }
    if (req.url === '/kyyReactApiServer/v2/model-center/tasks') return res.end(JSON.stringify({ id: 'kyy-server-video', status: 'completed', result_url: 'https://example.com/kyy-result.mp4' }));
    res.statusCode = 404; res.end('{}');
  });
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill(); await exited;
    }
  }
  let authenticatedFetch;
  async function launch() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ACCESS_PASSWORD:testPassword, APP_COOKIE_SECURE:'false', AI_FLOW_PORT: '0', AI_FLOW_DATA_DIR: dir, OPENAI_API_KEY: '', SEEDANCE_API_KEY: '', OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_IMAGE_MODEL: 'gpt-image-2', SEEDANCE_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3', SEEDANCE_MODEL: 'seedance-env', VIDEO_API_TYPE: 'volcengine' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 3000);
      child.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('server stopped before ready')); });
    });
    authenticatedFetch=await loginFetch(endpoint);return endpoint;
  }
  try {
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
    const provider = `http://127.0.0.1:${mock.address().port}`;
    let base = await launch(); appBase = base;
    const call = async (path, body, method = 'POST', headers = {}) => {
      const response = await authenticatedFetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { response, value: await response.json() };
    };
    const read = async path => (await call(path, undefined, 'GET')).value;
    let settings = await read('/api/settings');
    const save = body => call('/api/settings', body, 'PUT', { 'x-settings-token': settings.settingsToken });
    assert.equal((await call('/api/settings', { OPENAI_IMAGE_MODEL: 'denied' }, 'PUT')).response.status, 403);
    assert.equal((await call('/api/settings', {}, 'PUT', { 'x-settings-token': settings.settingsToken, origin: 'https://other.example' })).response.status, 403);
    assert.equal((await save({ OPENAI_BASE_URL: 'file:///etc/passwd' })).response.status, 400);
    const saved = await save({ OPENAI_BASE_URL: provider + '/v1/', OPENAI_IMAGE_MODEL: 'image-local', OPENAI_API_KEY: 'image-test-key', SEEDANCE_BASE_URL: provider + '/v3/', SEEDANCE_MODEL: 'video-local', SEEDANCE_API_KEY: 'video-test-key' });
    assert.equal(saved.response.status, 200);
    const exposed = await read('/api/settings');
    for (const values of [saved.value, exposed]) {
      assert.equal(values.OPENAI_API_KEY, undefined);
      assert.equal(values.SEEDANCE_API_KEY, undefined);
      assert.equal(values.OPENAI_API_KEY_CONFIGURED, true);
      assert.equal(values.SEEDANCE_API_KEY_CONFIGURED, true);
      assert.doesNotMatch(JSON.stringify(values), /image-test-key|video-test-key/);
    }
    const { value: project } = await call('/api/projects', { name: '配置验证项目' });
    const { value: shot } = await call('/api/shots', { projectId: project.id, name: '配置验证镜头' });
    async function waitTask(id) {
      for (let attempt = 0; attempt < 150; attempt++) {
        const task = (await read('/api/bootstrap')).tasks.find(item => item.id === id);
        if (['completed', 'failed', 'unknown'].includes(task?.status)) return task;
        await delay(50);
      }
      throw new Error('task timeout: ' + JSON.stringify((await read('/api/bootstrap')).tasks.find(item => item.id === id)));
    }
    let { value: task } = await call('/api/tasks', { shotId: shot.id, kind: 'image', prompt: 'mock only' });
    assert.equal((await waitTask(task.id)).status, 'completed');
    assert.equal(requests[0].authorization, 'Bearer image-test-key');
    assert.equal(requests[0].body.model, 'image-local');
    rejectImages = true;
    ({ value: task } = await call('/api/tasks', { shotId: shot.id, kind: 'image', prompt: 'mock failure' }));
    const failed = await waitTask(task.id);
    assert.equal(failed.status, 'failed');
    assert.ok(!failed.error.includes('image-test-key'));
    ({ value: task } = await call('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'mock video', inputImageUrl: 'https://example.com/input.png' }));
    for (let attempt = 0; attempt < 50 && !requests.some(item => item.path === '/v3/contents/generations/tasks'); attempt++) await delay(20);
    assert.ok(requests.some(item => item.body?.model === 'video-local'));
    await save({ VIDEO_API_TYPE: 'openai', SEEDANCE_API_KEY: 'updated-video-key', SEEDANCE_BASE_URL: provider + '/changed' });
    assert.equal((await waitTask(task.id)).status, 'completed');
    const poll = requests.find(item => item.path.endsWith('/mock-video'));
    assert.equal(poll.authorization, 'Bearer video-test-key');
    assert.equal(poll.path, '/v3/contents/generations/tasks/mock-video');
    await save({ VIDEO_API_TYPE: 'openai', SEEDANCE_BASE_URL: provider + '/v1', SEEDANCE_MODEL: 'openai-compatible-model' });
    ({ value: task } = await call('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'mock OpenAI video', inputImageUrl: 'data:image/png;base64,aW1hZ2U=' }));
    assert.equal((await waitTask(task.id)).status, 'completed');
    const movie = (await read('/api/bootstrap')).results.find(result => result.taskId === task.id);
    assert.match(movie.dataUrl, /^\/api\/video-results\/task-/);
    const bytes = await authenticatedFetch(base + movie.dataUrl);
    assert.equal(bytes.headers.get('content-type'), 'video/mp4');
    assert.equal(await bytes.text(), 'mock-mp4-file');
    const range = await authenticatedFetch(base + movie.dataUrl, { headers: { range: 'bytes=0-3' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'mock');
    const openaiCall = requests.find(item => item.path === '/v1/videos');
    assert.equal(openaiCall.authorization, 'Bearer updated-video-key');
    assert.equal(openaiCall.body.model, 'openai-compatible-model');
    assert.equal(openaiCall.body.seconds, '8');
    await save({ VIDEO_API_TYPE: 'kyyReactApi', SEEDANCE_BASE_URL: provider + '/kyyReactApiServer', SEEDANCE_MODEL: 'sd_2.0_special', PUBLIC_ASSET_BASE_URL: 'https://media.example.test' });
    const localAsset = await call('/api/assets', { name: 'Local reference.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,' + Buffer.from('local-reference-image').toString('base64') });
    const localVideoAsset = await call('/api/assets', { name: 'Local reference.mp4', kind: 'video', mime: 'video/mp4', dataUrl: 'data:video/mp4;base64,' + Buffer.from('local-reference-video').toString('base64') });
    const localAudioAsset = await call('/api/assets', { name: 'Local reference.mp3', kind: 'audio', mime: 'audio/mpeg', dataUrl: 'data:audio/mpeg;base64,' + Buffer.from('local-reference-audio').toString('base64') });
    const localImage = await call('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'local image blocked before network', inputImageUrl: 'data:image/png;base64,aW1hZ2U=' });
    assert.equal(localImage.response.status, 400);
    assert.match(localImage.value.error, /公网可访问 URL/);
    await save({ PUBLIC_ASSET_BASE_URL: '' });
    const taskCount = (await read('/api/bootstrap')).tasks.length;
    const missingAccess = await call('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'missing public address', kyyMedia: { referenceImageIds: [localAsset.value.id] } });
    assert.equal(missingAccess.response.status, 400);
    assert.match(missingAccess.value.error, /素材访问地址/);
    assert.equal((await read('/api/bootstrap')).tasks.length, taskCount);
    await save({ PUBLIC_ASSET_BASE_URL: 'https://media.example.test' });
    ({ value: task } = await call('/api/tasks', { shotId: shot.id, kind: 'video', prompt: 'local library kyy video', kyyMedia: { referenceImageIds: [localAsset.value.id], referenceVideoIds: [localVideoAsset.value.id], referenceAudioIds: [localAudioAsset.value.id] } }));
    const kyyTask = await waitTask(task.id);
    assert.equal(kyyTask.status, 'completed', JSON.stringify({ task: kyyTask, requestPaths: requests.map(item => item.path) }));
    assert.equal(kyyTask.videoApiType, 'kyyReactApi');
    assert.equal(kyyTask.remoteTaskId, 'kyy-server-video');
    const kyyAssetUpload = requests.find(item => item.path === '/kyyReactApiServer/asset/seedance2/assetUpload');
    assert.ok(kyyAssetUpload);
    assert.equal(kyyAssetUpload.contentType, 'application/json');
    assert.match(kyyAssetUpload.body.url, /^https:\/\/media\.example\.test\/api\/kyy-assets\//);
    const localFetch = requests.find(item => item.path === 'local-signed-asset');
    assert.equal(localFetch.status, 200);
    assert.equal(localFetch.contentType, 'image/png');
    assert.equal(localFetch.size, Buffer.byteLength('local-reference-image'));
    assert.equal(requests.filter(item => item.path === 'local-signed-asset').length, 3);
    assert.deepEqual(requests.filter(item => item.path === 'local-signed-asset').map(item => item.assetType).sort(), ['Audio','Image','Video']);
    const signed = new URL(localFetch.url);
    const rejectedSignature = new URL(localFetch.url); rejectedSignature.searchParams.set('signature', '0'.repeat(64));
    const expired = new URL(localFetch.url); expired.searchParams.set('expires', '1000000000');
    assert.equal((await fetch(appBase + rejectedSignature.pathname + rejectedSignature.search)).status, 403);
    assert.equal((await fetch(appBase + expired.pathname + expired.search)).status, 403);
    assert.equal((await fetch(appBase + signed.pathname)).status, 403);
    const partial = await fetch(appBase + signed.pathname + signed.search, { headers: { range: 'bytes=0-4' } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'local');
    const persistentStore = await createSettingsStore(dir, {});
    const savedMovie = new URL(await persistentStore.createAssetUrl(movie.id, 'video/mp4'));
    const savedMovieResponse = await fetch(appBase + savedMovie.pathname + savedMovie.search);
    assert.equal(savedMovieResponse.status, 200);
    assert.equal(await savedMovieResponse.text(), 'mock-mp4-file');

    assert.deepEqual(requests.find(item => item.path === '/kyyReactApiServer/v2/model-center/tasks').body.reference_images, ['assetId://asset-image']);
    assert.deepEqual(requests.find(item => item.path === '/kyyReactApiServer/v2/model-center/tasks').body.reference_videos, ['assetId://asset-video']);
    assert.deepEqual(requests.find(item => item.path === '/kyyReactApiServer/v2/model-center/tasks').body.reference_audios, ['assetId://asset-audio']);
    assert.ok(!JSON.stringify(await read('/api/bootstrap')).includes('image-test-key'));
    assert.ok(!JSON.stringify(await read('/api/bootstrap')).includes('video-test-key'));
    await stop(); base = await launch(); appBase = base; settings = await read('/api/settings');
    assert.equal(settings.OPENAI_IMAGE_MODEL, 'image-local');
    assert.equal(settings.SEEDANCE_BASE_URL, provider + '/kyyReactApiServer');
    assert.equal(settings.PUBLIC_ASSET_BASE_URL, 'https://media.example.test');
    assert.equal((await read('/api/bootstrap')).publicAssetBaseUrl, 'https://media.example.test');
    assert.equal(settings.VIDEO_API_TYPE, 'kyyReactApi');
    assert.equal(settings.OPENAI_API_KEY_CONFIGURED, true);
    await save({ CLEAR_OPENAI_API_KEY: true, CLEAR_SEEDANCE_API_KEY: true });
    const bootstrap = await read('/api/bootstrap');
    assert.deepEqual(bootstrap.providers, { openai: 'demo', seedance: 'demo' });
  } finally {
    await stop();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    await cleanup(dir);
  }
});
