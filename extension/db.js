import * as legacy from './idb-db.js';
import { nativeRequest, nativeRead, nativeWrite, nativeThumbnail, nativeVerify, nativeReceipt } from './native-storage.js';
import { cacheProgress } from './cache-policy.js';
import { fitsThumbnail, THUMBNAIL_VERSION } from './thumbnail-cache.js';

const native = globalThis.location?.protocol === 'safari-web-extension:';
export const database = legacy.database;
export async function getValue(store, key) { return native ? nativeRequest('get', { store, key }) : legacy.getValue(store, key); }
export async function putValue(store, value) { return native ? nativeRequest('put', { store, value }) : legacy.putValue(store, value); }
export async function putValues(store, rows) {
  if (!native) return Promise.all(rows.map(value => legacy.putValue(store, value)));
  for (let offset = 0; offset < rows.length; offset += 100) await nativeRequest('batch', { store, rows: rows.slice(offset, offset + 100) });
}
export async function allValues(store) {
  if (!native) return legacy.allValues(store);
  const values = [];
  for (let offset = 0;; offset += 100) {
    const page = await nativeRequest('list', { store, offset }); values.push(...page);
    if (page.length < 100) return values;
  }
}
export async function updateValue(store, key, changes) { return native ? nativeRequest('update', { store, key, changes }) : legacy.updateValue(store, key, changes); }
export async function getHiddenIds(account) { return new Set((await getValue('hidden', account))?.ids || []); }
export async function setHidden(account, id, hidden) { return native ? nativeRequest('hidden', { account, id, hidden }) : legacy.setHidden(account, id, hidden); }
export async function setFavorite(account, id, favorite) { return native ? nativeRequest('favorite', { account, id, favorite }) : legacy.setFavorite(account, id, favorite); }
export async function mergeLibrary(account, images, complete = false) {
  if (!native) return legacy.mergeLibrary(account, images, complete);
  for (let offset = 0; offset < images.length; offset += 100) await nativeRequest('merge', { account, images: images.slice(offset, offset + 100) });
  if (complete) await nativeRequest('reconcile', { account, ids: images.map(image => image.id) });
}
export async function getImages(account) {
  if (!native) return legacy.getImages(account);
  return (await allValues('images')).filter(image => image.account === account);
}
export async function assetMetadata(account) {
  if (!native) return legacy.assetMetadata(account);
  const originals = (await allValues('assetInfo')).filter(asset => asset.kind === 'original');
  const thumbnails = (await legacy.assetMetadata(account)).filter(asset => asset.kind === 'thumbnail');
  return [...originals.filter(asset => !account || asset.account === account), ...thumbnails];
}
export async function getAsset(account, id, kind = 'original', options = {}) {
  return native && kind === 'original' ? nativeRead(`${account}:${id}:original`, options) : legacy.getAsset(account, id, kind);
}
export async function getThumbnailAsset(account, id, box) {
  const cached = await legacy.getThumbnailAsset(account, id);
  if (!native || !box || cached?.thumbnailVersion === THUMBNAIL_VERSION && fitsThumbnail(cached, box)) return cached;
  // A rebuildable native cache can be unavailable or full while the persistent
  // original remains readable. Keep the existing original-based fallback.
  let thumbnail;
  try { thumbnail = await nativeThumbnail(`${account}:${id}:original`, box); } catch { return cached; }
  if (!thumbnail) return cached;
  const { blob, ...details } = thumbnail;
  await storeAsset(account, id, 'thumbnail', blob, details);
  return thumbnail;
}
export async function storeAsset(account, id, kind, blob, details = {}) {
  if (!native || kind === 'thumbnail') {
    await legacy.storeAsset(account, id, kind, blob, details);
    if (native && !details.geometryStored && details.sourceWidth > 0 && details.sourceHeight > 0) {
      const image = await getValue('images', `${account}:${id}`);
      if (image && !(image.width > 0 && image.height > 0)) await updateValue('images', image.key, { width: details.sourceWidth, height: details.sourceHeight });
    }
    return;
  }
  const image = await getValue('images', `${account}:${id}`);
  await nativeWrite({ ...details, key: `${account}:${id}:original`, account, id, kind, pinned: Boolean(image?.favorite), accessedAt: Date.now() }, blob);
}
export async function trimCache() { return []; }
export async function storageUsage(account) {
  const assets = await assetMetadata(account);
  return { favorites: assets.filter(asset => asset.pinned).reduce((sum, asset) => sum + asset.size, 0),
    cache: assets.filter(asset => !asset.pinned).reduce((sum, asset) => sum + asset.size, 0) };
}
export async function cacheSummary(account) {
  if (!native) return { ...cacheProgress(await getImages(account), await assetMetadata(account)), ...await storageUsage(account) };
  const summary = await nativeRequest('summary', { account });
  const thumbnails = (await legacy.assetMetadata(account)).filter(asset => asset.kind === 'thumbnail');
  return { ...summary, cache: summary.cache + thumbnails.filter(asset => !asset.pinned).reduce((sum, asset) => sum + asset.size, 0),
    favorites: summary.favorites + thumbnails.filter(asset => asset.pinned).reduce((sum, asset) => sum + asset.size, 0) };
}

let migrating;
// Resumable copy of the current signing identity's IndexedDB. Other signing
// identities require the separate legacy transfer; an empty DB proves nothing.
export async function migrateStorage() {
  if (!native) return { phase: 'preview' };
  if (migrating) return migrating;
  migrating = (async () => {
    await nativeRequest('ping');
    const previous = await getValue('migration', 'indexeddb');
    if (['verified', 'cleaned', 'empty'].includes(previous?.phase)) return previous;
    const assets = (await legacy.assetMetadata()).filter(asset => asset.kind === 'original');
    let state = { key: 'indexeddb', phase: 'copying', completed: 0, total: assets.length, error: '' };
    const save = async changes => { state = { ...state, ...changes }; await putValue('migration', state); };
    try {
      for (const store of ['accounts', 'images', 'views', 'jobs', 'hidden']) {
        const rows = await legacy.allValues(store);
        for (let offset = 0; offset < rows.length; offset += 100) await nativeRequest('import-missing', { store, rows: rows.slice(offset, offset + 100) });
      }
      await save({});
      for (const info of assets) {
        const blob = await legacy.readAsset(info.account, info.id, 'original');
        if (!blob || blob.size !== info.size) throw new Error('旧原图读取不完整，已保留旧存储。');
        await nativeWrite(info, blob);
        await save({ completed: state.completed + 1 });
      }
      await save({ phase: 'verifying' });
      await nativeVerify();
      await save({ phase: assets.length ? 'verified' : 'empty', verifiedKeys: assets.map(asset => asset.key) });
    } catch (error) {
      await save({ phase: 'paused', error: error.code === 'QUOTA' ? '空间不足，迁移已暂停；旧数据仍保留。' : error.message });
      throw error;
    }
    return state;
  })().finally(() => { migrating = null; });
  return migrating;
}
export async function migrationStatus() {
  if (!native) return { phase: 'preview' };
  const imported = await getValue('migration', 'legacy-import');
  if (imported) return { ...imported, external: true };
  return await getValue('migration', 'indexeddb') || { phase: 'pending', completed: 0, total: 0 };
}
export async function cleanLegacyStorage() {
  if (!native) throw new Error('仅 Safari 原生版本可清理旧存储。');
  const state = await migrationStatus();
  if (state.external) return { receipt: await nativeReceipt() };
  if (state.phase !== 'verified') throw new Error('迁移尚未核对完成，不能清理。');
  await nativeVerify();
  // Recheck every legacy byte against the current native copy just before deleting.
  const keys = [];
  for (const key of state.verifiedKeys || []) {
    const info = await legacy.getValue('assetInfo', key);
    if (!info) continue;
    const blob = await legacy.readAsset(info.account, info.id, 'original');
    if (!blob) throw new Error('旧数据已变化，请重新迁移后再清理。');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const saved = await nativeRequest('asset-info', { key });
    if (saved?.digest !== digest || saved.size !== blob.size) throw new Error('旧数据已变化，请重新迁移后再清理。');
    keys.push(key);
  }
  const db = await legacy.database(), tx = db.transaction(['assets', 'assetInfo'], 'readwrite');
  const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
  for (const key of keys) { tx.objectStore('assets').delete(key); tx.objectStore('assetInfo').delete(key); }
  await done;
  await putValue('migration', { ...state, phase: 'cleaned' });
}
