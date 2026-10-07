// Parse website data in the isolated content script; never use extension APIs here.
(() => {
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value : '';
  function imageURL(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value, 'https://chatgpt.com');
      if (url.protocol !== 'https:') return '';
      return url.hostname === 'chatgpt.com' || url.hostname.endsWith('.oaiusercontent.com') || url.hostname === 'oaiusercontent.com' ? url.href : '';
    } catch { return ''; }
  }
  function timestamp(value) {
    if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
    return Date.parse(value) || 0;
  }
  function assetId(value) {
    const pointer = text(value);
    return pointer.match(/(?:sediment|file-service):\/\/([^/?]+)/)?.[1] || pointer.match(/^(file[-_][\w-]+)$/)?.[1] || '';
  }
  function normalizeRecord(value, context = {}, output = [], depth = 0) {
    if (depth > 12 || !isObject(value)) return output;
    const conversationId = text(value.conversation_id || value.conversationId || context.conversationId);
    const messageId = text(value.message_id || value.messageId || context.messageId);
    const title = text(value.title || value.prompt || context.title) || 'ChatGPT 图片';
    const createdAt = timestamp(value.created_at ?? value.create_time ?? value.created_time ?? value.createdAt ?? context.createdAt);
    const pointer = value.asset_pointer || value.image_asset_pointer;
    const fileId = assetId(pointer) || assetId(value.file_id || value.asset_id);
    const sourceUrl = imageURL(value.download_url || value.image_url || value.url || value.src || value.asset_url);
    const thumbnailUrl = imageURL(value.thumbnail_url || value.thumbnail?.url || value.thumbnail || value.preview_url) || sourceUrl;
    const rawId = text(value.id || value.image_id || value.asset_id);
    if (fileId || sourceUrl) {
      // Signed URLs change; use their asset identity, never their signature.
      let urlId = '';
      if (sourceUrl) {
        const parsed = new URL(sourceUrl);
        urlId = parsed.searchParams.get('id') || `${parsed.hostname}${parsed.pathname}`;
      }
      const id = fileId || rawId || urlId;
      if (id) output.push({ id, fileId: fileId || rawId.match(/^file[-_]/)?.input || '', conversationId, messageId,
        title: title.slice(0, 400), createdAt, sourceUrl, thumbnailUrl,
        width: Number(value.width) || 0, height: Number(value.height) || 0 });
    }
    const next = { conversationId, messageId, title, createdAt };
    for (const key of ['images', 'assets', 'parts', 'content', 'image', 'result', 'message', 'metadata']) {
      const child = value[key];
      if (Array.isArray(child)) for (const item of child) normalizeRecord(item, next, output, depth + 1);
      else if (isObject(child)) normalizeRecord(child, next, output, depth + 1);
    }
    return output;
  }
  function libraryPage(payload) {
    const items = Array.isArray(payload) ? payload : payload?.items ?? payload?.data?.items ?? payload?.results ?? payload?.images;
    if (!Array.isArray(items)) throw new Error('图片库的数据结构已变化，需要更新扩展。');
    const images = new Map();
    const conversations = [];
    let skippedCount = 0;
    for (const item of items) {
      if (item.is_archived) { skippedCount++; continue; }
      const conversationId = text(item.conversation_id || item.conversation?.id || item.id);
      const normalized = normalizeRecord(item, { conversationId });
      if (!normalized.length && conversationId && /^[\w-]+$/.test(conversationId)) conversations.push({ id: conversationId, title: text(item.title), createdAt: timestamp(item.create_time || item.created_at) });
      for (const image of normalized) images.set(image.id, image);
    }
    const cursor = payload?.next_cursor ?? payload?.cursor ?? payload?.next ?? payload?.data?.next_cursor;
    const total = Number(payload?.total ?? payload?.total_count ?? payload?.data?.total);
    const explicitMore = payload?.has_more ?? payload?.hasMore;
    return { images: [...images.values()], conversations, cursor: typeof cursor === 'string' ? cursor : null,
      total: Number.isFinite(total) ? total : null, hasMore: typeof explicitMore === 'boolean' ? explicitMore : null, itemCount: items.length, skippedCount };
  }
  function libraryURL(cursor) {
    const url = new URL('/backend-api/my/recent/image_gen', 'https://chatgpt.com');
    url.searchParams.set('limit', cursor ? '20' : '25');
    if (cursor) url.searchParams.set('after', cursor);
    return url.href;
  }
  function conversationImages(payload, context) {
    const output = [];
    for (const node of Object.values(payload?.mapping || {})) {
      const message = node?.message;
      if (!message || !['assistant', 'tool'].includes(message.author?.role)) continue;
      // The library scopes the conversation; generated image assets live in assistant/tool messages.
      normalizeRecord(message.content, { ...context, messageId: message.id, createdAt: timestamp(message.create_time), title: payload.title || context.title }, output);
    }
    return [...new Map(output.map(image => [image.id, image])).values()];
  }
  function imagePrompt(payload, image) {
    const mapping = payload?.mapping;
    if (!isObject(mapping)) throw new Error('无法取得该图片的 prompt，请打开原聊天。');
    const nodes = Object.entries(mapping), byId = new Map();
    for (const [key, node] of nodes) {
      byId.set(key, node);
      if (node?.id) byId.set(node.id, node);
      if (node?.message?.id) byId.set(node.message.id, node);
    }
    const candidates = nodes.map(([, node]) => node).filter(node => {
      if (!['assistant', 'tool'].includes(node?.message?.author?.role)) return false;
      return normalizeRecord(node.message.content).some(asset => asset.id === image.id || image.fileId && asset.fileId === image.fileId);
    });
    const exact = candidates.filter(node => node.message.id === image.messageId || node.id === image.messageId);
    const matches = exact.length ? exact : candidates;
    if (matches.length !== 1) throw new Error('无法确定该图片对应的 prompt，请打开原聊天。');
    const seen = new Set();
    let node = matches[0];
    while (node?.parent && !seen.has(node.parent)) {
      seen.add(node.parent); node = byId.get(node.parent);
      if (node?.message?.author?.role !== 'user') continue;
      const content = node.message.content;
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const prompt = parts.map(part => typeof part === 'string' ? part : part?.content_type === 'text' ? text(part.text) : '').filter(Boolean).join('\n');
      if (!prompt.trim()) throw new Error('该图片的用户消息没有可复制的文字，请打开原聊天。');
      return { text: prompt };
    }
    throw new Error('无法确定该图片对应的 prompt，请打开原聊天。');
  }
  globalThis.ImageLibraryAdapter = { imageURL, assetId, libraryPage, libraryURL, conversationImages, normalizeRecord, imagePrompt };
})();
