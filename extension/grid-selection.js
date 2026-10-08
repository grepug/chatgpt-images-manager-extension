// Selection outlives virtualized cells, but never crosses a library/account scope.
export class GridSelection {
  active = false;
  locked = false;
  ids = new Set();
  anchor = null;
  images = [];
  positions = new Map();
  reconcile(images) {
    if (this.images !== images) {
      this.images = images;
      this.positions = new Map(images.map((image, index) => [image.id, index]));
    }
    for (const id of this.ids) if (!this.positions.has(id)) this.ids.delete(id);
    if (!this.positions.has(this.anchor)) this.anchor = null;
  }
  enter() { this.active = true; }
  exit() { if (this.locked) return; this.active = false; this.clear(); }
  clear() { if (this.locked) return; this.ids.clear(); this.anchor = null; }
  all() { if (this.locked) return; this.ids = new Set(this.images.map(image => image.id)); }
  toggle(id, range = false) {
    if (!this.active || this.locked || !this.positions.has(id)) return;
    if (range && this.positions.has(this.anchor)) {
      const from = this.positions.get(this.anchor), to = this.positions.get(id);
      for (let index = Math.min(from, to); index <= Math.max(from, to); index++) this.ids.add(this.images[index].id);
    } else {
      if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id);
      this.anchor = id;
    }
  }
  complete(ids) { for (const id of ids) this.ids.delete(id); }
}

export function bulkRequest(account, ids, kind, value) {
  if (typeof account !== 'string' || !account || !Array.isArray(ids) || !ids.length || ids.length > 100
    || ids.some(id => typeof id !== 'string' || !id || id.length > 1024)
    || !['hidden', 'favorite'].includes(kind) || typeof value !== 'boolean') throw new Error('无效的批量操作');
  return { account, ids: [...new Set(ids)], kind, value };
}

// One bounded request at a time permits stopping without undoing durable writes.
export async function runBulk({ ids, apply, stopped = () => false, progress = () => {}, size = 50 }) {
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('无效的批量大小');
  const result = { succeeded: [], failed: [], pending: [...ids], stopped: false };
  for (let offset = 0; offset < ids.length;) {
    if (stopped()) { result.stopped = true; break; }
    const chunk = ids.slice(offset, offset + size);
    let response;
    try { response = await apply(chunk); }
    catch (error) {
      result.failed.push(...chunk.map(id => ({ id, error: error.message })));
      offset += chunk.length; result.pending = ids.slice(offset); result.stopped = true;
      progress(result); break;
    }
    const done = new Set(response.succeeded || []), failures = new Map((response.failed || []).map(item => [item.id, item]));
    for (const id of chunk) {
      if (done.has(id)) result.succeeded.push(id);
      else result.failed.push(failures.get(id) || { id, error: '未确认保存结果，请重试' });
    }
    offset += chunk.length; result.pending = ids.slice(offset);
    progress(result);
    // Let the progress paint and the stop button receive input between chunks.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return result;
}
