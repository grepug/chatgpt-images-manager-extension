import { nativeRequest, nativeWrite, nativeVerify } from './native-storage.js';
const request = operation => new Promise((resolve,reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
const button = document.getElementById('export'), status = document.getElementById('result');
const copy = async (info,blob) => {
  for (let attempt = 0;; attempt++) {
    try { return await nativeWrite(info,blob); }
    catch (error) {
      if (attempt >= 3 || !String(error.message).includes('SFErrorDomain error 3')) throw error;
      await new Promise(resolve=>setTimeout(resolve,1000 * (attempt + 1)));
    }
  }
};
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const open = indexedDB.open('chatgpt-images-manager');
    open.onupgradeneeded = () => open.transaction.abort();
    const db = await request(open);
    const all = store => db.objectStoreNames.contains(store) ? request(db.transaction(store).objectStore(store).getAll()) : [];
    const images = await all('images');
    if (!images.length) throw new Error('当前身份未找到旧图片索引，未导出；请恢复原安装版本后重试。');
    for (const store of ['accounts','images','views','hidden']) {
      status.textContent = `正在复制旧图片索引和查看设置（${store}）…`;
      const rows = await all(store);
      for (let offset = 0; offset < rows.length; offset += 100) await nativeRequest('batch',{store,rows:rows.slice(offset,offset+100)});
    }
    status.textContent = '正在检查旧原图清单…';
    const assets = (await all('assetInfo')).filter(info => info.kind === 'original');
    let completed = 0;
    await nativeRequest('put',{store:'migration',value:{key:'legacy-export',phase:'copying',total:assets.length,completed}});
    for (const info of assets) {
      status.textContent = `正在复制并核对 ${completed} / ${assets.length} 张`;
      const value = await request(db.transaction('assets').objectStore('assets').get(info.key));
      const blob = value?.bytes ? new Blob([value.bytes],{type:value.mime || info.mime || ''}) : value?.blob;
      if (!blob || blob.size !== info.size) throw new Error('旧原图读取不完整，旧数据仍保留。');
      await copy(info,blob);
      status.textContent = `正在复制并核对 ${++completed} / ${assets.length} 张`;
      await nativeRequest('put',{store:'migration',value:{key:'legacy-export',phase:'copying',total:assets.length,completed}});
    }
    await nativeRequest('put',{store:'migration',value:{key:'legacy-export',phase:'verifying',total:assets.length,completed}});
    await nativeVerify({progress:count=>{status.textContent = `正在核对已复制原图 ${count} / ${assets.length} 张`;}});
    await nativeRequest('put',{store:'migration',value:{key:'legacy-export',phase:'verified',total:assets.length,completed}});
    status.textContent = '导出已核对完成，旧 IndexedDB 仍保留。请从 App 的“存储”菜单打开导出目录，再用公司签名 App 导入。';
    db.close();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
