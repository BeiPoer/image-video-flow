import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVideo, videoRequest } from '../video-api.js';
import { defaults, validateSettings } from '../model-settings.js';
const config = { ...defaults, SEEDANCE_BASE_URL: 'https://provider.example/root/', SEEDANCE_API_KEY: 'video-mock-secret' };
const png = 'data:image/png;base64,aW1hZ2U=';
function mockCalls(steps) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, method: init.method || 'GET', auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const step = steps.shift();
    assert.ok(step, `Unexpected request ${url}`);
    assert.equal(call.url, config.SEEDANCE_BASE_URL.replace(/\/+$/, '') + step.path);
    assert.equal(call.method, step.method || 'GET');
    assert.equal(call.auth, 'Bearer video-mock-secret');
    if (step.check) step.check(call.body);
    if (step.error) throw step.error;
    return step.response || Response.json(step.value, { status: step.status || 200 });
  };
  return { calls, options: { fetch, sleep: async () => {}, maxPolls: 3, pollInterval: 0 } };
}

test('video type defaults keep old Ark settings, reject unknown types and use protocol-specific parameters', () => {
  assert.equal(defaults.VIDEO_API_TYPE, 'volcengine');
  assert.equal(validateSettings({ VIDEO_API_TYPE: 'kyyReactApi' }, defaults).VIDEO_API_TYPE, 'kyyReactApi');
  assert.throws(() => validateSettings({ VIDEO_API_TYPE: 'guess' }, defaults), { status: 400 });
  assert.throws(() => videoRequest('test', png, {}, { ...config, VIDEO_API_TYPE: 'kyyReactApi' }), /公网可访问 URL/);
  assert.throws(() => videoRequest('test', 'assetId://abc', {}, { ...config, VIDEO_API_TYPE: 'openai' }), /仅适用于/);
  assert.throws(() => videoRequest('test', null, { duration: 3 }, { ...config, VIDEO_API_TYPE: 'kyyReactApi' }), /4–15/);
  assert.throws(() => videoRequest('test', 'javascript:alert(1)', {}, config), /地址/);
  const request = videoRequest('test', png, { size: '1024x1536' }, { ...config, VIDEO_API_TYPE: 'openai' });
  assert.deepEqual(request.body.input_reference, { image_url: png });
  assert.equal(request.body.size, '720x1280'); // Image size must not accidentally become the video size.
  assert.equal(request.body.seconds, '8');
});

test('kyyReactApi maps image, video, audio references and first/last frame modes', () => {
  const refs=videoRequest('multimodal',null,{duration:5,referenceImages:['https://media.example.test/a.png'],referenceVideos:['https://media.example.test/b.mp4'],referenceAudios:['https://media.example.test/c.mp3']},{...config,VIDEO_API_TYPE:'kyyReactApi'});
  assert.deepEqual(refs.body.reference_images,['https://media.example.test/a.png']);
  assert.deepEqual(refs.body.reference_videos,['https://media.example.test/b.mp4']);
  assert.deepEqual(refs.body.reference_audios,['https://media.example.test/c.mp3']);
  const frames=videoRequest('frames',null,{duration:5,firstImage:'https://media.example.test/first.png',lastImage:'https://media.example.test/last.png'},{...config,VIDEO_API_TYPE:'kyyReactApi'});
  assert.equal(frames.body.first_image,'https://media.example.test/first.png');
  assert.equal(frames.body.last_image,'https://media.example.test/last.png');
  assert.throws(()=>videoRequest('conflict',null,{duration:5,firstImage:'https://media.example.test/first.png',referenceImages:['https://media.example.test/ref.png']},{...config,VIDEO_API_TYPE:'kyyReactApi'}),/不能与多模态参考素材混用/);
  assert.throws(()=>videoRequest('audio alone',null,{duration:5,referenceAudios:['https://media.example.test/a.mp3']},{...config,VIDEO_API_TYPE:'kyyReactApi'}),/必须同时包含图片或视频/);
});

test('Ark retains the content API and succeeded response mapping', async () => {
  const mock = mockCalls([
    { path: '/contents/generations/tasks', method: 'POST', value: { id: 'ark-id', status: 'queued' }, check: body => {
      assert.deepEqual(body.content[1], { type: 'image_url', image_url: { url: 'https://example.com/image.png' }, role: 'reference_image' });
      assert.equal(body.duration, 6);
    } },
    { path: '/contents/generations/tasks/ark-id', value: { status: 'succeeded', content: { video_url: 'https://example.com/ark.mp4' } } },
  ]);
  const result = await generateVideo('test', 'https://example.com/image.png', {}, config, undefined, mock.options);
  assert.equal(result.url, 'https://example.com/ark.mp4');
  assert.equal(result.type, 'volcengine');
});

test('OpenAI Video posts input_reference, polls, then downloads authenticated binary content', async () => {
  const updates = [];
  const mock = mockCalls([
    { path: '/videos', method: 'POST', value: { id: 'video-123', status: 'queued' }, check: body => {
      assert.equal(body.model, 'custom-video');
      assert.equal(body.seconds, '8');
      assert.deepEqual(body.input_reference, { image_url: png });
      assert.equal(body.aspect_ratio, undefined);
    } },
    { path: '/videos/video-123', value: { status: 'in_progress', progress: 42 } },
    { path: '/videos/video-123', value: { status: 'completed' } },
    { path: '/videos/video-123/content', response: new Response('mock mp4 bytes', { headers: { 'content-type': 'video/mp4' } }) },
  ]);
  const result = await generateVideo('test', png, { duration: 8 }, { ...config, VIDEO_API_TYPE: 'openai', SEEDANCE_MODEL: 'custom-video' }, update => updates.push(update), mock.options);
  assert.equal(await result.response.text(), 'mock mp4 bytes');
  assert.ok(updates.some(update => update.remoteTaskId === 'video-123' && update.progress === 42));
});

test('OpenAI-compatible video_url completes without fetching protected content unnecessarily', async () => {
  const mock = mockCalls([{ path: '/videos', method: 'POST', value: { id: 'compat-id', status: 'completed', video_url: 'https://example.com/compat.mp4' } }]);
  const result = await generateVideo('test', null, {}, { ...config, VIDEO_API_TYPE: 'openai' }, undefined, mock.options);
  assert.equal(result.url, 'https://example.com/compat.mp4');
  assert.equal(mock.calls.length, 1);
});

test('OpenAI status polling recovers from network errors without submitting another paid job', async () => {
  const mock = mockCalls([
    { path:'/videos', method:'POST', value:{id:'retry-id',status:'in_progress'} },
    { path:'/videos/retry-id', error:new TypeError('fetch failed', {cause:{code:'ECONNRESET'}}) },
    { path:'/videos/retry-id', error:new DOMException('timed out','TimeoutError') },
    { path:'/videos/retry-id', value:{status:'completed',video_url:'https://example.com/recovered.mp4'} },
  ]);
  const result = await generateVideo('test',null,{}, {...config,VIDEO_API_TYPE:'openai'},undefined,mock.options);
  assert.equal(result.url,'https://example.com/recovered.mp4');
  assert.equal(mock.calls.filter(call=>call.method==='POST').length,1);
});

test('persistent polling network errors stop after three retries and preserve task ID', async () => {
  const updates=[];
  const mock=mockCalls([
    {path:'/videos',method:'POST',value:{id:'offline-id',status:'in_progress'}},
    ...Array.from({length:4},()=>({path:'/videos/offline-id',error:new TypeError('fetch failed',{cause:{code:'ECONNRESET'}})})),
  ]);
  await assert.rejects(generateVideo('test',null,{}, {...config,VIDEO_API_TYPE:'openai'},update=>updates.push(update),{...mock.options,maxPolls:10}),err=>err.uncertain&&/查询视频状态.*ECONNRESET/.test(err.message));
  assert.equal(mock.calls.length,5);
  assert.equal(updates.at(-1).remoteTaskId,'offline-id');
});

test('submission network errors never retry POST; content errors identify an already generated video', async () => {
  const offline=new TypeError('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});
  const submission=mockCalls([{path:'/videos',method:'POST',error:offline}]);
  await assert.rejects(generateVideo('test',null,{}, {...config,VIDEO_API_TYPE:'openai'},undefined,submission.options),err=>err.uncertain&&/提交视频请求.*UND_ERR_SOCKET/.test(err.message));
  assert.equal(submission.calls.length,1);
  const content=mockCalls([
    {path:'/videos',method:'POST',value:{id:'done-id',status:'completed'}},
    {path:'/videos/done-id/content',error:offline},
  ]);
  await assert.rejects(generateVideo('test',null,{}, {...config,VIDEO_API_TYPE:'openai'},undefined,content.options),err=>err.uncertain&&/下载已生成的视频/.test(err.message));
  assert.equal(content.calls.length,2);
});

test('kyyReactApi uploads an image, waits for ACTIVE, then uses assetId and result_url', async () => {
  const mock = mockCalls([
    { path: '/asset/seedance2/assetUpload', method: 'POST', value: { assetId: 'asset-123', status: 'PROCESSING' }, check: body => {
      assert.equal(body.url, 'https://example.com/input.png'); assert.equal(body.assetType, 'Image'); assert.equal(body.model, 'sd');
    } },
    { path: '/asset/seedance2/assetDetail', method: 'POST', value: { assetId: 'asset-123', status: 'ACTIVE' }, check: body => assert.deepEqual(body, { assetId: 'asset-123' }) },
    { path: '/v2/model-center/tasks', method: 'POST', value: { id: 'kyy-id', status: 'queued' }, check: body => {
      assert.equal(body.model, 'sd_2.0_special');
      assert.deepEqual(body.reference_images, ['assetId://asset-123']);
      assert.equal(body.aspect_ratio, '9:16'); assert.equal(body.resolution, '720p');
      assert.equal(body.first_image, undefined); assert.equal(body.seconds, undefined);
    } },
    { path: '/v2/model-center/tasks/kyy-id', value: { status: 'processing', progress: 30 } },
    { path: '/v2/model-center/tasks/kyy-id', value: { status: 'completed', result_url: 'https://example.com/kyy.mp4' } },
  ]);
  const result = await generateVideo('test', 'https://example.com/input.png', {}, { ...config, VIDEO_API_TYPE: 'kyyReactApi', SEEDANCE_MODEL: 'sd_2.0_special' }, undefined, mock.options);
  assert.equal(result.url, 'https://example.com/kyy.mp4');
  assert.equal(mock.calls.length, 5);
});

test('kyyReactApi rejects Base64 because its documented material endpoint requires a public URL', async () => {
  const mock = mockCalls([]);
  await assert.rejects(generateVideo('test', png, {}, { ...config, VIDEO_API_TYPE: 'kyyReactApi' }, undefined, mock.options), /公网可访问 URL/);
  assert.equal(mock.calls.length, 0);
});

test('kyyReactApi converts image, video and audio URLs to reviewed asset IDs before task creation', async () => {
  const imageUrl='https://media.example.test/ref.png', videoUrl='https://media.example.test/ref.mp4', audioUrl='https://media.example.test/ref.mp3';
  const mock=mockCalls([
    {path:'/asset/seedance2/assetUpload',method:'POST',value:{assetId:'asset-image',status:'PROCESSING'},check:body=>{assert.equal(body.assetType,'Image');assert.equal(body.url,imageUrl);}},
    {path:'/asset/seedance2/assetDetail',method:'POST',value:{assetId:'asset-image',status:'ACTIVE'}},
    {path:'/asset/seedance2/assetUpload',method:'POST',value:{assetId:'asset-video',status:'PROCESSING'},check:body=>{assert.equal(body.assetType,'Video');assert.equal(body.url,videoUrl);}},
    {path:'/asset/seedance2/assetDetail',method:'POST',value:{assetId:'asset-video',status:'ACTIVE'}},
    {path:'/asset/seedance2/assetUpload',method:'POST',value:{assetId:'asset-audio',status:'PROCESSING'},check:body=>{assert.equal(body.assetType,'Audio');assert.equal(body.url,audioUrl);}},
    {path:'/asset/seedance2/assetDetail',method:'POST',value:{assetId:'asset-audio',status:'ACTIVE'}},
    {path:'/v2/model-center/tasks',method:'POST',value:{id:'multimodal-job',status:'completed',video_url:'https://example.com/multimodal.mp4'},check:body=>{
      assert.deepEqual(body.reference_images,['assetId://asset-image']);
      assert.deepEqual(body.reference_videos,['assetId://asset-video']);
      assert.deepEqual(body.reference_audios,['assetId://asset-audio']);
    }},
  ]);
  const result=await generateVideo('multimodal',null,{duration:5,referenceImages:[imageUrl],referenceVideos:[videoUrl],referenceAudios:[audioUrl]},{...config,VIDEO_API_TYPE:'kyyReactApi'},undefined,mock.options);
  assert.equal(result.url,'https://example.com/multimodal.mp4');
  assert.equal(mock.calls.length,7);
});

test('kyyReactApi surfaces material API errors before submitting a video task', async () => {
  const mock = mockCalls([{ path: '/asset/seedance2/assetUpload', method: 'POST', value: { code: 500, msg: '素材服务不可用', data: null } }]);
  await assert.rejects(generateVideo('test', 'https://example.com/input.png', {}, { ...config, VIDEO_API_TYPE: 'kyyReactApi' }, undefined, mock.options), /素材服务不可用/);
  assert.equal(mock.calls.length, 1);
});

test('failed existing kyy asset never submits a paid video job', async () => {
  const mock = mockCalls([{ path: '/asset/seedance2/assetDetail', method: 'POST', value: { assetId: 'asset-old', status: 'FAILED', errorMessage: '素材审核未通过' } }]);
  await assert.rejects(generateVideo('test', 'assetId://asset-old', {}, { ...config, VIDEO_API_TYPE: 'kyyReactApi' }, undefined, mock.options), /审核未通过/);
  assert.equal(mock.calls.length, 1);
});

test('upstream failure stops polling; timeout preserves uncertainty without resubmitting', async () => {
  const failed = mockCalls([
    { path: '/videos', method: 'POST', value: { id: 'failed-id', status: 'queued' } },
    { path: '/videos/failed-id', value: { status: 'failed', error: { message: '生成失败' } } },
  ]);
  await assert.rejects(generateVideo('test', null, {}, { ...config, VIDEO_API_TYPE: 'openai' }, undefined, failed.options), /生成失败/);
  const pending = mockCalls([
    { path: '/videos', method: 'POST', value: { id: 'pending-id', status: 'queued' } },
    { path: '/videos/pending-id', value: { status: 'in_progress' } },
  ]);
  await assert.rejects(generateVideo('test', null, {}, { ...config, VIDEO_API_TYPE: 'openai' }, undefined, { ...pending.options, maxPolls: 1 }), { uncertain: true });
  assert.equal(pending.calls.filter(call => call.method === 'POST').length, 1);
});
