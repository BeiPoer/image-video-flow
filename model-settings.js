import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { videoApiTypes } from './video-api.js';

export const defaults = {
  OPENAI_API_KEY: '',
  OPENAI_BASE_URL: 'https://new.every-ai.cc/v1',
  OPENAI_IMAGE_MODEL: 'gpt-image-2',
  OPENAI_IMAGE_MAX_COUNT: '8',
  VIDEO_API_TYPE: 'openai',
  PUBLIC_ASSET_BASE_URL: '',
  SEEDANCE_API_KEY: '',
  SEEDANCE_BASE_URL: 'https://new.every-ai.cc/v1',
  SEEDANCE_MODEL: 'doubao-seedance-2-0-mini-260615',
};
const secretFields = ['OPENAI_API_KEY', 'SEEDANCE_API_KEY'];
const clearFields = secretFields.map(field => `CLEAR_${field}`);
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }

export function validateSettings(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('配置必须是 JSON 对象');
  if (Object.keys(input).some(field => !Object.hasOwn(defaults, field) && !clearFields.includes(field))) invalid('包含不支持的配置项');
  const next = { ...current };
  for (const field of Object.keys(defaults)) {
    if (!Object.hasOwn(input, field)) continue;
    if (typeof input[field] !== 'string' || input[field].length > 4096) invalid('配置值必须是长度不超过 4096 的文本');
    const value = input[field].trim();
    if (field === 'OPENAI_IMAGE_MAX_COUNT') {
      if (!/^(?:[1-9]|10)$/.test(value)) invalid('生图上限必须是 1～10 的整数');
      next[field] = value;
    } else if (field === 'VIDEO_API_TYPE') {
      if (!videoApiTypes.includes(value)) invalid('接口类型必须是火山引擎、OpenAI Video 或 kyyReactApi');
      next[field] = value;
    } else if (secretFields.includes(field)) {
      if (/[\s\x00-\x1f\x7f]/.test(value)) invalid('API Key 不能包含空白或控制字符');
      if (value) next[field] = value;
    } else if (field === 'PUBLIC_ASSET_BASE_URL' && !value) {
      next[field] = '';
    } else if (field.endsWith('BASE_URL')) {
      let url;
      try { url = new URL(value); } catch { invalid('Base URL 必须是完整的 http:// 或 https:// 地址'); }
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) invalid('远程 Base URL 必须使用 HTTPS；本机接口可以使用 HTTP');
      if (url.username || url.password || url.search || url.hash) invalid('Base URL 不能包含账号、密码、查询参数或锚点');
      if (field === 'PUBLIC_ASSET_BASE_URL' && (url.protocol !== 'https:' || local || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^(?:0|10|127)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(url.hostname))) invalid('素材访问地址必须是外部可访问的 HTTPS 地址，不能填写 localhost');
      next[field] = url.href.replace(/\/+$/, '');
    } else {
      if (!value || value.length > 200 || /\s/.test(value)) invalid('模型名称不能为空、不能含空格，且不能超过 200 个字符');
      next[field] = value;
    }
  }
  for (const field of secretFields) {
    const clear = input[`CLEAR_${field}`];
    if (clear !== undefined && typeof clear !== 'boolean') invalid('清除密钥选项必须是布尔值');
    if (clear) {
      if (input[field]?.trim()) invalid('不能同时输入新密钥并选择清除');
      next[field] = '';
    }
  }
  return next;
}

export async function createSettingsStore(dataDir, env = process.env) {
  const file = join(dataDir, 'settings.enc');
  const keyFile = join(dataDir, 'settings.key');
  let saved = {};
  let key;
  let queue = Promise.resolve();
  await mkdir(dataDir, { recursive: true });
  let encrypted;
  try { encrypted = await readFile(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (encrypted) {
    try {
      key = await readFile(keyFile);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      saved = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { throw new Error('无法读取模型配置，请同时恢复 settings.enc 与 settings.key 的备份'); }
  }
  function current() {
    return Object.fromEntries(Object.entries(defaults).map(([field, fallback]) => [field, saved[field] ?? (env[field] || fallback)]));
  }
  function publicSettings() {
    const values = current();
    for (const field of secretFields) {
      values[`${field}_CONFIGURED`] = Boolean(values[field]);
      delete values[field];
    }
    return values;
  }
  let keyReady;
  async function ensureKey() {
    if (key) return key;
    keyReady ||= (async () => {
      let loaded;
      try { loaded = await readFile(keyFile); }
      catch (err) {
        if (err.code !== 'ENOENT') throw err;
        loaded = crypto.randomBytes(32);
        await writeFile(keyFile, loaded, { mode: 0o600, flag: 'wx' });
      }
      key = loaded;
      return key;
    })().catch(err => { keyReady = undefined; throw err; });
    return keyReady;
  }
  async function signingKey() {
    return crypto.hkdfSync('sha256', await ensureKey(), Buffer.from('ai-media-flow-v1'), Buffer.from('kyy-asset-url'), 32);
  }
  async function persist(input) {
    const next = validateSettings(input, current());
    await ensureKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    saved = next;
    return publicSettings();
  }
  return {
    current,
    publicSettings,
    async createAssetUrl(sourceId, mime) {
      const base = current().PUBLIC_ASSET_BASE_URL;
      if (!base) throw new Error('请先在模型设置中填写素材访问地址。kyyReactApi 必须能通过公网 HTTPS 访问该地址，本机 localhost 不可用。');
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const signing = await signingKey();
      const signature = crypto.createHmac('sha256', signing).update(`${sourceId}.${mime}.${expires}`).digest('hex');
      return `${base}/api/kyy-assets/${encodeURIComponent(sourceId)}?type=${encodeURIComponent(mime)}&expires=${expires}&signature=${signature}`;
    },
    async verifyAssetUrl(sourceId, mime, expires, signature) {
      if (!key || !current().PUBLIC_ASSET_BASE_URL || !/^\d{10}$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000) || Number(expires) > Math.floor(Date.now() / 1000) + 3601 || !/^[a-f0-9]{64}$/.test(signature)) return false;
      const signing = await signingKey();
      const expected = crypto.createHmac('sha256', signing).update(`${sourceId}.${mime}.${expires}`).digest();
      return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    },
    update(input) {
      // One application process owns this data directory; serialize concurrent settings saves.
      const operation = queue.then(() => persist(input));
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
