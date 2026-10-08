import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLibrary, setFavorite, setHidden, getHiddenIds, allValues, storeAsset, getAsset, getImages, trimCache, storageUsage, putValue, getValue, database, getThumbnailAsset } from '../extension/db.js';
import { visibleImages } from '../extension/core.js';
import { readAsset } from '../extension/idb-db.js';

test('migration reads legacy Blob bytes without rewriting the source',async()=>{
  const key = 'migration-read:picture:original';
  await putValue('assets',{key,blob:new Blob(['old original'],{type:'image/png'})});
  const db = await database(), transaction = db.transaction.bind(db), modes = [];
  db.transaction = (stores,mode,...args)=>{modes.push(mode || 'readonly');return transaction(stores,mode,...args);};
  try { assert.equal(await (await readAsset('migration-read','picture')).text(),'old original'); }
  finally { db.transaction = transaction; }
  assert.ok(modes.every(mode=>mode==='readonly'));
  assert.equal((await getValue('assets',key)).bytes,undefined);
});

test('hiding persists only account-scoped IDs, preserves favorites and creates no assets', async () => {
  await mergeLibrary('hidden-a', [{ id: 'same', createdAt: 2 }, { id: 'ordinary', createdAt: 1 }]);
  await mergeLibrary('hidden-b', [{ id: 'same' }]);
  await storeAsset('hidden-a', 'same', 'original', new Blob(['original']));
  await setFavorite('hidden-a', 'same', true);
  const assets = await allValues('assets');
  await Promise.all([setHidden('hidden-a', 'same', true), setHidden('hidden-a', 'ordinary', true)]);
  const hidden = await getHiddenIds('hidden-a'), images = await getImages('hidden-a');
  assert.deepEqual([...hidden].sort(), ['ordinary', 'same']);
  assert.deepEqual(await getValue('hidden', 'hidden-a'), { key: 'hidden-a', ids: ['same', 'ordinary'] });
  assert.deepEqual(await allValues('assets'), assets);
  assert.equal((await getHiddenIds('hidden-b')).size, 0);
  assert.equal(visibleImages(images, 'all', hidden).length, 0);
  assert.equal(visibleImages(images, 'favorites', hidden).length, 0);
  assert.deepEqual(visibleImages(images, 'hidden', hidden).map(image => image.id), ['same', 'ordinary']);
  assert.equal(images.find(image => image.id === 'same').favorite, true);
  await mergeLibrary('hidden-a', [], true);
  assert.ok((await getHiddenIds('hidden-a')).has('ordinary'));
  await setHidden('hidden-a', 'same', false);
  assert.equal(visibleImages(await getImages('hidden-a'), 'favorites', await getHiddenIds('hidden-a'))[0].id, 'same');
});

test('accounts, collected originals and restored views stay separate', async () => {
  await mergeLibrary('account-a', [{ id: 'same-id', title: 'A' }]);
  await mergeLibrary('account-b', [{ id: 'same-id', title: 'B' }]);
  await setFavorite('account-a', 'same-id', true);
  await storeAsset('account-a', 'same-id', 'original', new Blob(['A'], { type: 'image/png' }));
  await storeAsset('account-b', 'same-id', 'original', new Blob(['B'], { type: 'image/png' }));
  assert.equal((await getImages('account-a'))[0].saved, true);
  assert.equal((await getImages('account-b'))[0].favorite, false);
  assert.equal(await (await getAsset('account-a', 'same-id')).text(), 'A');
  assert.equal(await (await getAsset('account-b', 'same-id')).text(), 'B');
  await putValue('views', { key: 'account-a', selectedId: 'same-id', transform: { scale: 2, x: 75, y: 10 }, scrollTop: 500 });
  assert.equal((await getValue('views', 'account-a')).transform.x, 75);
  assert.equal(await getValue('views', 'account-b'), undefined);
});
test('normal asset hits are readonly, preserve access metadata, and cannot downgrade clear thumbnails', async () => {
  await mergeLibrary('readonly', [{ id: 'image' }]);
  const details = { width: 896, height: 672, sourceWidth: 1024, sourceHeight: 768, thumbnailVersion: 1 };
  await storeAsset('readonly', 'image', 'thumbnail', new Blob(['sharp']), details);
  const db = await database(), transaction = db.transaction.bind(db), modes = [];
  const before = await getValue('assetInfo', 'readonly:image:thumbnail');
  db.transaction = (stores, mode, ...args) => { modes.push(mode || 'readonly'); return transaction(stores, mode, ...args); };
  try {
    assert.equal(await (await getAsset('readonly', 'image', 'thumbnail')).text(), 'sharp');
    assert.equal((await getThumbnailAsset('readonly', 'image')).width, 896);
  } finally { db.transaction = transaction; }
  assert.ok(modes.every(mode => mode === 'readonly'));
  assert.equal((await getValue('assetInfo', 'readonly:image:thumbnail')).accessedAt, before.accessedAt);
  await storeAsset('readonly', 'image', 'thumbnail', new Blob(['blurry']), { ...details, width: 320, height: 240 });
  await storeAsset('readonly', 'image', 'thumbnail', new Blob(['fallback']));
  assert.equal(await (await getAsset('readonly', 'image', 'thumbnail')).text(), 'sharp');
  await mergeLibrary('readonly', [{ id: 'image', width: 0, height: 0 }]);
  const geometry = (await getImages('readonly'))[0];
  assert.equal(geometry.width, 1024); assert.equal(geometry.height, 768);
});
test('collection pins existing bytes; cancellation makes them ordinary cache again', async () => {
  await mergeLibrary('account-c', [{ id: 'image' }]);
  await storeAsset('account-c', 'image', 'original', new Blob(['saved-image']));
  await setFavorite('account-c', 'image', true);
  await trimCache(new Set(), '1week');
  assert.ok(await getAsset('account-c', 'image'));
  assert.equal((await storageUsage('account-c')).favorites, 11);
  await setFavorite('account-c', 'image', false);
  await trimCache(new Set(), '1week');
  assert.ok(await getAsset('account-c', 'image'));
  assert.equal((await storageUsage('account-c')).favorites, 0);
});
test('cancelling during a download cannot leave a pinned or saved favorite', async () => {
  await mergeLibrary('account-d', [{ id: 'image' }]);
  await setFavorite('account-d', 'image', true);
  await setFavorite('account-d', 'image', false);
  await storeAsset('account-d', 'image', 'original', new Blob(['bytes']));
  const image = (await getImages('account-d'))[0];
  assert.equal(image.favorite, false); assert.equal(image.saved, false);
  assert.equal((await storageUsage('account-d')).favorites, 0);
});
test('refresh racing with a collection toggle keeps the collection', async () => {
  await mergeLibrary('account-e', [{ id: 'image', title: 'Original' }]);
  await Promise.all([mergeLibrary('account-e', [{ id: 'image', title: 'Updated' }]), setFavorite('account-e', 'image', true)]);
  const image = (await getImages('account-e'))[0];
  assert.equal(image.favorite, true); assert.equal(image.title, 'Updated');
});
test('deleting a source from a successful complete snapshot retains collected bytes', async () => {
  await mergeLibrary('account-f', [{ id: 'image' }]);
  await setFavorite('account-f', 'image', true);
  await storeAsset('account-f', 'image', 'original', new Blob(['bytes']));
  await mergeLibrary('account-f', [], true);
  assert.equal((await getImages('account-f'))[0].deleted, true);
  assert.ok(await getAsset('account-f', 'image'));
});
test('repeated cache reads own their bytes and migrate legacy Blob records', async () => {
  const key = 'account-g:image:original';
  await mergeLibrary('account-g', [{ id: 'image' }]);
  await putValue('assets', { key, account: 'account-g', id: 'image', kind: 'original', blob: new Blob(['legacy'], { type: 'image/png' }), size: 6, pinned: false });
  const first = await getAsset('account-g', 'image');
  const second = await getAsset('account-g', 'image');
  assert.equal(await first.text(), 'legacy');
  assert.equal(await second.text(), 'legacy');
  assert.equal(second.type, 'image/png');
  const persisted = await getValue('assets', key);
  assert.ok(persisted.bytes instanceof ArrayBuffer);
  assert.equal(persisted.blob, undefined);
  await Promise.all([getAsset('account-g', 'image'), setFavorite('account-g', 'image', true)]);
  assert.equal((await getValue('assetInfo', key)).pinned, true);
});
