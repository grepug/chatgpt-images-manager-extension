import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeImages, visibleImages, adjacentImages, moveSelection, zoomAt, fitScale } from '../extension/core.js';

test('partial refresh never removes old records or clears favorites', () => {
  const old = [{ id: 'old', favorite: true, saved: true, createdAt: 2 }, { id: 'held', createdAt: 1 }];
  const merged = mergeImages(old, [{ id: 'new', createdAt: 3 }, { id: 'old', title: 'Updated' }]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(image => image.id === 'old').favorite, true);
  assert.equal(merged.find(image => image.id === 'old').saved, true);
  assert.equal(merged.find(image => image.id === 'held').deleted, undefined);
});
test('only a complete successful snapshot marks deletions; favorites survive', () => {
  const merged = mergeImages([{ id: 'old', favorite: true, createdAt: 1 }, { id: 'ordinary', createdAt: 2 }], [], true);
  assert.deepEqual(visibleImages(merged, 'all'), []);
  assert.equal(visibleImages(merged, 'favorites')[0].id, 'old');
});
test('asset reappearing clears the deleted flag but preserves collection', () => {
  const merged = mergeImages([{ id: 'one', favorite: true, deleted: true }], [{ id: 'one', title: 'Fresh URL' }], true);
  assert.equal(merged[0].deleted, false); assert.equal(merged[0].favorite, true);
});
test('navigation stops at both ends, and neighbors are limited to two on either side', () => {
  const images = Array.from({ length: 7 }, (_, index) => ({ id: String(index), createdAt: 7 - index }));
  assert.equal(moveSelection(images, '0', -1), '0');
  assert.equal(moveSelection(images, '6', 1), '6');
  assert.deepEqual(adjacentImages(images, '3').map(image => image.id), ['1', '2', '4', '5']);
});
test('a held deleted picture can still navigate to a nearby surviving image', () => {
  const images = [{ id: 'new', createdAt: 10 }, { id: 'older', createdAt: 4 }];
  assert.equal(moveSelection(images, 'deleted', 1, 6), 'older');
  assert.equal(moveSelection(images, 'deleted', -1, 6), 'new');
});
test('zoom preserves the exact image coordinate under the pointer', () => {
  const before = { scale: .5, x: 20, y: -30 }, pointer = { x: 100, y: 50 };
  const after = zoomAt(before, 1.5, pointer);
  assert.equal((pointer.x - before.x) / before.scale, (pointer.x - after.x) / after.scale);
  assert.equal((pointer.y - before.y) / before.scale, (pointer.y - after.y) / after.scale);
});
test('fit uses the available canvas with a small margin and allows upscaling', () => {
  assert.equal(fitScale(1200, 900, 1224, 924), 1);
  assert.equal(fitScale(2400, 1800, 1224, 924), .5);
  assert.equal(fitScale(600, 450, 1224, 924), 2);
});
