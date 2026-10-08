import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheDisplay } from '../extension/cache-display.js';
test('active original and thumbnail downloads are explicit and show pending counts', () => {
  const usage = { completed: 25, total: 100, running: true, activeAsset: { kind: 'original' } };
  assert.match(cacheDisplay(usage).text, /正在缓存原图.*已缓存 25 \/ 总计 100.*含隐藏/);
  assert.equal(cacheDisplay(usage).percent, 25);
  assert.match(cacheDisplay({ ...usage, activeAsset: { kind: 'thumbnail' } }).text, /正在缓存缩略图/);
});
test('demand mode does not describe unseen pictures as pending downloads', () => {
  const display = cacheDisplay({ cacheMode:'demand', total:100, completed:2 });
  assert.match(display.text,/按需缓存/); assert.doesNotMatch(display.text,/待缓存/);
  assert.doesNotMatch(cacheDisplay({ total:10, completed:10, failed:1 }).text,/缓存已完成/);
});
test('an unfinished scan never claims 100 percent or complete even when known images are cached', () => {
  const state = cacheDisplay({ completed: 100, total: 100, scanning: true });
  assert.equal(state.percent, null); assert.match(state.text, /总数仍在增加/); assert.doesNotMatch(state.text, /缓存已完成/);
});
test('paused downloads retain progress and failed downloads are distinguishable', () => {
  const state = cacheDisplay({ phase: 'paused', completed: 50, total: 100, failed: 2 });
  assert.equal(state.percent, 50); assert.match(state.text, /缓存已暂停.*2 项失败/);
  assert.match(cacheDisplay({ completed: 50, total: 100, failed: 2 }).text, /等待重试/);
});
test('completion requires a known finished scan, and empty libraries do not claim completion', () => {
  assert.match(cacheDisplay({ total: 10, completed: 10 }).text, /缓存已完成/);
  assert.equal(cacheDisplay({ total: 10, completed: 10 }).percent, 100);
  assert.match(cacheDisplay({ total: 0, completed: 0 }).text, /等待图片/);
});
test('a saved scan in an inactive background is not reported as actively downloading', () => {
  const state = cacheDisplay({ total: 100, completed: 50, scanning: true, running: false });
  assert.match(state.text, /等待后台恢复/); assert.equal(state.percent, null);
  assert.doesNotMatch(state.text, /正在缓存|正在查找/);
});
