import { setTimeout as sleep } from 'node:timers/promises';

export const videoApiTypes = ['volcengine', 'openai', 'kyyReactApi'];
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function message(payload, fallback) {
  return typeof payload?.error === 'string' ? payload.error : payload?.error?.message || payload?.errorMessage || payload?.message || payload?.msg || fallback;
}
function networkError(err, stage) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(err.cause?.code || '') ? err.cause.code : err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
  return Object.assign(new Error(`${stage}时网络请求失败（${code}）；上游任务可能已受理或完成，请勿重复提交生成`), { networkError: true });
}
function kyyAsset(payload) {
  if (payload?.code != null && ![0, 200].includes(Number(payload.code))) throw new Error(message(payload, `素材接口错误码 ${payload.code}`));
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
}
function mediaUrl(value) {
  if (typeof value !== 'string' || !value) invalid('素材地址必须是有效的 URL');
  let url;
  try { url = new URL(value); } catch { invalid('视频接口未返回有效的视频地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) invalid('视频接口返回了不支持的视频地址');
  return url.href;
}

export function videoRequest(prompt, image, params = {}, config) {
  const type = config.VIDEO_API_TYPE || 'openai';
  if (!videoApiTypes.includes(type)) invalid('不支持的视频接口类型');
  if (typeof prompt !== 'string' || !prompt.trim()) invalid('请填写视频提示词');
  const duration = Number(params.duration ?? (type === 'openai' ? 8 : 6));
  if (!Number.isInteger(duration) || duration < 1 || duration > 60) invalid('视频时长必须为 1–60 之间的整数');
  const ratio = params.ratio || '9:16';
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].includes(ratio)) invalid('不支持的视频画幅比例');
  function checkImage(image) {
    if (typeof image !== 'string' || !image) invalid('参考图必须是 URL 或图片数据');
    if (/^assetId:\/\/[A-Za-z0-9_-]+$/.test(image)) {
      if (type !== 'kyyReactApi') invalid('assetId:// 仅适用于 kyyReactApi');
    } else if (image.startsWith('data:')) {
      if (type === 'kyyReactApi') invalid('kyyReactApi 素材地址必须是公网可访问 URL 或 assetId://素材ID');
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/\r\n]+=*$/.test(image)) invalid('参考图仅支持 PNG、JPEG 或 WebP 图片，请替换演示参考图');
      const encoded = image.slice(image.indexOf(',') + 1).replace(/\s/g, '');
      if (encoded.length > 40_000_000 || Buffer.from(encoded, 'base64').length > 30 * 1024 * 1024) invalid('参考图超过 30 MB，请缩小图片后重试');
    } else mediaUrl(image);
    return image;
  }
  if (image) checkImage(image);
  const body = { model: config.SEEDANCE_MODEL, prompt: prompt.trim() };
  if (type === 'openai') {
    const size = params.videoSize || ({ '9:16': '720x1280', '16:9': '1280x720' })[ratio];
    if (!size || !/^\d{3,4}x\d{3,4}$/.test(size)) invalid('OpenAI Video 需要明确的视频尺寸，例如 720x1280');
    const lists=[params.referenceImages??[],params.referenceVideos??[],params.referenceAudios??[]];
    if (!lists.every(Array.isArray)) invalid('参考素材必须是列表');
    if (lists[0].length>9||lists[1].length>3||lists[2].length>3) invalid('参考素材数量超过接口限制（图片 9、视频 3、音频 3）');
    const extended=params.referenceImages!==undefined||params.referenceVideos!==undefined||params.referenceAudios!==undefined||params.firstImage||params.lastImage;
    if (extended) {
      const images=[...new Set([...lists[0],...(image?[image]:[])])],videos=[...new Set(lists[1])],audios=[...new Set(lists[2])];
      if (images.length>9) invalid('参考图片数量超过 9 张上限');
      if ((params.firstImage||params.lastImage)&&(images.length||videos.length||audios.length)) invalid('首帧/尾帧不能与多模态参考素材混用');
      if (params.lastImage&&!params.firstImage) invalid('使用尾帧时必须同时选择首帧');
      if (audios.length&&!images.length&&!videos.length) invalid('参考音频必须同时包含图片或视频参考素材');
      if ([...images,params.firstImage,params.lastImage].filter(value=>value!==undefined).some(value=>typeof value!=='string'||!value)) invalid('参考图必须是 URL 或图片数据');
      const content=images.map(url=>({type:'image_url',image_url:{url:checkImage(url)},role:'reference_image'}));
      for (const [values,kind] of [[videos,'video'],[audios,'audio']]) for (const url of values) content.push({type:kind+'_url',[kind+'_url']:{url:mediaUrl(url)},role:'reference_'+kind});
      for (const [value,role] of [[params.firstImage,'first_frame'],[params.lastImage,'last_frame']]) if(value)content.push({type:'image_url',image_url:{url:checkImage(value)},role});
      // New API's Seedance adapter forwards metadata.content with explicit reference/frame roles.
      return {type,path:'/videos',body:{...body,seconds:String(duration),size,...(content.length?{metadata:{content}}:{})}};
    }
    return { type, path: '/videos', body: { ...body, seconds: String(duration), size, ...(image ? { input_reference: { image_url: image } } : {}) } };
  }
  if (type === 'kyyReactApi') {
    if (duration < 4 || duration > 15) invalid('kyyReactApi Seedance 2.0 的时长范围是 4–15 秒');
    const resolution = params.resolution || '720p';
    if (!['720p', '1080p', '2k', '4k'].includes(resolution)) invalid('kyyReactApi 不支持该分辨率');
    const images=params.referenceImages||[], videos=params.referenceVideos||[], audios=params.referenceAudios||[];
    if (![images,videos,audios].every(Array.isArray)) invalid('参考素材必须是列表');
    if (images.length>9||videos.length>3||audios.length>3) invalid('参考素材数量超过接口限制');
    const media=value=>/^assetId:\/\/[A-Za-z0-9_-]+$/.test(value)?value:mediaUrl(value);
    const imageRefs=[...new Set([...images,...(image ? [image] : [])])].map(media);
    if(imageRefs.length>9)invalid('参考图片数量超过 9 张上限');
    const videoRefs=[...new Set(videos)].map(media), audioRefs=[...new Set(audios)].map(media);
    if ((params.firstImage||params.lastImage)&&(imageRefs.length||videoRefs.length||audioRefs.length)) invalid('首帧/尾帧不能与多模态参考素材混用');
    if (params.lastImage && !params.firstImage) invalid('使用尾帧时必须同时选择首帧');
    if (audioRefs.length&&!imageRefs.length&&!videoRefs.length) invalid('参考音频必须同时包含图片或视频参考素材');
    const refs=(key,values)=>values.length?{[key]:values}:{};
    return { type, path: '/v2/model-center/tasks', body: { ...body, duration, aspect_ratio: ratio, resolution, generate_audio: false, ...refs('reference_images',imageRefs), ...refs('reference_videos',videoRefs), ...refs('reference_audios',audioRefs), ...(params.firstImage?{first_image:media(params.firstImage)}:{}), ...(params.lastImage?{last_image:media(params.lastImage)}:{}) } };
  }
  const content = [{ type: 'text', text: prompt.trim() }];
  if (image) content.push({ type: 'image_url', image_url: { url: image }, role: 'reference_image' });
  return { type, path: '/contents/generations/tasks', body: { model: body.model, content, ratio, duration, generate_audio: false } };
}

// Concrete adapters share only HTTP/polling. No provider plugin framework is needed for three protocols.
export async function generateVideo(prompt, image, params, config, onUpdate = async () => {}, options = {}) {
  const request = videoRequest(prompt, image, params, config);
  const { type, path, body } = request;
  const base = config.SEEDANCE_BASE_URL.replace(/\/+$/, '');
  const authorization = `Bearer ${config.SEEDANCE_API_KEY}`;
  const fetcher = options.fetch || fetch;
  const wait = options.sleep || sleep;
  const interval = options.pollInterval ?? (type === 'openai' ? 10000 : 5000);
  const maxPolls = options.maxPolls ?? 120;
  async function json(pathname, value) {
    let response;
    try { response = await fetcher(base + pathname, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { authorization, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(120000), redirect: 'error',
    }); } catch (err) { throw networkError(err, value === undefined ? '查询视频状态' : '提交视频请求'); }
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`视频接口返回非 JSON 内容（HTTP ${response.status}），请检查 Base URL 和接口类型`); }
    if (!response.ok) throw Object.assign(new Error(message(payload, `视频接口请求失败（HTTP ${response.status}）`)), { httpStatus: response.status });
    return payload;
  }

  if (type === 'kyyReactApi') {
    const family = config.SEEDANCE_MODEL.includes('_fast_') ? 'sd_fast' : config.SEEDANCE_MODEL.includes('_mini_') ? 'sd_mini' : 'sd';
    async function ensureAsset(reference, assetType) {
      const existing = reference.startsWith('assetId://');
      let asset = existing
        ? kyyAsset(await json('/asset/seedance2/assetDetail', { assetId: reference.slice('assetId://'.length) }))
        : kyyAsset(await json('/asset/seedance2/assetUpload', { assetType, url: reference, name: '工作流参考素材', model: family }));
      if (typeof asset.assetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(asset.assetId)) throw new Error(message(asset, '素材接口未返回有效的 assetId'));
      const assetId=asset.assetId;
      for(let attempt=0;asset.status!=='ACTIVE';attempt++){
        await onUpdate({remoteAssetId:assetId,upstreamStatus:`asset_${asset.status}`});
        if(['FAILED','DELETED'].includes(asset.status))throw new Error(message(asset,'参考素材审核失败'));
        if(!['NONE','UPLOADING','PROCESSING','EXPIRED'].includes(asset.status))throw new Error(`未知素材状态：${asset.status}`);
        if(attempt>=maxPolls)throw new Error('素材尚未审核完成，请稍后重试；已保留素材 ID');
        await wait(interval); asset=kyyAsset(await json('/asset/seedance2/assetDetail',{assetId}));
      }
      await onUpdate({remoteAssetId:assetId,upstreamStatus:'asset_ACTIVE'});
      return `assetId://${assetId}`;
    }
    for(const [field,kind] of [['reference_images','Image'],['reference_videos','Video'],['reference_audios','Audio']]){
      if(body[field]) body[field]=await Promise.all(body[field].map(reference=>ensureAsset(reference,kind)));
    }
    for(const [field,kind] of [['first_image','Image'],['last_image','Image']]) if(body[field]) body[field]=await ensureAsset(body[field],kind);
  }

  let job;
  try { job = await json(path, body); }
  catch (err) {
    if (!err.httpStatus || err.httpStatus >= 500) err.uncertain = true;
    throw err;
  }
  if (typeof job?.id !== 'string' || !job.id || job.id.length > 300) throw Object.assign(new Error('提交后未返回有效任务 ID，请核实上游记录，避免重复计费'), { uncertain: true });
  const remoteId = job.id;
  const jobPath = `${path}/${encodeURIComponent(remoteId)}`;
  const done = type === 'volcengine' ? 'succeeded' : 'completed';
  let networkFailures = 0;
  for (let attempt = 0; ; attempt++) {
    await onUpdate({ remoteTaskId: remoteId, upstreamStatus: job.status || 'queued', ...(Number.isFinite(job.progress) ? { progress: Math.max(0, Math.min(100, job.progress)) } : {}) });
    if (job.status === done) break;
    if (['failed', 'cancelled', 'canceled', 'expired'].includes(job.status)) throw new Error(message(job, `视频任务已结束：${job.status}`));
    if (job.status && !['queued', 'pending', 'processing', 'running', 'in_progress'].includes(job.status)) throw Object.assign(new Error(`无法识别的视频任务状态：${job.status}`), { uncertain: true });
    if (attempt >= maxPolls) throw Object.assign(new Error('视频仍未完成，已保留上游任务 ID，请核实状态后再决定是否重做'), { uncertain: true });
    await wait(interval);
    try { job = await json(jobPath); networkFailures = 0; }
    catch (err) {
      if (err.networkError && ++networkFailures <= 3 && attempt < maxPolls) continue;
      if ([429, 500, 502, 503, 504].includes(err.httpStatus) && attempt < maxPolls) continue;
      err.uncertain = true; throw err;
    }
  }
  const url = type === 'volcengine' ? job.content?.video_url || job.content?.video?.url : job.video_url || job.result_url || job.url;
  if (url) return { url: mediaUrl(url), remoteId, type };
  if (type !== 'openai') throw new Error('视频任务已完成，但接口没有返回视频地址');
  let response;
  try { response = await fetcher(base + jobPath + '/content', { headers: { authorization }, signal: AbortSignal.timeout(120000), redirect: 'error' }); }
  catch (err) { throw Object.assign(networkError(err, '下载已生成的视频'), { uncertain: true }); }
  if (!response.ok) throw new Error(`视频已生成，但下载失败（HTTP ${response.status}）；上游任务 ID 已保留`);
  const mime = response.headers.get('content-type')?.split(';')[0];
  if (mime && !['video/mp4', 'application/octet-stream'].includes(mime)) throw new Error('视频下载接口未返回 MP4 内容，请检查接口类型');
  return { response, remoteId, type };
}
