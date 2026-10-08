import { nativeRequest, nativeVerify } from './native-storage.js';
const input = document.getElementById('receipt'), button = document.getElementById('clean'), status = document.getElementById('result');
const request = operation => new Promise((resolve,reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
let receipt;
input.addEventListener('change', async () => {
  button.disabled = true;
  try {
    receipt = JSON.parse(await input.files[0].text());
    const location = await nativeRequest('export-location');
    const info = await nativeRequest('get',{store:'migration',key:'legacy-export'});
    if (receipt.schema !== 1 || info?.phase !== 'verified' || !Array.isArray(receipt.originals)) throw new Error('迁移核对凭据无效。');
    // Native profile check prevents a receipt from another Safari profile.
    const proof = await nativeRequest('export-profile');
    if (proof !== receipt.profileHash || !location) throw new Error('凭据属于另一个 Safari profile。');
    button.disabled = false; status.textContent = '已选择新存储核对凭据。点击清理会只移除已匹配的旧原图，导出副本仍保留。';
  } catch (error) { status.textContent = error.message; }
});
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    await nativeVerify();
    const db = await request(indexedDB.open('chatgpt-images-manager'));
    const originals = new Map(receipt.originals.map(info => [info.key,info]));
    const metadata = await request(db.transaction('assetInfo').objectStore('assetInfo').getAll());
    const keys = [];
    for (const info of metadata.filter(info => info.kind === 'original')) {
      const verified = originals.get(info.key);
      if (!verified) throw new Error('新存储核对凭据缺少旧原图，未清理。');
      const value = await request(db.transaction('assets').objectStore('assets').get(info.key));
      const bytes = value?.bytes || await value?.blob?.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if (digest !== verified.digest || bytes.byteLength !== verified.size) throw new Error('旧数据已变化，未清理。请重新导出与导入。');
      keys.push(info.key);
    }
    const tx = db.transaction(['assets','assetInfo'],'readwrite');
    const done = new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);});
    for (const key of keys) { tx.objectStore('assets').delete(key); tx.objectStore('assetInfo').delete(key); }
    await done; db.close(); status.textContent = '已清理核对过的旧原图副本。新存储和导出目录仍保留。';
  } catch (error) { status.textContent = error.message; button.disabled = false; }
});
