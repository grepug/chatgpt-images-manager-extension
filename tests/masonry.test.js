import test from 'node:test';
import assert from 'node:assert/strict';
import { masonryLayout, masonryWindow, masonryAnchor, masonryScrollTop } from '../extension/masonry.js';
const images = count => Array.from({ length: count }, (_, i) => ({ id: `image-${i}`, width: 1000, height: [1500, 750, 1000, 2000][i % 4] }));

test('all three sizes preserve image proportions and never overlap within a column', () => {
  const data = images(1000);
  const layouts = ['small', 'medium', 'large'].map(size => masonryLayout(data, 1400, size));
  assert.ok(layouts[0].columns.length > layouts[1].columns.length);
  assert.ok(layouts[1].columns.length > layouts[2].columns.length);
  for (const layout of layouts) for (const column of layout.columns) column.forEach((item, index) => {
    assert.equal(item.height / item.width, data[item.index].height / data[item.index].width);
    if (index) assert.ok(item.y >= column[index - 1].y + column[index - 1].height + layout.gap);
  });
});
test('binary column queries match full intersection checks deep in 30000 images', () => {
  const layout = masonryLayout(images(30000), 1400, 'small');
  for (const top of [0, 10000, layout.height / 2, layout.height - 900]) {
    const visible = masonryWindow(layout, top, 900);
    const expected = layout.items.filter(item => item.y + item.height >= Math.max(0, top - 500) && item.y <= top + 1400);
    assert.deepEqual(visible.map(x => x.id), expected.map(x => x.id));
    assert.ok(visible.length < 100, 'viewport nodes must not scale with history length');
  }
});
test('adding new pictures and changing size restore the same visible image anchor', () => {
  const data = images(1000), old = masonryLayout(data, 1400);
  const top = old.items[500].y + 35, anchor = masonryAnchor(old, top);
  const updated = masonryLayout([{ id: 'new', width: 1000, height: 750 }, ...data], 1400, 'large');
  const restored = masonryScrollTop(updated, anchor);
  assert.equal(restored - updated.byId.get(anchor.id).y, anchor.offset);
  assert.ok(masonryWindow(updated, restored, 900).some(item => item.id === anchor.id));
});
test('missing dimensions can be learned without cropping, and removed anchors have a nearby fallback', () => {
  const data = [{ id: 'unknown' }, { id: 'other', width: 2, height: 1 }];
  const layout = masonryLayout(data, 300, 'medium', new Map([['unknown', 1.8]]));
  assert.equal(layout.items[0].height / layout.items[0].width, 1.8);
  const smaller = masonryLayout(data.slice(1), 300);
  assert.ok(Number.isFinite(masonryScrollTop(smaller, { id: 'unknown', index: 0, offset: 20 })));
  assert.equal(masonryScrollTop(masonryLayout([], 300), null, 0), 0);
});
test('the virtual sidebar has a bounded window and stable fixed card positions', () => {
  const layout = masonryLayout(images(30000), 180, 'medium', new Map(), true);
  assert.equal(layout.columns.length, 1);
  assert.equal(layout.items[1].y - layout.items[0].y, 155);
  assert.ok(masonryWindow(layout, 2000000, 900).length < 20);
});
