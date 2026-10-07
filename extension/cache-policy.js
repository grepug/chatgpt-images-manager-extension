export const CACHE_PERIODS = ['1week', '1month', '6months'];
export const DEFAULT_CACHE_PERIOD = '6months';
export function cachePeriod(value) { return CACHE_PERIODS.includes(value) ? value : DEFAULT_CACHE_PERIOD; }
export function cacheCutoff(period, now = Date.now()) {
  if (cachePeriod(period) === '1week') return now - 7 * 86400000;
  const date = new Date(now), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - (period === '1month' ? 1 : 6));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}
export function cacheTargets(images, period, now = Date.now()) {
  const cutoff = cacheCutoff(period, now);
  return images.filter(image => image.favorite || (!image.deleted && image.createdAt >= cutoff))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export function evictionPlan(assets, images, period, protectedKeys = new Set(), now = Date.now()) {
  const keep = new Map(images.map(image => [`${image.account}:${image.id}`, image]));
  const cutoff = cacheCutoff(period, now);
  return assets.filter(asset => {
    const image = keep.get(`${asset.account}:${asset.id}`);
    if (asset.pinned || image?.favorite || protectedKeys.has(asset.key)) return false;
    return !image || image.deleted || !image.createdAt || image.createdAt < cutoff;
  }).map(asset => asset.key);
}
export function cacheProgress(images, assets, period, now = Date.now()) {
  const targets = cacheTargets(images, period, now);
  const keys = new Set(assets.map(asset => asset.key));
  const complete = image => keys.has(`${image.account}:${image.id}:original`) &&
    (image.favorite && (image.deleted || image.createdAt < cacheCutoff(period, now)) || keys.has(`${image.account}:${image.id}:thumbnail`));
  return { total: targets.length, completed: targets.filter(complete).length };
}
export function pendingAssets(images, assets, period, failures = {}, now = Date.now()) {
  const keys = new Set(assets.map(asset => asset.key));
  const cutoff = cacheCutoff(period, now), pending = [];
  for (const image of cacheTargets(images, period, now)) {
    const kinds = image.favorite && (image.deleted || image.createdAt < cutoff) ? ['original'] : ['original', 'thumbnail'];
    for (const kind of kinds) {
      const key = `${image.account}:${image.id}:${kind}`;
      if (!keys.has(key) && (failures[key]?.retryAt || 0) <= now) pending.push({ id: image.id, kind, key });
    }
  }
  return pending;
}
