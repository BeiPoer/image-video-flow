export const resolutions = ['480p', '720p', '1080p', '4k'];
export const defaults = {
  OPENAI_IMAGE_PRICE: '',
  VIDEO_RESOLUTIONS: resolutions.join(','),
  VIDEO_MIN_SECONDS: '1',
  VIDEO_MAX_SECONDS: '30',
  VIDEO_PRICE_480P: '', VIDEO_PRICE_720P: '', VIDEO_PRICE_1080P: '', VIDEO_PRICE_4K: '',
};
export function settings(config) {
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, config[key] ?? value]));
}
export function videoLimits(config) {
  return { resolutions: (config.VIDEO_RESOLUTIONS ?? defaults.VIDEO_RESOLUTIONS).split(','), min: Number(config.VIDEO_MIN_SECONDS ?? 1), max: Math.min(Number(config.VIDEO_MAX_SECONDS ?? 30), 30) };
}
export function videoSizes(resolution) {
  const [width, height] = { '480p':[480, 854], '720p':[720, 1280], '1080p':[1080, 1920], '4k':[2160, 3840] }[resolution];
  return [`${width}x${height}`, `${height}x${width}`];
}
export function resolutionForSize(size) {
  return resolutions.find(resolution => videoSizes(resolution).includes(size)) || (['1024x1792', '1792x1024'].includes(size) ? '1080p' : undefined);
}
export function estimate(kind, params, config) {
  const resolution = params.resolution || resolutionForSize(params.videoSize) || '720p';
  const price = config[kind === 'image' ? 'OPENAI_IMAGE_PRICE' : 'VIDEO_PRICE_' + resolution.toUpperCase()];
  const quantity = kind === 'image' ? (params.n ?? 1) : params.duration;
  if (price === undefined || price === '' || !Number.isInteger(quantity) || quantity < 1) return null;
  // Store ten-thousandths of a yuan so decimal prices multiply without floating-point drift.
  return Math.round(Number(price) * 10000) * quantity;
}
export function formatPrice(amount) {
  return (amount / 10000).toFixed(4).replace(/(\.\d{2})0+$/, '$1');
}
