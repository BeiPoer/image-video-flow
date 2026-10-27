import COS from 'cos-nodejs-sdk-v5';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const prefix = 'image-video-flow/temp/';
const retentionDays = 2;
const linkSeconds = 24 * 60 * 60;
const ruleId = 'ai-media-flow-temp-v1';

export function cosConfig(env = process.env) {
  if (!['', 'false', 'true'].includes(env.COS_ENABLED || '')) throw new Error('COS_ENABLED 必须为 true 或 false');
  if (env.COS_ENABLED !== 'true') return null;
  const config = Object.fromEntries(['SECRET_ID', 'SECRET_KEY', 'BUCKET', 'REGION'].map(key => [key, (env['COS_' + key] || '').trim()]));
  if (Object.values(config).some(value => !value || /\s/.test(value))) throw new Error('请管理员在服务端 .env 中完整填写 COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION');
  if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(config.BUCKET) || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(config.REGION)) throw new Error('COS_BUCKET 或 COS_REGION 格式无效');
  return config;
}

// Never pass SDK errors to the browser: they may contain signed requests and credentials.
function storageError(action, err) {
  const code = String(err?.error?.Code || err?.code || '');
  const message = String(err?.error?.Message || err?.message || '');
  const reasons = {
    SignatureDoesNotMatch: '：腾讯云签名校验失败（SignatureDoesNotMatch），请管理员核对同一组 SecretId 和 SecretKey，更新服务端配置后重启；增加桶权限不能解决签名错误',
    InvalidAccessKeyId: '：腾讯云无法识别密钥 ID（InvalidAccessKeyId），请管理员检查密钥是否正确、有效，更新服务端配置后重启',
    RequestTimeTooSkewed: '：本机时间与腾讯云相差过大（RequestTimeTooSkewed），请管理员同步系统时间',
    ExpiredToken: '：临时凭据已过期（ExpiredToken），请管理员更新有效凭据',
    NoSuchBucket: '：存储桶不存在（NoSuchBucket），请管理员核对桶名称和地域',
  };
  const permissions = { '读取自动清理配置': 'GetBucketLifecycle', '写入自动清理配置': 'PutBucketLifecycle', '上传': 'PutObject', '检查': 'HeadObject' };
  const reason = reasons[code] || (message === 'SignatureDoesNotMatch' ? reasons.SignatureDoesNotMatch
    : /request has expired/i.test(message) ? '：请求签名已过期，请管理员同步系统时间后重试'
    : code === 'AccessDenied' ? `：腾讯云拒绝访问（AccessDenied），请管理员检查${permissions[action] ? ' ' + permissions[action] : ''} 权限及授权资源范围`
    : Number(err?.statusCode) === 403 ? '：腾讯云拒绝访问（HTTP 403），请管理员检查凭据、访问策略和存储桶权限'
    : Number(err?.statusCode) === 404 ? '，请管理员检查存储桶名称和地域' : '，请稍后重试或联系管理员');
  return new Error(`临时素材${action}失败${reason}`);
}

export async function createCosStore(dataDir, config = cosConfig(), client) {
  if (!config) return { enabled: false };
  client ||= new COS({ SecretId: config.SECRET_ID, SecretKey: config.SECRET_KEY, Protocol: 'https:', Timeout: 60000 });
  const bucket = { Bucket: config.BUCKET, Region: config.REGION };
  const file = join(dataDir, 'cos-objects.json');
  await mkdir(dataDir, { recursive: true });
  let entries = {};
  try { entries = JSON.parse(await readFile(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw new Error('云端素材记录无法读取，请管理员检查数据目录'); }
  let writes = Promise.resolve();
  const pending = new Map();
  function call(method, params = {}) {
    return new Promise((resolve, reject) => client[method]({ ...bucket, ...params }, (err, data) => err ? reject(err) : resolve(data)));
  }
  let policyPending;
  async function ensureLifecycle() {
    // Share concurrent checks, but recheck on later uploads so removed rules are restored.
    if (policyPending) return policyPending;
    let action = '读取自动清理配置';
    policyPending = (async () => {
      let rules;
      try { rules = (await call('getBucketLifecycle')).Rules || []; }
      catch (err) { if ((err.code || err.error?.Code) !== 'NoSuchLifecycleConfiguration') throw err; rules = []; }
      const existing = rules.find(rule => rule.ID === ruleId);
      if (existing && existing.Filter?.Prefix !== prefix) throw new Error('生命周期规则 ID 冲突');
      if (existing?.Status === 'Enabled' && Object.keys(existing.Filter).length === 1 && Number(existing.Expiration?.Days) === retentionDays && Number(existing.NoncurrentVersionExpiration?.NoncurrentDays) === retentionDays) return;
      const rule = { ID: ruleId, Status: 'Enabled', Filter: { Prefix: prefix }, Expiration: { Days: retentionDays }, NoncurrentVersionExpiration: { NoncurrentDays: retentionDays } };
      // PUT replaces all rules, so preserve every unrelated rule returned by COS.
      action = '写入自动清理配置';
      await call('putBucketLifecycle', { Rules: [...rules.filter(rule => rule.ID !== ruleId), rule] });
    })().catch(err => { throw storageError(action, err); }).finally(() => { policyPending = undefined; });
    return policyPending;
  }
  function persist() {
    const snapshot = JSON.stringify(entries, null, 2);
    const operation = writes.then(async () => {
      await writeFile(file + '.tmp', snapshot, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    writes = operation.catch(() => {});
    return operation;
  }
  async function ensure(sourceId, bytes, mime) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024 || !/^(image|video|audio)\/[a-z0-9.+-]+$/.test(mime)) throw new Error('临时素材内容、格式或大小无效');
    const digest = crypto.createHash('sha256').update(bytes).update(mime).digest('hex');
    const pendingKey = sourceId + ':' + digest;
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    const operation = (async () => {
      await ensureLifecycle();
      let entry = entries[sourceId];
      // Refresh early using a NEW object: an older queued task may still hold its URL.
      let reusable = entry?.digest === digest && entry.bucket === config.BUCKET && entry.region === config.REGION && entry.key.startsWith(prefix) && Date.now() - entry.uploadedAt < 12 * 60 * 60 * 1000;
      if (reusable) {
        try { await call('headObject', { Key: entry.key }); }
        catch (err) { if (Number(err.statusCode) === 404) reusable = false; else throw storageError('检查', err); }
      }
      if (!reusable) {
        const key = prefix + crypto.randomUUID();
        try { await call('putObject', { Key: key, Body: bytes, ContentType: mime, ContentLength: bytes.length, ACL: 'private', StorageClass: 'STANDARD' }); }
        catch (err) { throw storageError('上传', err); }
        entry = { key, digest, bucket: config.BUCKET, region: config.REGION, uploadedAt: Date.now() };
        entries[sourceId] = entry;
        try { await persist(); } catch { throw new Error('临时素材上传成功，但服务端记录保存失败，请管理员检查数据目录'); }
      }
      try { return (await call('getObjectUrl', { Key: entry.key, Sign: true, Expires: linkSeconds })).Url; }
      catch (err) { throw storageError('链接生成', err); }
    })().finally(() => pending.delete(pendingKey));
    pending.set(pendingKey, operation);
    return operation;
  }
  function redactError(message) {
    const withoutLinks = String(message).replace(/https?:\/\/[^\s<>"']+/g, value => value.includes('q-sign') || value.includes('.myqcloud.com/') ? '[临时素材链接]' : value);
    return [config.SECRET_ID, config.SECRET_KEY, config.BUCKET].reduce((text, value) => text.split(value).join('[服务端配置]'), withoutLinks);
  }
  return { enabled: true, ensure, redactError };
}
