(() => {
  if (globalThis.ImageLibrarySource) return;
  const adapter = globalThis.ImageLibraryAdapter;
  const originalFetch = window.fetch.bind(window);
  function failure(message, code = 'NETWORK') { return Object.assign(new Error(message), { code }); }
  async function session(signal) {
    const response = await originalFetch('/api/auth/session', { credentials: 'include', cache: 'no-store', signal });
    if (!response.ok) throw failure('无法确认 ChatGPT 登录状态，请打开 ChatGPT 后重试。', 'AUTH');
    const value = await response.json();
    if (!value.user?.id || !value.accessToken) throw failure('请在当前浏览器登录 ChatGPT。', 'AUTH');
    let accountId = value.account?.id || '';
    if (!accountId) {
      try {
        const tokenPart = value.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        accountId = JSON.parse(atob(tokenPart))['https://api.openai.com/auth']?.chatgpt_account_id || '';
      } catch { /* The user identity still isolates different logins. */ }
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${value.user.id}:${accountId}`));
    const id = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { id, name: value.user.name || 'ChatGPT', token: value.accessToken, accountId };
  }
  async function api(path, auth, signal, options = {}) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/backend-api/')) throw failure('无效的数据地址', 'DATA');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${auth.token}` };
    if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await originalFetch(url, { headers, credentials: 'include', cache: 'no-store', signal,
      method: options.method || 'GET', body: options.body && JSON.stringify(options.body) });
    if (response.status === 401 || response.status === 403) throw failure('ChatGPT 登录已失效或需要重新打开页面验证。', 'AUTH');
    if (response.status === 429) throw failure('ChatGPT 请求较多，稍后会自动重试。', 'RATE_LIMIT');
    if (response.status === 404) throw failure('原聊天不存在或无法访问。', 'NOT_FOUND');
    if (response.status === 400 && url.pathname.endsWith('/my/recent/image_gen')) throw failure('图片库分页已失效，稍后将从最新图片重新连接。', 'CURSOR');
    if (!response.ok) throw failure(`ChatGPT 暂时无法返回图片（${response.status}）。`);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw failure('ChatGPT 返回了无法识别的数据，请打开官方图片库后重试。', 'DATA'); }
  }
  function checkedChat(value, id, checkedAt) {
    if (!value || value.id !== id || typeof value.is_archived !== 'boolean') throw failure('未能确认聊天归档状态。', 'DATA');
    return { id, archived: value.is_archived, checkedAt };
  }
  async function chatStates(ids, auth, signal) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)))
      throw failure('无效的聊天请求', 'DATA');
    const checkedAt = Date.now();
    const rows = await api('/backend-api/conversations/batch', auth, signal, { method: 'POST', body: { conversation_ids: [...new Set(ids)] } });
    if (!Array.isArray(rows)) throw failure('聊天状态接口已变化。', 'DATA');
    return rows.filter(row => ids.includes(row.id)).map(row => checkedChat(row, row.id, checkedAt));
  }
  async function imageBlob(args, auth, signal) {
    let url = adapter.imageURL(args.kind === 'thumbnail' ? args.image.thumbnailUrl || args.image.sourceUrl : args.image.sourceUrl);
    if ((args.kind !== 'thumbnail' || !url) && args.image.fileId) {
      const fileId = encodeURIComponent(args.image.fileId);
      const conversationId = encodeURIComponent(args.image.conversationId || '');
      const paths = [`/backend-api/files/download/${fileId}?conversation_id=${conversationId}&inline=false`,
        `/backend-api/files/${fileId}/download`];
      if (conversationId) paths.push(`/backend-api/conversation/${conversationId}/attachment/${fileId}/download`);
      for (const path of paths) {
        try {
          const result = await api(path, auth, signal);
          const resolved = adapter.imageURL(result.download_url || result.url);
          if (resolved) { url = resolved; break; }
        } catch (error) {
          if (['AUTH', 'RATE_LIMIT'].includes(error.code) || signal.aborted) throw error;
        }
      }
    }
    if (!url) throw failure('没有取得这张图片的地址，请刷新图片库后重试。', 'ASSET');
    const response = await originalFetch(url, { credentials: new URL(url).origin === location.origin ? 'include' : 'omit', signal });
    if (!response.ok) throw failure('图片地址已过期或图片暂时不可用，请刷新后重试。', 'ASSET');
    let blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw failure('返回的内容不是图片，请重新连接 ChatGPT。', 'ASSET');
    if (args.kind === 'thumbnail') {
      const objectURL = URL.createObjectURL(blob);
      try {
        const image = new Image(); image.src = objectURL; await image.decode();
        const ratio = Math.min(1, 1536 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const context = canvas.getContext('2d'); context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = false;
        for (let alpha = 3; alpha < rgba.length; alpha += 4) if (rgba[alpha] !== 255) { transparent = true; break; }
        blob = await new Promise(resolve => canvas.toBlob(value => resolve(value || blob), transparent ? 'image/png' : 'image/jpeg', .97));
      } finally { URL.revokeObjectURL(objectURL); }
    }
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(failure('图片读取失败', 'ASSET'));
      reader.readAsDataURL(blob);
    });
    return { dataURL: base64 };
  }
  async function execute(command, args, signal) {
    const auth = await session(signal);
    if (command === 'identity') return { id: auth.id, name: auth.name };
    if (args.account && args.account !== auth.id) throw failure('ChatGPT 账号已切换，请刷新图片库。', 'ACCOUNT_CHANGED');
    if (command === 'page') {
      return adapter.libraryPage(await api(adapter.libraryURL(args.cursor), auth, signal));
    }
    if (command === 'conversation') {
      const value = await api(`/backend-api/conversation/${encodeURIComponent(args.conversation.id)}`, auth, signal);
      return { images: adapter.conversationImages(value, { conversationId: args.conversation.id, ...args.conversation }) };
    }
    if (command === 'prompt') {
      const id = args.image?.conversationId;
      if (!id || !/^[\w-]+$/.test(id)) throw failure('该图片没有原聊天信息。', 'DATA');
      const value = await api(`/backend-api/conversation/${encodeURIComponent(id)}`, auth, signal);
      return adapter.imagePrompt(value, args.image);
    }
    if (command === 'chat-status') return chatStates(args.ids, auth, signal);
    if (command === 'archive-chat') {
      const [before] = await chatStates([args.id], auth, signal);
      if (!before) throw failure('原聊天不存在或无法访问。', 'NOT_FOUND');
      if (before.archived) return { state: before, skipped: true };
      await api('/backend-api/conversation/' + encodeURIComponent(args.id), auth, signal, { method: 'PATCH', body: { is_archived: true } });
      const [after] = await chatStates([args.id], auth, signal);
      if (!after?.archived) throw failure('归档请求已发出，但未能确认结果；重试前会重新核验。', 'UNCERTAIN');
      return { state: after, skipped: false };
    }
    if (command === 'asset') return imageBlob(args, auth, signal);
    throw failure('不支持的请求', 'DATA');
  }
  globalThis.ImageLibrarySource = { async request(command, args = {}) {
    if (!['identity', 'page', 'conversation', 'asset', 'prompt', 'chat-status', 'archive-chat'].includes(command)) return { ok: false, error: '不支持的请求' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try { response = { ok: true, result: await execute(command, args, controller.signal) }; }
    catch (error) { response = { ok: false, error: error.name === 'AbortError' ? 'ChatGPT 请求超时，稍后可重试。' : error.message, code: error.code || 'NETWORK' }; }
    finally { clearTimeout(timeout); }
    return response;
  } };
})();
