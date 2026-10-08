import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { database, getValue, getHiddenIds } from '../extension/db.js';

test('v2 upgrade adds an empty ID store without rewriting existing assets or views', async () => {
  await new Promise((resolve, reject) => {
    const opening = indexedDB.open('chatgpt-images-manager', 2);
    opening.onupgradeneeded = () => {
      for (const name of ['accounts', 'images', 'assets', 'views', 'assetInfo', 'jobs']) opening.result.createObjectStore(name, { keyPath: 'key' });
      opening.transaction.objectStore('assets').put({ key: 'a:i:original', bytes: new Uint8Array([1, 2, 3]).buffer, mime: 'image/png' });
      opening.transaction.objectStore('views').put({ key: 'a', filter: 'favorites', gridState: { scrollTop: 800, anchor: { id: 'i', offset: 4 } } });
    };
    opening.onsuccess = () => { opening.result.close(); resolve(); }; opening.onerror = () => reject(opening.error);
  });
  assert.equal((await database()).version, 4);
  assert.equal((await getHiddenIds('a')).size, 0);
  assert.deepEqual([...new Uint8Array((await getValue('assets', 'a:i:original')).bytes)], [1, 2, 3]);
  assert.equal((await getValue('views', 'a')).gridState.scrollTop, 800);
});
