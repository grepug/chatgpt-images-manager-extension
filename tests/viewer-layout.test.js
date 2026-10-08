import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerDock } from '../extension/viewer-layout.js';

test('dock maximizes fitted image size in wide and tall windows with editing space', () => {
  for (const [width, height] of [[1280, 720], [360, 640], [640, 360]]) {
    for (const [imageWidth, imageHeight] of [[2400, 900], [900, 2400], [1400, 1400]]) {
      const result = viewerDock({ width, height, imageWidth, imageHeight, panelWidth: 300, panelHeight: 138 });
      const bottom = Math.min((width - 24) / imageWidth, (height - 32 - 138 - 24) / imageHeight);
      const side = Math.min((width - 32 - Math.min(300, width - 112) - 24) / imageWidth, (height - 24) / imageHeight);
      assert.ok(result.score >= Math.max(bottom, side) * .99);
      assert.ok(result.imageWidth > 24 && result.imageHeight > 24);
    }
  }
});
test('short and very narrow windows keep usable image area and wrap the rail', () => {
  const narrow = viewerDock({ width: 180, height: 500, imageWidth: 800, imageHeight: 200, panelWidth: 300, panelHeight: 138 });
  assert.equal(narrow.edge, 'bottom'); assert.equal(narrow.railHeight, 64);
  const short = viewerDock({ width: 800, height: 180, imageWidth: 900, imageHeight: 2400, panelWidth: 300, panelHeight: 138 });
  assert.equal(short.edge, 'bottom'); assert.ok(short.imageHeight >= 80);
});
