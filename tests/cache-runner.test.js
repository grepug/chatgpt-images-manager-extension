import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheRunner } from '../extension/cache-runner.js';
import { mergeImages } from '../extension/core.js';
import { evictionPlan } from '../extension/cache-policy.js';
function harness(pages, initial = []) {
  let clock = Date.UTC(2026, 9, 7), job, images = initial, mode = 'full', paused = false, demand = [];
  const assets = new Map(), calls = [], merges = [];
  const io = {
    now: () => ++clock, job: async () => structuredClone(job), save: async value => { job = structuredClone(value); },
    verify: async () => {}, config: async () => ({ cacheMode: mode, paused }), demand: async () => demand,
    page: async (_, scan) => { calls.push(scan.cursor); return pages[scan.cursor || 'head']; },
    conversation: async () => [], merge: async (_, incoming, complete) => { merges.push(complete); images = mergeImages(images, incoming.map(x => ({ ...x, account: 'a' })), complete); },
    images: async () => images, assets: async () => [...assets.values()],
    asset: async (_, id, kind) => { assets.set(`a:${id}:${kind}`, { key: `a:${id}:${kind}`, account: 'a', id, kind }); },
    clean: async value => { for (const key of evictionPlan([...assets.values()], images, value, new Set(), clock)) assets.delete(key); },
    updated: async () => {}
  };
  return { io, calls, assets, merges, job: () => job, images: () => images, mode: value => { mode = value; }, pause: value => { paused = value; }, demand: value => { demand = value; }, tick: amount => { clock += amount; } };
}
const recent = id => ({ id, createdAt: Date.UTC(2026, 9, 6) });
const page = (images, cursor = null) => ({ images, conversations: [], cursor, itemCount: images.length, hasMore: null });
test('a new background resumes the saved cursor and only downloads missing bytes', async () => {
  const h = harness({ head: page([recent('new')], 'older'), older: page([recent('older')]) });
  const first = await new CacheRunner(h.io).run('a', { budget: 1 });
  assert.equal(first.pending, true); assert.equal(h.job().scan.cursor, 'older');
  await new CacheRunner(h.io).run('a');
  assert.deepEqual(h.calls, [null, 'older']);
  assert.equal(h.job().scan, null); assert.equal(h.job().completed, 2); assert.equal(h.assets.size, 4);
  let downloads = 0; h.io.asset = async () => { downloads++; };
  await new CacheRunner(h.io).run('a');
  assert.equal(downloads, 0);
});
test('duplicate pages cannot mark old pictures as deleted', async () => {
  const h = harness({ head: page([recent('new')], 'repeat'), repeat: page([recent('new')], 'repeat') }, [{ ...recent('old'), account: 'a' }]);
  await new CacheRunner(h.io).run('a');
  assert.equal(h.job().phase, 'paused');
  assert.match(h.job().error, /重复|分页/);
  assert.equal(h.merges.includes(true), false);
  assert.equal(h.images().find(x => x.id === 'old').deleted, undefined);
});
test('only a successfully completed scan reconciles source deletions', async () => {
  const h = harness({ head: page([recent('new')]) }, [{ ...recent('old'), account: 'a', favorite: true }]);
  await new CacheRunner(h.io).run('a');
  assert.equal(h.images().find(x => x.id === 'old').deleted, true);
  assert.equal(h.images().find(x => x.id === 'old').favorite, true);
});
test('account changes pause before any page or asset request', async () => {
  const h = harness({ head: page([recent('new')]) });
  h.io.verify = async () => { throw Object.assign(new Error('账号已切换'), { code: 'ACCOUNT_CHANGED' }); };
  await new CacheRunner(h.io).run('a');
  assert.equal(h.calls.length, 0); assert.equal(h.assets.size, 0); assert.equal(h.job().phase, 'paused');
});
test('quota exhaustion pauses durably, and explicit retry can resume', async () => {
  const h = harness({ head: page([recent('new')]) });
  const download = h.io.asset;
  h.io.asset = async () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); };
  await new CacheRunner(h.io).run('a');
  assert.equal(h.job().quotaPaused, true);
  h.io.asset = download;
  await new CacheRunner(h.io).run('a'); assert.equal(h.assets.size, 0);
  await new CacheRunner(h.io).run('a', { retry: true });
  assert.equal(h.assets.size, 2); assert.equal(h.job().quotaPaused, false);
});
test('one failed image does not block caching the other images', async () => {
  const h = harness({ head: page([recent('one'), recent('two')]) });
  const download = h.io.asset;
  h.io.asset = async (account, id, kind) => { if (id === 'one') throw new Error('missing'); return download(account, id, kind); };
  await new CacheRunner(h.io).run('a');
  assert.equal(h.assets.has('a:two:original'), true); assert.equal(h.assets.has('a:two:thumbnail'), true);
  assert.equal(Object.keys(h.job().failures).length, 2); assert.equal(h.job().completed, 1);
});
test('mode changes retain all ordinary originals and metadata', async () => {
  const h = harness({ head: page([recent('recent'), { id: 'month', createdAt: Date.UTC(2026, 8, 20) }]) });
  await new CacheRunner(h.io).run('a'); assert.equal(h.assets.size, 4);
  h.mode('demand'); await new CacheRunner(h.io).run('a', { retry: true });
  assert.equal(h.assets.size, 4); assert.equal(h.images().length, 2); assert.equal(h.job().total, 2);
});
test('progress exposes the active asset before download and clears it after completion', async () => {
  const h = harness({ head: page([recent('recent')]) });
  const active = [];
  h.io.progress = async () => { active.push(h.job().activeAsset.kind); };
  await new CacheRunner(h.io).run('a');
  assert.deepEqual(active, ['thumbnail', 'original']);
  assert.equal(h.job().activeAsset, null);
});
test('manual pause and full-to-demand changes stop the next batch item and preserve completed bytes', async () => {
  const h = harness({ head:page([recent('one'),recent('two')]) });
  const download = h.io.asset;
  h.io.asset = async (...args) => { await download(...args); h.pause(true); };
  await new CacheRunner(h.io).run('a');
  assert.equal(h.assets.size,1);
  await new CacheRunner(h.io).run('a',{retry:true}); assert.equal(h.assets.size,1);
  h.pause(false); h.mode('demand'); h.demand(['one']); h.io.asset = download;
  await new CacheRunner(h.io).run('a');
  assert.equal(h.assets.has('a:one:original'),true); assert.equal(h.assets.has('a:two:original'),false);
});
