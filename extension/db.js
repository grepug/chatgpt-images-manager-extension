import { mergeImages } from './core.js';
import { DEFAULT_CACHE_PERIOD, evictionPlan } from './cache-policy.js';
const DB_NAME = 'chatgpt-images-manager';
let opening;
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const completion = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error || new Error('存储操作被中止')); });

export function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const operation = indexedDB.open(DB_NAME, 3);
    operation.onupgradeneeded = event => {
      for (const store of ['accounts', 'images', 'assets', 'views', 'assetInfo', 'jobs', 'hidden']) {
        if (!operation.result.objectStoreNames.contains(store)) operation.result.createObjectStore(store, { keyPath: 'key' });
      }
      if (event.oldVersion >= 2) return;
      const info = operation.transaction.objectStore('assetInfo');
      const cursor = operation.transaction.objectStore('assets').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const { bytes, blob, ...metadata } = row.value;
        info.put(metadata); row.continue();
      };
    };
    operation.onsuccess = () => { operation.result.onversionchange = () => { operation.result.close(); opening = null; }; resolve(operation.result); };
    operation.onerror = () => { opening = null; reject(operation.error); };
  });
  return opening;
}
export async function getValue(store, key) {
  const db = await database();
  return request(db.transaction(store).objectStore(store).get(key));
}
export async function putValue(store, value) {
  const db = await database();
  const transaction = db.transaction(store, 'readwrite');
  const done = completion(transaction);
  transaction.objectStore(store).put(value);
  await done;
}
export async function allValues(store) {
  const db = await database();
  return request(db.transaction(store).objectStore(store).getAll());
}
export async function getHiddenIds(account) {
  return new Set((await getValue('hidden', account))?.ids || []);
}
export async function setHidden(account, id, hidden) {
  if (!account || typeof id !== 'string' || !id) throw new Error('图片不存在');
  const db = await database(), transaction = db.transaction('hidden', 'readwrite'), done = completion(transaction);
  const store = transaction.objectStore('hidden');
  const ids = new Set((await request(store.get(account)))?.ids || []);
  if (hidden) ids.add(id); else ids.delete(id);
  store.put({ key: account, ids: [...ids] });
  await done;
  return { id, hidden };
}
export async function getImages(account) {
  const images = (await allValues('images')).filter(image => image.account === account);
  if (images.every(image => image.width > 0 && image.height > 0)) return images;
  // Older images omitted geometry. Reuse thumbnail metadata before laying out
  // cards, without reading image bytes or repeatedly shifting the waterfall.
  const geometry = new Map((await assetMetadata(account)).filter(asset => asset.sourceWidth && asset.sourceHeight)
    .map(asset => [asset.id, { width: asset.sourceWidth, height: asset.sourceHeight }]));
  return images.map(image => image.width > 0 && image.height > 0 ? image : { ...image, ...geometry.get(image.id) });
}
export async function assetMetadata(account) { return (await allValues('assetInfo')).filter(asset => !account || asset.account === account); }
export async function updateValue(storeName, key, changes) {
  const db = await database();
  const transaction = db.transaction(storeName, 'readwrite'), done = completion(transaction);
  const store = transaction.objectStore(storeName);
  const value = { ...await request(store.get(key)), ...changes, key };
  store.put(value); await done; return value;
}

export async function mergeLibrary(account, incoming, complete = false) {
  const db = await database();
  const transaction = db.transaction('images', 'readwrite');
  const done = completion(transaction);
  const store = transaction.objectStore('images');
  // Read and merge in one transaction so a concurrent favorite toggle cannot be overwritten.
  const existing = await request(store.getAll());
  const records = mergeImages(existing.filter(image => image.account === account), incoming, complete);
  for (const image of records) store.put({ ...image, account, key: `${account}:${image.id}` });
  await done;
  return records;
}
export async function setFavorite(account, id, favorite) {
  // Materialize older Blob records before their metadata is rewritten in Safari.
  await getAsset(account, id, 'original');
  const db = await database();
  const transaction = db.transaction(['images', 'assetInfo'], 'readwrite');
  const done = completion(transaction);
  const store = transaction.objectStore('images');
  const image = await request(store.get(`${account}:${id}`));
  if (!image) throw new Error('图片不存在');
  image.favorite = favorite;
  const assets = transaction.objectStore('assetInfo');
  const asset = await request(assets.get(`${account}:${id}:original`));
  image.saved = Boolean(favorite && asset);
  store.put(image);
  if (asset) assets.put({ ...asset, pinned: favorite, accessedAt: Date.now() });
  await done;
  return image;
}
export async function getAsset(account, id, kind = 'original') {
  const key = `${account}:${id}:${kind}`;
  const asset = await getValue('assets', key);
  if (!asset) return null;
  // Safari can invalidate an IndexedDB-backed Blob when the same record is put.
  // Own the bytes before updating access metadata, and migrate old records lazily.
  const bytes = asset.bytes || await asset.blob.arrayBuffer();
  const mime = asset.mime ?? asset.blob?.type ?? '';
  // Time-based eviction does not need access timestamps. Normal reads stay readonly.
  if (asset.bytes) return new Blob([bytes], { type: mime });
  const db = await database();
  const transaction = db.transaction(['assets', 'assetInfo'], 'readwrite');
  const done = completion(transaction);
  const store = transaction.objectStore('assets');
  if (!asset.bytes) store.put({ key, bytes, mime });
  const infoStore = transaction.objectStore('assetInfo');
  const { bytes: storedBytes, blob: storedBlob, ...legacyMetadata } = asset;
  const metadata = await request(infoStore.get(key)) || (asset.account ? legacyMetadata : null);
  if (metadata) infoStore.put({ ...metadata, accessedAt: Date.now() });
  await done;
  return new Blob([bytes], { type: mime });
}
export async function getThumbnailAsset(account, id) {
  const asset = await getValue('assets', `${account}:${id}:thumbnail`);
  if (!asset) return null;
  const bytes = asset.bytes || await asset.blob.arrayBuffer();
  return { ...asset, bytes: undefined, blob: new Blob([bytes], { type: asset.mime ?? asset.blob?.type ?? '' }) };
}
export async function storeAsset(account, id, kind, blob, details = {}) {
  const bytes = await blob.arrayBuffer();
  const db = await database();
  const transaction = db.transaction(['images', 'assets', 'assetInfo'], 'readwrite');
  const done = completion(transaction);
  const images = transaction.objectStore('images');
  const image = await request(images.get(`${account}:${id}`));
  const pinned = Boolean(image?.favorite && kind === 'original');
  const key = `${account}:${id}:${kind}`;
  if (kind === 'thumbnail') {
    const previous = await request(transaction.objectStore('assets').get(key));
    if (previous?.thumbnailVersion >= (details.thumbnailVersion || 0) && previous.width >= (details.width || 0)) { await done; return; }
  }
  transaction.objectStore('assets').put({ ...details, key, bytes, mime: blob.type });
  transaction.objectStore('assetInfo').put({ ...details, key, account, id, kind, mime: blob.type, size: blob.size, pinned, accessedAt: Date.now() });
  if (pinned) images.put({ ...image, saved: true });
  else if (image && details.sourceWidth > 0 && details.sourceHeight > 0 && !(image.width > 0 && image.height > 0))
    images.put({ ...image, width: details.sourceWidth, height: details.sourceHeight });
  await done;
}
export async function trimCache(protectedKeys = new Set(), period = DEFAULT_CACHE_PERIOD, now = Date.now()) {
  const db = await database();
  const transaction = db.transaction(['assets', 'assetInfo', 'images'], 'readwrite');
  const done = completion(transaction);
  const store = transaction.objectStore('assets');
  const info = transaction.objectStore('assetInfo');
  const assets = await request(info.getAll());
  const images = await request(transaction.objectStore('images').getAll());
  const evicted = evictionPlan(assets, images, period, protectedKeys, now);
  for (const key of evicted) { store.delete(key); info.delete(key); }
  await done;
  return evicted;
}
export async function storageUsage(account) {
  const assets = await assetMetadata(account);
  return { favorites: assets.filter(asset => asset.pinned).reduce((sum, asset) => sum + asset.size, 0),
    cache: assets.filter(asset => !asset.pinned).reduce((sum, asset) => sum + asset.size, 0) };
}
