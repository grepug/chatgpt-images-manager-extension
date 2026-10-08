import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { readFile } from 'node:fs/promises';

test('legacy cleanup rejects wrong profiles and changed bytes, then removes only verified originals', async () => {
  globalThis.indexedDB = indexedDB;
  const request = value => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error);
  });
  const open = indexedDB.open('chatgpt-images-manager');
  open.onupgradeneeded = () => {
    for (const store of ['assets', 'assetInfo', 'images', 'hidden', 'views']) open.result.createObjectStore(store, { keyPath: 'key' });
  };
  const db = await request(open);
  const put = (store, value) => request(db.transaction(store, 'readwrite').objectStore(store).put(value));
  const rows = [];
  for (const id of ['one', 'two']) {
    const key = `account:${id}:original`, bytes = new TextEncoder().encode(id);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    rows.push({ key, digest, size: bytes.byteLength });
    await put('assets', { key, bytes }); await put('assetInfo', { key, kind: 'original' });
  }
  await put('assets', { key: 'account:one:thumbnail', bytes: new Uint8Array([1]) });
  await put('assetInfo', { key: 'account:one:thumbnail', kind: 'thumbnail' });
  await put('images', { key: 'account:one', favorite: true });
  await put('hidden', { key: 'account', ids: ['two'] });
  await put('views', { key: 'account', scrollTop: 1200 });
  let receipt = { schema: 1, profileHash: 'wrong-profile', originals: rows };
  const elements = new Map();
  for (const id of ['receipt', 'clean', 'result']) elements.set(id, {
    listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; },
    files: [{ text: async () => JSON.stringify(receipt) }], disabled: true, textContent: ''
  });
  globalThis.document = { getElementById: id => elements.get(id) };
  globalThis.browser = { runtime: { sendNativeMessage: async (_app, message) => ({ ok: true, result:
    message.op === 'export-location' ? '/synthetic/export' : message.op === 'export-profile' ? 'synthetic-profile' :
      message.op === 'get' ? { phase: 'verified' } : { verified: 2, after: null }
  }) } };
  // The Safari build places this file beside native-storage.js. Resolve that
  // one packaging import to the same source when loading the fixture in Node.
  const source = (await readFile(new URL('../native/legacy-cleanup.js', import.meta.url), 'utf8'))
    .replace("'./native-storage.js'", JSON.stringify(new URL('../extension/native-storage.js', import.meta.url).href));
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const input = elements.get('receipt'), button = elements.get('clean'), status = elements.get('result');
  await input.listeners.change(); assert.equal(button.disabled, true);
  assert.match(status.textContent, /另一个 Safari profile/);
  receipt.profileHash = 'synthetic-profile'; receipt.originals[1].digest = 'changed';
  await input.listeners.change(); await button.listeners.click();
  assert.match(status.textContent, /旧数据已变化/);
  assert.equal((await request(db.transaction('assets').objectStore('assets').getAll())).length, 3);
  receipt.originals[1].digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('two')))].map(x => x.toString(16).padStart(2, '0')).join('');
  await input.listeners.change(); await button.listeners.click();
  assert.match(status.textContent, /已清理/);
  assert.equal((await request(db.transaction('assets').objectStore('assets').getAll())).length, 1);
  assert.equal((await request(db.transaction('assetInfo').objectStore('assetInfo').getAll())).length, 1);
  assert.equal((await request(db.transaction('images').objectStore('images').get('account:one'))).favorite, true);
  assert.deepEqual((await request(db.transaction('hidden').objectStore('hidden').get('account'))).ids, ['two']);
  assert.equal((await request(db.transaction('views').objectStore('views').get('account'))).scrollTop, 1200);
  db.close();
});
