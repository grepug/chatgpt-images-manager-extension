import test from 'node:test';
import assert from 'node:assert/strict';
import { ThumbnailCache, PriorityQueue, rasterSize, THUMBNAIL_VERSION } from '../extension/thumbnail-cache.js';

const box = { width: 300, height: 1e9, dpr: 2, cover: false };
const bytes = (width = 1024, height = 768) => Object.assign(new Blob(['pixels']), { width, height });
const disk = () => ({ blob: bytes(896, 672), width: 896, height: 672, sourceWidth: 1024, sourceHeight: 768, thumbnailVersion: THUMBNAIL_VERSION });
function harness(options = {}) {
  const calls = { reads: 0, originals: 0, downloads: 0, decodes: 0, resizes: 0, revoked: [], persisted: [] };
  const cache = new ThumbnailCache({
    readThumbnail: async () => { calls.reads++; return disk(); },
    readOriginal: async () => { calls.originals++; return bytes(); },
    download: async () => { calls.downloads++; throw new Error('Unexpected network'); },
    persist: async (account, id, value) => calls.persisted.push({ account, id, value }),
    decode: async blob => ({ url: `blob:test-${++calls.decodes}`, image: {}, width: blob.width, height: blob.height }),
    resize: async (blob, target) => { calls.resizes++; const size = rasterSize(blob.width, blob.height, target); return { blob: bytes(size.width, size.height), ...size, sourceWidth: blob.width, sourceHeight: blob.height }; },
    revoke: url => calls.revoked.push(url), ...options
  });
  return { cache, calls };
}
test('disk hits bypass downloads; hot scrollback reuses decoded URLs without IO', async () => {
  const { cache, calls } = harness();
  const first = cache.acquire('a', { id: 'image' }, box);
  const resource = await first.ready; first.release();
  const returned = cache.acquire('a', { id: 'image' }, box);
  assert.equal(returned.url, resource.url);
  assert.equal((await returned.ready).url, resource.url);
  assert.equal(calls.reads, 1); assert.equal(calls.decodes, 1);
  assert.equal(calls.originals, 0); assert.equal(calls.downloads, 0); assert.equal(calls.revoked.length, 0);
  returned.release(); cache.clear(); assert.equal(calls.revoked.length, 1);
});
test('pending requests deduplicate, but equal IDs from different accounts stay separate', async () => {
  const { cache, calls } = harness();
  const a = cache.acquire('a', { id: 'same' }, box), duplicate = cache.acquire('a', { id: 'same' }, box);
  const b = cache.acquire('b', { id: 'same' }, box);
  assert.equal((await a.ready).url, (await duplicate.ready).url);
  assert.notEqual((await a.ready).url, (await b.ready).url);
  assert.equal(calls.reads, 2);
  a.release(); duplicate.release(); b.release(); cache.clear();
});
test('three hanging network misses cannot hold up a cached thumbnail', async () => {
  const { cache } = harness({ readThumbnail: async (_, id) => id === 'cached' ? disk() : null,
    readOriginal: async () => null, download: () => new Promise(() => {}) });
  const misses = [1, 2, 3].map(id => cache.acquire('a', { id: String(id) }, box));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(cache.downloads.running, 3);
  const cached = cache.acquire('a', { id: 'cached' }, box);
  assert.ok(await Promise.race([cached.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Cache was blocked by network')), 100))]));
  for (const lease of [...misses, cached]) lease.release(); cache.clear();
});
test('nearby prewarming is local only and never downloads an uncached image', async () => {
  const { cache, calls } = harness({ readThumbnail: async () => null, readOriginal: async () => null });
  const lease = cache.acquire('a', { id: 'uncached' }, box, () => true, () => 2000, true);
  assert.equal(await lease.ready, null); assert.equal(calls.downloads, 0); lease.release(); cache.clear();
});
test('old blurry or oversized thumbnails rebuild from local originals at Retina density', async () => {
  const { cache, calls } = harness({ readThumbnail: async () => ({ blob: bytes(320, 240) }) });
  const lease = cache.acquire('a', { id: 'old' }, box);
  const resource = await lease.ready;
  assert.equal(resource.width, 640); assert.equal(resource.height, 480);
  assert.equal(resource.thumbnailVersion, THUMBNAIL_VERSION); assert.equal(calls.originals, 1); assert.equal(calls.downloads, 0);
  assert.equal(calls.resizes, 1); assert.equal(calls.persisted[0].value.width, 640);
  lease.release();
  const larger = cache.acquire('a', { id: 'old' }, { ...box, width: 410 });
  assert.equal((await larger.ready).width, 896); assert.equal(calls.resizes, 2);
  larger.release(); cache.clear();
});
test('LRU accounts for decoded pixels and never revokes resources held by visible cards', async () => {
  const { cache, calls } = harness({ budget: 4 * 896 * 672 + 100 });
  const a = cache.acquire('a', { id: 'a' }, box); await a.ready;
  const b = cache.acquire('a', { id: 'b' }, box); await b.ready;
  assert.equal(calls.revoked.length, 0);
  a.release(); assert.equal(calls.revoked.length, 1); assert.ok(cache.bytes <= cache.budget);
  assert.equal(b.url, undefined); assert.ok((await b.ready).url);
  b.release(); cache.clear(); assert.equal(cache.bytes, 0);
});
test('account clearing during a decode releases the late resource instead of publishing it', async () => {
  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  const { cache, calls } = harness({ decode: async blob => { started(); await new Promise(resolve => { finish = resolve; }); return { url: 'blob:late', image: {}, width: blob.width, height: blob.height }; } });
  const lease = cache.acquire('a', { id: 'a' }, box); await begun;
  cache.clear(); finish(); assert.equal(await lease.ready, null);
  assert.deepEqual(calls.revoked, ['blob:late']); assert.equal(cache.bytes, 0); lease.release();
});
test('an original becoming cached upgrades a previously displayed server preview', async () => {
  let original = null;
  const { cache } = harness({ readThumbnail: async () => ({ blob: bytes(320, 240) }), readOriginal: async () => original });
  const before = cache.acquire('a', { id: 'a' }, box); assert.equal((await before.ready).width, 320);
  original = bytes(); cache.invalidatePreview('a', 'a');
  const after = cache.acquire('a', { id: 'a' }, box); assert.equal((await after.ready).width, 640);
  assert.notEqual((await before.ready).url, (await after.ready).url);
  before.release(); after.release(); cache.clear();
});
test('cover and contain sizing preserve source detail without inventing pixels', () => {
  assert.deepEqual(rasterSize(1600, 900, { width: 160, height: 96, dpr: 2, cover: true }), { width: 384, height: 216 });
  assert.deepEqual(rasterSize(320, 240, box), { width: 320, height: 240 });
});
test('queued visible work overtakes overscan and obsolete tasks are discarded', async () => {
  const queue = new PriorityQueue(1), order = []; let release;
  const held = queue.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const old = queue.run(() => order.push('obsolete'), () => false);
  const far = queue.run(() => order.push('overscan'), () => true, () => 100);
  const visible = queue.run(() => order.push('visible'), () => true, () => 0);
  release(); await Promise.all([held, old, far, visible]); assert.deepEqual(order, ['visible', 'overscan']);
});
