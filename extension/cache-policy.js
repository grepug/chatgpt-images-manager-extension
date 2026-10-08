export const CACHE_MODES = ['demand', 'full'];
export const DEFAULT_CACHE_MODE = 'full';
export function cacheMode(value) { return CACHE_MODES.includes(value) ? value : DEFAULT_CACHE_MODE; }
export function cacheTargets(images) {
  return images.filter(image => !image.deleted).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
// Originals are persistent data. Neither age nor mode changes evict them.
export function evictionPlan() { return []; }
export function cacheProgress(images, assets) {
  const originals = new Set(assets.filter(asset => asset.kind === 'original').map(asset => asset.key));
  const targets = cacheTargets(images);
  return { total: targets.length, completed: targets.filter(image => originals.has(`${image.account}:${image.id}:original`)).length,
    retained: images.filter(image => image.deleted && originals.has(`${image.account}:${image.id}:original`)).length };
}
export function pendingAssets(images, assets, mode, failures = {}, now = Date.now(), demandIds = []) {
  const keys = new Set(assets.map(asset => asset.key)), demand = new Map(demandIds.map((id, index) => [id, index]));
  const targets = cacheTargets(images).filter(image => cacheMode(mode) === 'full' || demand.has(image.id) || image.favorite);
  targets.sort((a, b) => (demand.get(a.id) ?? Infinity) - (demand.get(b.id) ?? Infinity));
  const pending = [];
  for (const image of targets) for (const kind of ['thumbnail', 'original']) {
    const key = `${image.account}:${image.id}:${kind}`;
    if (!keys.has(key) && (failures[key]?.retryAt || 0) <= now) pending.push({ id: image.id, kind, key });
  }
  return pending;
}
