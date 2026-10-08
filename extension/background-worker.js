import { getValue, putValue, putValues, updateValue, allValues, mergeLibrary, getImages, getAsset, getThumbnailAsset, storeAsset, setFavorite, setHidden, assetMetadata, cacheSummary, migrateStorage, migrationStatus, cleanLegacyStorage } from './db.js';
import { cacheMode, CACHE_MODES } from './cache-policy.js';
import { CacheRunner } from './cache-runner.js';
import { THUMBNAIL_VERSION } from './thumbnail-cache.js';
import { openEditWindow } from './edit-window.js';
import { installNativeBroker } from './native-storage.js';
const extension = globalThis.browser || globalThis.chrome;
installNativeBroker();
let source = null, creatingSource = null, worker = null;
const assetTasks = new Map();
const editJobs = new Map();
const ALARM = 'automatic-image-cache';

function assertLibrarySender(sender) {
  if (sender.id !== extension.runtime.id || !sender.url?.startsWith(extension.runtime.getURL('library.html'))) throw new Error('无效的扩展请求');
}
async function sendSource(tabId, command, args = {}) {
  const result = await extension.tabs.sendMessage(tabId, { type: 'source-request', command, args });
  if (!result?.ok) throw Object.assign(new Error(result?.error || '无法连接 ChatGPT'), { code: result?.code || 'SOURCE' });
  return result.result;
}
async function createSource() {
  if (creatingSource) return creatingSource;
  creatingSource = (async () => {
    const { sourceTabId } = await extension.storage.local.get('sourceTabId');
    let tab;
    if (sourceTabId) try { tab = await extension.tabs.get(sourceTabId); } catch { /* Closed source tab. */ }
    if (tab?.url?.startsWith('https://chatgpt.com/')) await extension.tabs.reload(tab.id);
    else tab = await extension.tabs.create({ url: 'https://chatgpt.com/images', active: false });
    await extension.storage.local.set({ sourceTabId: tab.id });
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await sendSource(tab.id, 'identity'); return tab; } catch (error) {
        if (error.code === 'AUTH') return tab;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    return tab;
  })().finally(() => { creatingSource = null; });
  return creatingSource;
}
async function connection() {
  let tabs = await extension.tabs.query({ url: 'https://chatgpt.com/*' });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  let lastError;
  for (let pass = 0; pass < 2; pass++) {
    for (const tab of tabs) {
      try {
        const identity = await sendSource(tab.id, 'identity');
        source = { tabId: tab.id, account: identity.id };
        await updateValue('accounts', identity.id, { name: identity.name, lastSeen: Date.now() });
        await extension.storage.local.set({ lastAccount: identity.id });
        await updateValue('settings', 'connection', { lastAccount: identity.id });
        return { ...identity, online: true };
      } catch (error) { lastError = error; }
    }
    if (lastError && ['AUTH', 'RATE_LIMIT'].includes(lastError.code)) break;
    if (!pass) tabs = [await createSource()];
  }
  source = null;
  const { lastAccount } = await getValue('settings', 'connection') || await extension.storage.local.get('lastAccount');
  const previous = lastAccount && await getValue('accounts', lastAccount);
  return { id: previous?.key || null, name: previous?.name || 'ChatGPT', online: false,
    error: lastError?.message || '请打开 ChatGPT 并登录。', code: lastError?.code || 'SOURCE' };
}
async function broadcast(event) {
  try { await extension.runtime.sendMessage({ type: 'library-event', ...event }); } catch { /* No open library. */ }
}
async function sourceRequest(account, command, args = {}) {
  if (!source || source.account !== account) {
    const identity = await connection();
    if (!identity.online || identity.id !== account) throw Object.assign(new Error('请连接这个图片库对应的 ChatGPT 账号。'), { code: 'AUTH' });
  }
  try { return await sendSource(source.tabId, command, { ...args, account }); }
  catch (error) { if (error.code === 'SOURCE' || error.code === 'ACCOUNT_CHANGED') source = null; throw error; }
}
async function settings() {
  const config = await getValue('settings', 'cache') || {};
  return { cacheMode: cacheMode(config.cacheMode), paused: Boolean(config.paused) };
}
async function dataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
async function thumbnailBlob(blob) {
  if (!globalThis.OffscreenCanvas || !globalThis.createImageBitmap) return { blob };
  const image = await createImageBitmap(blob);
  try {
    const ratio = Math.min(1, 1536 / Math.max(image.width, image.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * ratio)), Math.max(1, Math.round(image.height * ratio)));
    const context = canvas.getContext('2d'); context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let transparent = false;
    for (let alpha = 3; alpha < rgba.length; alpha += 4) if (rgba[alpha] !== 255) { transparent = true; break; }
    return { blob: await canvas.convertToBlob({ type: transparent ? 'image/png' : 'image/jpeg', quality: .97 }),
      width: canvas.width, height: canvas.height, sourceWidth: image.width, sourceHeight: image.height, thumbnailVersion: THUMBNAIL_VERSION };
  } finally { image.close(); }
}
async function asset(account, id, kind, serialize = true) {
  const key = `${account}:${id}:${kind}`;
  let task = assetTasks.get(key);
  if (!task) {
    task = (async () => {
      let blob = await getAsset(account, id, kind);
      if (!blob && kind === 'thumbnail') {
        const local = await getThumbnailAsset(account, id, { width: 1536, height: 1536, dpr: 1, cover: false });
        blob = local?.blob;
      }
      if (!blob) {
        let details = {};
        const image = await getValue('images', `${account}:${id}`);
        if (!image) throw new Error('图片不存在');
        const original = kind === 'thumbnail' ? await getAsset(account, id, 'original') : null;
        if (original) {
          try { const generated = await thumbnailBlob(original); blob = generated.blob; const { blob: ignored, ...metadata } = generated; details = metadata; }
          catch { blob = original; }
        }
        else {
          const result = await sourceRequest(account, 'asset', { image, kind });
          blob = await (await fetch(result.dataURL)).blob();
        }
        try { await storeAsset(account, id, kind, blob, details); await broadcast({ event: 'asset-cached', account, id, kind }); }
        catch (error) {
          if (error.name === 'QuotaExceededError') throw Object.assign(new Error('本地空间不足，缓存已暂停。'), { name: 'QuotaExceededError', code: 'QUOTA' });
          throw error;
        }
        if (kind === 'original') {
          try {
            const generated = await thumbnailBlob(blob), { blob: thumbnail, ...metadata } = generated;
            await storeAsset(account, id, 'thumbnail', thumbnail, metadata);
          } catch { /* Original is already durable; the thumbnail can be rebuilt by the UI. */ }
        }
      }
      return blob;
    })().finally(() => assetTasks.delete(key));
    assetTasks.set(key, task);
  }
  const blob = await task;
  if (!serialize) return {};
  return { dataURL: await dataURL(blob) };
}
async function progress(account) {
  const config = await settings();
  if (!account) return { ...config, migration: await migrationStatus(), completed: 0, total: 0, retained: 0, cache: 0, favorites: 0, phase: 'idle', failed: 0 };
  const job = await getValue('jobs', account) || {};
  const counts = await cacheSummary(account);
  return { ...config, ...counts, migration: await migrationStatus(), phase: config.paused ? 'paused' : job.phase || 'idle', loaded: job.loaded || 0,
    scanning: Boolean(job.scan) || !job.lastSync, running: worker?.account === account,
    activeAsset: worker?.account === account ? job.activeAsset : null,
    error: job.error || '', failed: Object.keys(job.failures || {}).length, quotaPaused: Boolean(job.quotaPaused) };
}
const runner = new CacheRunner({
  now: () => Date.now(), job: account => getValue('jobs', account), save: job => putValue('jobs', job),
  config: settings,
  demand: async account => (await allValues('demands')).filter(row => row.account === account).sort((a, b) => b.at - a.at).map(row => row.id),
  verify: async account => {
    const identity = await connection();
    if (!identity.online || identity.id !== account) throw Object.assign(new Error(identity.error || 'ChatGPT 账号已切换，原账号缓存已暂停。'), { code: identity.code || 'ACCOUNT_CHANGED' });
  },
  page: (account, scan) => sourceRequest(account, 'page', { cursor: scan.cursor, offset: scan.offset }),
  conversation: async (account, conversation) => (await sourceRequest(account, 'conversation', { conversation })).images,
  merge: mergeLibrary, images: getImages, assets: assetMetadata,
  asset: (account, id, kind) => asset(account, id, kind, false),
  updated: account => broadcast({ event: 'updated', account }),
  progress: account => broadcast({ event: 'cache-progress', account })
});
function wake(account, retry = false) {
  if (!account) return;
  if (worker) { if (retry || worker.account !== account) worker.followUp = { account, retry }; return; }
  const record = { account, retry }; worker = record;
  runner.run(account, { retry }).then(result => {
    record.pending = result.pending;
  }).catch(error => broadcast({ event: 'sync-error', account, error: error.message })).finally(() => {
    worker = null;
    if (record.followUp) setTimeout(() => wake(record.followUp.account, record.followUp.retry), 100);
    else if (record.pending) setTimeout(() => wake(account), 100);
  });
}
async function resume() {
  await migrateStorage();
  const { lastAccount } = await getValue('settings', 'connection') || await extension.storage.local.get('lastAccount');
  wake(lastAccount);
}
async function ensureAlarm() {
  if (extension.alarms) await extension.alarms.create(ALARM, { periodInMinutes: 1 });
}
async function handle(message, sender) {
  assertLibrarySender(sender);
  if (message.type === 'retry-migration') return migrateStorage();
  if (message.type === 'clean-legacy') return cleanLegacyStorage();
  if (message.type === 'cache-status') return progress(message.account);
  await migrateStorage();
  if (message.type === 'connect') return connection();
  if (message.type === 'sync') {
    // Refresh the newest page immediately; the durable scan fills older history.
    const page = await sourceRequest(message.account, 'page', { cursor: null, offset: 0 });
    const images = [...page.images];
    for (const conversation of page.conversations || []) images.push(...(await sourceRequest(message.account, 'conversation', { conversation })).images);
    if (page.itemCount && !images.length && !page.skippedCount) throw new Error('图片库的数据结构无法识别，已保留原有图片。');
    await mergeLibrary(message.account, images, false);
    await broadcast({ event: 'updated', account: message.account });
    await ensureAlarm(); wake(message.account);
    return { complete: false, loaded: images.length };
  }
  if (message.type === 'asset') return asset(message.account, message.id, message.kind === 'thumbnail' ? 'thumbnail' : 'original');
  if (message.type === 'hidden') {
    const result = await setHidden(message.account, message.id, message.hidden === true);
    await broadcast({ event: 'hidden-updated', account: message.account, id: message.id });
    return result;
  }
  if (message.type === 'prompt') {
    const image = (await getImages(message.account)).find(image => image.id === message.id);
    if (!image?.conversationId) throw new Error('该图片没有原聊天信息。');
    return sourceRequest(message.account, 'prompt', { image });
  }
  if (message.type === 'describe-edit') {
    if (typeof message.prompt !== 'string' || !message.prompt.trim() || !message.jobId) throw new Error('请输入 Describe edits。');
    const key = `${message.account}:${message.jobId}`;
    if (editJobs.has(key)) return editJobs.get(key);
    const task = (async () => {
      const image = (await getImages(message.account)).find(image => image.id === message.id);
      if (!image?.conversationId || !image?.fileId || image.deleted) throw new Error('原图已不可用，无法提交 Describe edits。');
      return openEditWindow(extension, { account: message.account, image: { fileId: image.fileId, conversationId: image.conversationId, messageId: image.messageId },
        prompt: message.prompt, jobId: message.jobId, dryRun: message.dryRun === true });
    })();
    editJobs.set(key, task);
    if (editJobs.size > 100) editJobs.delete(editJobs.keys().next().value);
    return task;
  }
  if (message.type === 'view-hold') return {};
  if (message.type === 'demand-cache') {
    const ids = Array.isArray(message.ids) ? message.ids.filter(id => typeof id === 'string').slice(0, 100) : [];
    const at = Date.now();
    await putValues('demands', ids.map(id => ({ key: `${message.account}:${id}`, account: message.account, id, at })));
    wake(message.account); return {};
  }
  if (message.type === 'settings') return settings();
  if (message.type === 'set-settings') {
    if (!CACHE_MODES.includes(message.cacheMode)) throw new Error('无效的缓存模式');
    await updateValue('settings', 'cache', { cacheMode: message.cacheMode });
    wake(message.account);
    await broadcast({ event: 'updated', account: message.account });
    return progress(message.account);
  }
  if (message.type === 'retry-cache') { wake(message.account, true); return {}; }
  if (message.type === 'pause-cache' || message.type === 'resume-cache') {
    await updateValue('settings', 'cache', { paused: message.type === 'pause-cache' });
    if (message.type === 'resume-cache') wake(message.account, true);
    await broadcast({ event: 'cache-progress', account: message.account }); return progress(message.account);
  }
  if (message.type === 'favorite') {
    const image = await setFavorite(message.account, message.id, message.favorite === true);
    await broadcast({ event: 'updated', account: message.account });
    if (image.favorite) asset(message.account, image.id, 'original', false).then(() => broadcast({ event: 'updated', account: message.account }))
      .catch(error => broadcast({ event: 'favorite-error', account: message.account, id: image.id, error: error.message }));
    wake(message.account);
    return image;
  }
  if (message.type === 'retry-favorites') { wake(message.account); return {}; }
  throw new Error('不支持的操作');
}
extension.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'library-event' || message?.type === 'native-storage-request') return false;
  handle(message, sender).then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error.message, code: error.code }));
  return true;
});
extension.action.onClicked.addListener(async () => {
  const url = extension.runtime.getURL('library.html');
  const existing = (await extension.tabs.query({})).find(tab => tab.url?.split('?')[0] === url);
  if (existing) { await extension.tabs.update(existing.id, { active: true }); await extension.windows.update(existing.windowId, { focused: true }); }
  else await extension.tabs.create({ url });
});
extension.tabs.onRemoved.addListener(tabId => { if (source?.tabId === tabId) source = null; });
extension.alarms?.onAlarm.addListener(alarm => { if (alarm.name === ALARM) resume().catch(() => {}); });
extension.runtime.onStartup.addListener(() => { ensureAlarm().then(resume).catch(() => {}); });
extension.runtime.onInstalled.addListener(() => { ensureAlarm().then(resume).catch(() => {}); });
ensureAlarm().catch(() => {});
