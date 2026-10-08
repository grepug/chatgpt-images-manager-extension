import test from 'node:test';
import assert from 'node:assert/strict';

let listener, active = 0, peak = 0;
globalThis.browser = { runtime: {
  id: 'test-extension', getURL: path => `safari-web-extension://test/${path}`,
  onMessage: { addListener(value) { listener = value; } },
  sendNativeMessage: async (_app, message) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    return { ok: true, result: message.key };
  }
} };
const { installNativeBroker, nativeRequest } = await import('../extension/native-storage.js');
installNativeBroker();
test('concurrent pages and background reads share one ordered native connection', async () => {
  const page = key => new Promise(resolve => {
    assert.equal(listener({ type: 'native-storage-request', request: { op: 'get', key } },
      { id: 'test-extension', url: 'safari-web-extension://test/library.html' }, resolve), true);
  });
  const results = await Promise.all([page('page-a'), nativeRequest('get', { key: 'background' }), page('page-b')]);
  assert.deepEqual(results, [{ ok: true, result: 'page-a' }, 'background', { ok: true, result: 'page-b' }]);
  assert.equal(peak, 1);
});
test('website content cannot access the native storage broker', () => {
  let response;
  assert.equal(listener({ type: 'native-storage-request', request: { op: 'get' } },
    { id: 'test-extension', url: 'https://chatgpt.com/images' }, value => { response = value; }), false);
  assert.equal(response.ok, false);
});
test('an interrupted library merge retries before newer state, but allocation is never repeated', async () => {
  const original = browser.runtime.sendNativeMessage, calls = [];
  let attempts = 0;
  browser.runtime.sendNativeMessage = async (_app, message) => {
    calls.push(message.op);
    if (message.op === 'asset-begin' || message.op === 'merge' && ++attempts === 1) {
      throw Error('SFErrorDomain error 3');
    }
    return { ok: true, result: true };
  };
  try {
    assert.deepEqual(await Promise.all([nativeRequest('merge'), nativeRequest('favorite')]), [true, true]);
    assert.deepEqual(calls, ['merge', 'merge', 'favorite']);
    await assert.rejects(nativeRequest('asset-begin'), /SFErrorDomain error 3/);
    assert.equal(calls.filter(op => op === 'asset-begin').length, 1);
  } finally { browser.runtime.sendNativeMessage = original; }
});
