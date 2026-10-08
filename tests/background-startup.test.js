import test from 'node:test';
import assert from 'node:assert/strict';

test('background starts and the toolbar opens or focuses the library', async () => {
  let toolbar, existing = [], created, activated, focused;
  const url = 'safari-web-extension://test/library.html';
  const event = () => ({ addListener() {} });
  globalThis.browser = {
    runtime: { getURL: () => url, onMessage: event(), onStartup: event(), onInstalled: event() },
    action: { onClicked: { addListener(listener) { toolbar = listener; } } },
    tabs: {
      onRemoved: event(), query: async () => existing,
      create: async input => { created = input; },
      update: async (id, input) => { activated = { id, ...input }; }
    },
    windows: { update: async (id, input) => { focused = { id, ...input }; } },
    alarms: { onAlarm: event(), create: async () => {} }
  };
  await import('../extension/background-worker.js');
  assert.equal(typeof toolbar, 'function');
  await toolbar();
  assert.deepEqual(created, { url });
  existing = [{ id: 7, windowId: 9, url: `${url}?restored=1` }];
  created = null;
  await toolbar();
  assert.equal(created, null);
  assert.deepEqual(activated, { id: 7, active: true });
  assert.deepEqual(focused, { id: 9, focused: true });
});
