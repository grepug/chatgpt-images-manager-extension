import test from 'node:test';
import assert from 'node:assert/strict';
import { OriginalCache } from '../extension/original-cache.js';

const blob = () => Object.assign(new Blob([new Uint8Array(100)]), { width: 10, height: 10 });
function harness(options = {}) {
  const calls = { reads: [], downloads: 0, decodes: 0, revoked: [] };
  const cache = new OriginalCache({
    read: async (account, id) => { calls.reads.push(`${account}:${id}`); return blob(); },
    download: async () => { calls.downloads++; return blob(); },
    decode: async value => ({ url: `blob:original-${++calls.decodes}`, image: {}, width: value.width, height: value.height }),
    revoke: url => calls.revoked.push(url), ...options
  });
  return { cache, calls };
}
test('repeat visits reuse the same decoded image synchronously with zero reads or decodes', async () => {
  const { cache, calls } = harness();
  const first = cache.acquire('account', { id: 'image' }); const resource = await first.ready;
  for (let i = 0; i < 10; i++) {
    const visit = cache.acquire('account', { id: 'image' });
    assert.equal(visit.resource.image, resource.image); assert.equal(visit.resource.url, resource.url); visit.release();
  }
  assert.equal(calls.reads.length, 1); assert.equal(calls.decodes, 1); assert.equal(calls.downloads, 0);
  first.release(); cache.clear(); assert.equal(cache.bytes, 0);
});
test('over budget, old decoded pixels go first and verified files avoid another disk read', async () => {
  const { cache, calls } = harness({ budget: 650 });
  const a = cache.acquire('account', { id: 'a' }); await a.ready; a.release();
  const b = cache.acquire('account', { id: 'b' }); await b.ready;
  assert.equal(calls.revoked.length, 1); assert.equal(cache.bytes, 600);
  const again = cache.acquire('account', { id: 'a' }); assert.equal(again.resource, null); await again.ready;
  assert.deepEqual(calls.reads, ['account:a', 'account:b']); assert.equal(calls.decodes, 3);
  b.release(); again.release(); assert.ok(cache.bytes <= cache.budget); cache.clear();
});
test('a protected huge current picture survives while unprotected files are reclaimed', async () => {
  const { cache, calls } = harness({ budget: 50 });
  const a = cache.acquire('account', { id: 'a' }); const resource = await a.ready;
  const b = cache.acquire('account', { id: 'b' }); await b.ready; b.release();
  assert.equal(a.resource, null); assert.equal((await a.ready).url, resource.url);
  assert.ok(!calls.revoked.includes(resource.url)); assert.equal(cache.entries.size, 1);
  a.release(); assert.equal(cache.bytes, 0); cache.clear();
});
test('preloads never download missing originals and foreground can promote a pending preload', async () => {
  let finish;
  const { cache, calls } = harness({ read: () => new Promise(resolve => { finish = resolve; }) });
  const preload = cache.acquire('account', { id: 'a' }, { localOnly: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  const current = cache.acquire('account', { id: 'a' }); finish(null);
  assert.equal((await preload.ready).url, (await current.ready).url); assert.equal(calls.downloads, 1);
  current.release(); preload.release(); cache.clear();
  const missing = harness({ read: async () => null });
  assert.equal(await missing.cache.preload('account', { id: 'uncached' }), null);
  assert.equal(missing.calls.downloads, 0); missing.cache.clear();
});
test('a queued neighbor preload cannot block a newly requested original', async () => {
  let finish; const reads = [];
  const { cache } = harness({ read: async (_, id) => { reads.push(id); return id === 'held' ? new Promise(resolve => { finish = resolve; }) : blob(); } });
  const held = cache.preload('account', { id: 'held' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const queued = cache.preload('account', { id: 'next' });
  const next = cache.acquire('account', { id: 'next' }); await next.ready;
  assert.deepEqual(reads, ['held', 'next']); finish(blob()); await Promise.all([held, queued]);
  assert.deepEqual(reads, ['held', 'next']); next.release(); cache.clear();
});
test('account changes release late decoded resources and never return a stale picture', async () => {
  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  const { cache, calls } = harness({ decode: async () => { started(); await new Promise(resolve => { finish = resolve; }); return { url: 'blob:late', image: {}, width: 10, height: 10 }; } });
  const old = cache.acquire('old', { id: 'same' }); await begun; cache.clear(); finish();
  assert.equal(await old.ready, null); assert.deepEqual(calls.revoked, ['blob:late']); assert.equal(cache.bytes, 0); old.release();
  const isolated = harness();
  const a = isolated.cache.acquire('a', { id: 'same' }), b = isolated.cache.acquire('b', { id: 'same' });
  assert.notEqual((await a.ready).url, (await b.ready).url); a.release(); b.release(); isolated.cache.clear();
});
test('failed decoding can retry the verified file without rereading it', async () => {
  let decode = 0;
  const { cache, calls } = harness({ decode: async () => { if (++decode === 1) throw new Error('decode failed'); return { url: 'blob:retry', image: {}, width: 10, height: 10 }; } });
  const first = cache.acquire('account', { id: 'a' }); await assert.rejects(first.ready); first.release();
  const retry = cache.acquire('account', { id: 'a' }); assert.equal((await retry.ready).url, 'blob:retry');
  assert.equal(calls.reads.length, 1); retry.release(); cache.clear();
});
