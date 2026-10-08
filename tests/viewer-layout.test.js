import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerTopLayout } from '../extension/viewer-layout.js';

test('menus reserve at most 240 pixels and one third of space below the toolbar', () => {
  for (const height of [180, 360, 640, 720, 1200]) {
    for (const railHeight of [48, 84]) {
      const result = viewerTopLayout({ height, railHeight, panelHeight: 900 });
      assert.ok(result.panelHeight <= 240);
      assert.ok(result.panelHeight <= (height - railHeight) / 3);
      assert.ok(result.imageHeight >= 80);
      assert.equal(result.panelHeight + result.imageHeight + railHeight, height);
    }
  }
});
test('closing a menu restores image space and oversized toolbars never create negative dimensions', () => {
  assert.deepEqual(viewerTopLayout({ height: 720 }), { panelHeight: 0, imageHeight: 672 });
  assert.deepEqual(viewerTopLayout({ height: 20, railHeight: 48, panelHeight: 200 }), { panelHeight: 0, imageHeight: 0 });
});
