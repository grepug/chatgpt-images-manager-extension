export const NATIVE_APP = 'local.chatgpt.ChatGPT-Images-Manager';
let broker = false, pending = Promise.resolve();
export function installNativeBroker() {
  broker = true;
  const extension = globalThis.browser || globalThis.chrome;
  extension.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'native-storage-request') return false;
    if (sender.id !== extension.runtime.id || !sender.url?.startsWith(extension.runtime.getURL(''))) {
      reply({ ok: false, error: '无效的原生存储请求。' }); return false;
    }
    nativeRequest(message.request?.op, message.request).then(result => reply({ ok: true, result }),
      error => reply({ ok: false, error: error.message, code: error.code }));
    return true;
  });
}
export async function nativeRequest(op, args = {}) {
  const extension = globalThis.browser || globalThis.chrome;
  if (!extension?.runtime?.sendNativeMessage) throw new Error('当前环境没有原生存储连接。');
  // IndexedDB preserves undefined object fields; Safari native messaging accepts
  // JSON values only. Normalize before crossing the native boundary.
  const message = JSON.parse(JSON.stringify({ op, ...args }));
  let response;
  if (!broker && globalThis.location?.protocol === 'safari-web-extension:' && extension.runtime.sendMessage) {
    response = await extension.runtime.sendMessage({ type: 'native-storage-request', request: message });
  } else {
    // Safari can interrupt overlapping native requests. Share one ordered
    // connection across library pages and the background, including retries.
    const task = pending.then(() => sendNative(extension, message));
    pending = task.catch(() => {}); response = await task;
  }
  if (!response?.ok) throw Object.assign(new Error(response?.error || '无法连接 App 持久存储。'), { code: response?.code || 'NATIVE_STORAGE' });
  return response.result;
}
async function sendNative(extension, message) {
  const retryable = new Set(['ping', 'get', 'list', 'summary', 'verify-page', 'migration-receipt-page', 'thumbnail-info', 'thumbnail-read', 'asset-info', 'asset-read', 'batch', 'put', 'import-missing', 'update', 'merge', 'reconcile', 'favorite', 'hidden', 'asset-chunk', 'asset-commit', 'asset-abort']);
  for (let attempt = 0;; attempt++) {
    try { return await extension.runtime.sendNativeMessage(NATIVE_APP, message); }
    catch (error) {
      if (attempt >= 4 || !retryable.has(message.op) || !String(error.message).includes('SFErrorDomain error 3')) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, 500 * 2 ** attempt)));
    }
  }
}
export async function nativeVerify({ probe = false, progress = () => {} } = {}) {
  let after = null, verified = 0;
  do {
    const page = await nativeRequest('verify-page', { after, probe });
    if (page.after && page.after === after) throw new Error('原图核对未继续前进。');
    verified += page.verified; after = page.after; progress(verified);
  } while (after);
  return { verified };
}
export async function nativeReceipt() {
  let after = null, receipt;
  do {
    const page = await nativeRequest('migration-receipt-page', { after });
    if (page.after && page.after === after || receipt && receipt.profileHash !== page.profileHash) throw new Error('迁移核对凭据不完整。');
    receipt ||= { schema: page.schema, profileHash: page.profileHash, originals: [] };
    receipt.originals.push(...page.originals); after = page.after;
  } while (after);
  return receipt;
}
export async function nativeRead(key, { probe = false } = {}) {
  const info = await nativeRequest('asset-info', { key, probe });
  if (!info) return null;
  return readChunks(info, 'asset-read', { key, probe });
}
export async function nativeThumbnail(key, box, { probe = false } = {}) {
  const info = await nativeRequest('thumbnail-info', { key, box, probe });
  if (!info) return null;
  return { ...info, blob: await readChunks(info, 'thumbnail-read', { token: info.token, probe }) };
}
async function readChunks(info, op, args) {
  const chunks = [];
  for (let offset = 0; offset < info.size;) {
    const result = await nativeRequest(op, { ...args, offset });
    if (!result?.data || result.offset !== offset || result.size !== info.size) throw new Error('原图读取不完整。');
    const binary = atob(result.data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    chunks.push(bytes); offset += bytes.length;
  }
  const blob = new Blob(chunks, { type: info.mime });
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  if (digest !== info.digest) throw new Error('原图完整性校验失败。');
  return blob;
}
export async function nativeWrite(info, blob, { probe = false } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2,'0')).join('');
  const existing = await nativeRequest('asset-info', { key:info.key, probe });
  if (existing?.size === bytes.length && existing.digest === digest) return existing;
  const { token } = await nativeRequest('asset-begin', { size:bytes.length, probe });
  try {
  for (let offset = 0; offset < bytes.length; offset += 262144) {
    const chunk = bytes.subarray(offset, offset + 262144); let binary = '';
    for (let start = 0; start < chunk.length; start += 32768) binary += String.fromCharCode(...chunk.subarray(start,start + 32768));
    await nativeRequest('asset-chunk', { token, offset, data:btoa(binary), probe });
  }
  return await nativeRequest('asset-commit', { token, info:{ ...info, size:bytes.length, mime:blob.type }, digest, probe });
  } catch (error) {
    try { await nativeRequest('asset-abort', { token, probe }); } catch { /* Retry can recover after the helper reconnects. */ }
    throw error;
  }
}
