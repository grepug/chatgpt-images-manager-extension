import test from 'node:test';
import assert from 'node:assert/strict';
import { menuStackLayout } from '../extension/viewer-layout.js';

const input = { surface: { left: 0, right: 390, width: 390 }, trigger: { right: 379, bottom: 43 }, windowHeight: 720,
  heights: [282,105,900], widths: [232,232,300] };
test('vertical submenu placement preserves ancestor geometry when space is sufficient', () => {
  const positions = menuStackLayout(input);
  assert.deepEqual(positions[0], { x: 147, y: 49, width: 232, height: 282 });
  assert.equal(positions[1].y, 337);
  assert.equal(positions[1].height, 105);
  assert.equal(positions[2].y, 448);
  assert.equal(positions[2].y + positions[2].height, 712);
});
test('short and narrow windows keep every ancestor within bounds with separate scroll space', () => {
  for (const width of [166,320,390]) for (const height of [80,180,360,500,720]) {
    const positions = menuStackLayout({ ...input, surface: { left:180,right:180+width,width },
      trigger:{ right:180+width-12,bottom:43 }, windowHeight:height });
    for (const [index,p] of positions.entries()) {
      assert.ok(p.x >= 180 && p.x + p.width <= 180 + width);
      assert.ok(p.height >= 0 && p.y + p.height <= height - 8 + .001);
      if (index) assert.ok(p.y >= positions[index-1].y + positions[index-1].height);
    }
  }
});
test('empty submenu chains need no layout', () => assert.deepEqual(menuStackLayout({ ...input,heights:[] }), []));
