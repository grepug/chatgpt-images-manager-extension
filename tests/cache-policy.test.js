import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheMode, cacheTargets, evictionPlan, cacheProgress, pendingAssets } from '../extension/cache-policy.js';
const image = (id, extra = {}) => ({ account:'a', id, createdAt:1, ...extra });
const asset = (id, kind = 'original') => ({ key:`a:${id}:${kind}`, account:'a', id, kind });
test('legacy ranges and missing settings upgrade to full caching', () => {
  for (const value of [undefined,'1week','1month','6months']) assert.equal(cacheMode(value),'full');
  assert.equal(cacheMode('demand'),'demand');
});
test('all source dates and hidden pictures count; local-only originals are separate', () => {
  const images = [image('old'),image('hidden',{hidden:true}),image('removed',{deleted:true,localOriginal:true})];
  assert.deepEqual(cacheTargets(images).map(x=>x.id),['hidden','old']);
  assert.deepEqual(cacheProgress(images,[asset('old'),asset('removed'),asset('hidden','thumbnail')]),{total:2,completed:1,retained:1});
  assert.deepEqual(evictionPlan([asset('old'),asset('removed')],images,'demand'),[]);
});
test('demand queues keep requested originals and favorites without downloading unseen cells', () => {
  const images = [image('seen'),image('unseen'),image('favorite',{favorite:true})];
  const pending = pendingAssets(images,[asset('seen','thumbnail')],'demand',{},10,['seen']);
  assert.deepEqual(pending.map(x=>`${x.id}:${x.kind}`),['seen:original','favorite:thumbnail','favorite:original']);
  assert.equal(pendingAssets(images,[],'full').length,6);
});
test('failures back off without blocking the next image', () => {
  const pending = pendingAssets([image('one'),image('two')],[],'full',{'a:one:original':{retryAt:100}},10);
  assert.equal(pending.some(x=>x.key==='a:one:original'),false);
  assert.equal(pending.some(x=>x.key==='a:two:original'),true);
});
test('new visible demands overtake earlier queued images without dropping the old tasks', () => {
  const images = [image('old',{createdAt:100}),image('current',{createdAt:1}),image('unseen')];
  const pending = pendingAssets(images,[],'demand',{},10,['current','old']);
  assert.deepEqual(pending.map(x=>x.id),['current','current','old','old']);
});
