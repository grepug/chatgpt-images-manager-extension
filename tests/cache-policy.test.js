import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheCutoff, cacheTargets, evictionPlan, cacheProgress, pendingAssets } from '../extension/cache-policy.js';
const now = Date.UTC(2026, 9, 7, 12);
const image = (id, createdAt, favorite = false) => ({ account: 'a', id, createdAt, favorite });
const asset = (id, kind = 'original') => ({ account: 'a', id, kind, key: `a:${id}:${kind}`, size: 2 * 1024 ** 3 });
test('month ranges use calendar months and clamp the last day', () => {
  assert.equal(cacheCutoff('1week', now), now - 7 * 86400000);
  assert.equal(cacheCutoff('6months', now), Date.UTC(2026, 3, 7, 12));
  assert.equal(cacheCutoff('1month', Date.UTC(2026, 2, 31, 12)), Date.UTC(2026, 1, 28, 12));
});
test('cache range includes its boundary and favorites outside it', () => {
  const cutoff = cacheCutoff('1week', now);
  const images = [image('boundary', cutoff), image('old', cutoff - 1), image('favorite', 1, true), { ...image('deleted', now), deleted: true }];
  assert.deepEqual(cacheTargets(images, '1week', now).map(x => x.id), ['boundary', 'favorite']);
});
test('cleanup is based on age, has no size cap, and protects held pictures and favorites', () => {
  const images = [image('recent', now), image('old', 1), image('held', 1), image('favorite', 1, true)];
  assert.deepEqual(evictionPlan(images.map(x => asset(x.id)), images, '6months', new Set(['a:held:original']), now), ['a:old:original']);
});
test('changing range preserves metadata and ignores downloaded pictures when resuming', () => {
  const images = [image('recent', now), image('month', now - 14 * 86400000), image('favorite', 1, true)];
  const assets = [asset('recent'), asset('recent', 'thumbnail'), asset('favorite')];
  assert.deepEqual(cacheProgress(images, assets, '1week', now), { total: 2, completed: 2 });
  assert.deepEqual(pendingAssets(images, assets, '1month', {}, now).map(x => `${x.id}:${x.kind}`), ['month:original', 'month:thumbnail']);
  assert.equal(images.length, 3);
});
test('failures back off without blocking other images', () => {
  const images = [image('one', now), image('two', now - 1)];
  const pending = pendingAssets(images, [], '6months', { 'a:one:original': { retryAt: now + 60000 } }, now);
  assert.equal(pending.some(x => x.key === 'a:one:original'), false);
  assert.equal(pending.some(x => x.key === 'a:two:original'), true);
});
