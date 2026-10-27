import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cosConfig, createCosStore } from '../cos-storage.js';
import { createSettingsStore } from '../model-settings.js';
import { publicImageAddress, downloadImage } from '../image-source.js';

const env = { COS_ENABLED: 'true', COS_SECRET_ID: 'admin-id', COS_SECRET_KEY: 'admin-secret', COS_BUCKET: 'private-1234567890', COS_REGION: 'ap-guangzhou' };
const config = cosConfig(env);
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-flow-cos-'));
  t.after(async () => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'ai-flow-cos-'));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
function mockCos() {
  const objects = new Map(), calls = [];
  const otherRule = { ID: 'unrelated', Status: 'Enabled', Filter: { Prefix: 'keep/' }, Expiration: { Days: 90 } };
  const mock = { objects, calls, rules: [otherRule], fail: '' };
  for (const method of ['getBucketLifecycle', 'putBucketLifecycle', 'putObject', 'headObject', 'getObjectUrl']) {
    mock[method] = (params, callback) => {
      calls.push({ method, params });
      if (mock.fail === method) return callback(mock.failure || { statusCode: 403, message: 'admin-secret and signed URL must never reach a browser' });
      if (method === 'getBucketLifecycle') return callback(null, { Rules: structuredClone(mock.rules) });
      if (method === 'putBucketLifecycle') mock.rules = structuredClone(params.Rules);
      if (method === 'putObject') objects.set(params.Key, params.Body);
      if (method === 'headObject' && !objects.has(params.Key)) return callback({ statusCode: 404 });
      callback(null, method === 'getObjectUrl' ? { Url: 'https://cos.example/' + params.Key + '?signed=true' } : {});
    };
  }
  return mock;
}

test('COS config is administrator-only and remote image downloads reject local addresses', async t => {
  assert.equal(cosConfig({}), null);
  assert.throws(() => cosConfig({ COS_ENABLED: 'yes' }), /COS_ENABLED/);
  assert.throws(() => cosConfig({ COS_ENABLED: 'true' }), /管理员/);
  assert.throws(() => cosConfig({ ...env, COS_BUCKET: '../bad' }), /格式无效/);
  const settings = await createSettingsStore(await directory(t), env);
  assert.ok(Object.keys(settings.publicSettings()).every(key => !key.startsWith('COS_')));
  await assert.rejects(settings.update({ COS_SECRET_KEY: 'browser-write' }), /不支持/);
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(publicImageAddress(ip), false, ip);
  assert.equal(publicImageAddress('8.8.8.8'), true);
  assert.equal(publicImageAddress('2606:4700::1111'), true);
  await assert.rejects(downloadImage('https://127.0.0.1/image.png'), /下载失败/);
  await assert.rejects(downloadImage('http://public.example/image.png'), /下载失败/);
});

test('COS retains other lifecycle rules, uploads privately, reuses/reuploads after deletion and restart', async t => {
  const dir = await directory(t), client = mockCos();
  let store = await createCosStore(dir, config, client);
  const bytes = Buffer.from('original image');
  const urls = await Promise.all([store.ensure('asset-one', bytes, 'image/png'), store.ensure('asset-one', bytes, 'image/png')]);
  assert.equal(urls[0], urls[1]);
  assert.equal(client.calls.filter(call => call.method === 'putObject').length, 1);
  assert.deepEqual(client.rules[0], { ID: 'unrelated', Status: 'Enabled', Filter: { Prefix: 'keep/' }, Expiration: { Days: 90 } });
  const rule = client.rules[1];
  assert.equal(rule.Filter.Prefix, 'image-video-flow/temp/');
  assert.equal(rule.Expiration.Days, 2);
  assert.equal(rule.NoncurrentVersionExpiration.NoncurrentDays, 2);
  const upload = client.calls.find(call => call.method === 'putObject').params;
  assert.equal(upload.ACL, 'private'); assert.equal(upload.StorageClass, 'STANDARD');
  assert.deepEqual(client.objects.get(upload.Key), bytes);
  assert.equal(client.calls.find(call => call.method === 'getObjectUrl').params.Expires, 86400);
  store = await createCosStore(dir, config, client);
  assert.equal(await store.ensure('asset-one', bytes, 'image/png'), urls[0]);
  assert.equal(client.calls.filter(call => call.method === 'putObject').length, 1);
  client.objects.clear();
  const replaced = await store.ensure('asset-one', bytes, 'image/png');
  assert.notEqual(replaced, urls[0]);
  assert.equal(client.objects.size, 1);
  const registryPath = join(dir, 'cos-objects.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry['asset-one'].uploadedAt = Date.now() - 13 * 3600 * 1000;
  await writeFile(registryPath, JSON.stringify(registry));
  store = await createCosStore(dir, config, client);
  assert.notEqual(await store.ensure('asset-one', bytes, 'image/png'), replaced);
  assert.equal(client.objects.size, 2, 'refresh must not delete an object a running task still uses');
  assert.doesNotMatch(await readFile(registryPath, 'utf8'), /admin-secret|admin-id|signed=true/);
});

test('COS policy/upload failures remain retryable and never leak SDK errors', async t => {
  const client = mockCos(), store = await createCosStore(await directory(t), config, client);
  assert.doesNotMatch(store.redactError('upstream echoed https://private-1234567890.cos.ap-guangzhou.myqcloud.com/image?q-signature=test&q-ak=admin-id admin-secret'), /admin-id|admin-secret|private-1234567890|q-signature/);
  const bytes = Buffer.from('original image');
  client.fail = 'putBucketLifecycle';
  await assert.rejects(store.ensure('asset-one', bytes, 'image/png'), err => /自动清理配置失败/.test(err.message) && !err.message.includes('admin-secret'));
  assert.equal(client.objects.size, 0, 'never upload without a cleanup policy');
  client.fail = 'putObject';
  await assert.rejects(store.ensure('asset-one', bytes, 'image/png'), /上传失败/);
  client.fail = '';
  await store.ensure('asset-one', bytes, 'image/png');
  client.fail = 'headObject';
  await assert.rejects(store.ensure('asset-one', bytes, 'image/png'), /检查失败/);
  assert.equal(client.objects.size, 1, '403 must not be mistaken for a missing object');
});

test('COS distinguishes invalid signatures from permissions and identifies lifecycle read/write failures', async t => {
  const client = mockCos(), store = await createCosStore(await directory(t), config, client);
  const bytes = Buffer.from('image');
  for (const [failure, expected] of [
    [{ code: 'SignatureDoesNotMatch' }, /签名校验失败.*SecretId.*SecretKey/],
    [{ code: '403', error: { Code: 'SignatureDoesNotMatch' } }, /签名校验失败/],
    [{ error: { Code: 'AccessDenied', Message: 'SignatureDoesNotMatch' } }, /签名校验失败/],
    [{ code: 'InvalidAccessKeyId' }, /无法识别密钥 ID/],
    [{ code: 'RequestTimeTooSkewed' }, /同步系统时间/],
    [{ error: { Code: 'AccessDenied', Message: 'Request has expired' } }, /签名已过期/],
    [{ code: 'AccessDenied' }, /GetBucketLifecycle 权限/],
  ]) {
    client.fail = 'getBucketLifecycle';
    client.failure = { statusCode: 403, message: 'admin-secret https://example.test/?q-signature=secret', ...failure };
    await assert.rejects(store.ensure('asset-one', bytes, 'image/png'), err => {
      assert.match(err.message, /读取自动清理配置失败/);
      assert.match(err.message, expected);
      assert.doesNotMatch(err.message, /admin-secret|q-signature|example.test/);
      return true;
    });
  }
  client.fail = 'putBucketLifecycle'; client.failure = { statusCode: 403, code: 'AccessDenied' };
  await assert.rejects(store.ensure('asset-one', bytes, 'image/png'), /写入自动清理配置失败.*PutBucketLifecycle 权限/);
  assert.equal(client.objects.size, 0);
});
