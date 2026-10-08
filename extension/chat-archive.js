export const CHAT_STATE_TTL = 5 * 60 * 1000;
export function chatIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)))
    throw Object.assign(new Error('无效的聊天请求'), { code: 'DATA' });
  return [...new Set(ids)];
}
export function chatStatus(state) {
  return state?.error || typeof state?.archived !== 'boolean' ? 'unknown' : state.archived ? 'archived' : 'unarchived';
}
export function chatLabel(state) {
  return { archived: '聊天已归档', unarchived: '聊天未归档', unknown: '归档状态未能确认' }[chatStatus(state)];
}
export function archivePlan(images) {
  const conversations = new Map(), missing = [];
  for (const image of images) {
    if (!image.conversationId || !/^[\w-]{1,128}$/.test(image.conversationId)) { missing.push(image.id); continue; }
    if (!conversations.has(image.conversationId)) conversations.set(image.conversationId, []);
    conversations.get(image.conversationId).push(image.id);
  }
  return { conversations, missing };
}
// A bounded metadata reader lets visible chats overtake the background queue.
export class ChatStateQueue {
  constructor({ read, changed, now = () => Date.now(), active = () => true, delay = 750 }) {
    Object.assign(this, { read, changed, now, active, delay });
    this.states = new Map(); this.pending = new Map(); this.inFlight = new Set(); this.generation = 0;
  }
  reset(rows = []) {
    this.generation++; clearTimeout(this.timer); this.timer = null; this.pending.clear(); this.running = false; this.blockedUntil = 0;
    this.states = new Map(rows.map(row => [row.id, row]));
    this.inFlight = new Set();
  }
  set(rows) {
    for (const row of rows) {
      if (!row?.id || typeof row.archived !== 'boolean') continue;
      if ((this.states.get(row.id)?.checkedAt || 0) > row.checkedAt) continue;
      this.states.set(row.id, row);
      if (this.now() - row.checkedAt < CHAT_STATE_TTL && !row.error) this.pending.delete(row.id);
    }
  }
  enqueue(ids, priority = 10) {
    for (const id of new Set(ids.filter(Boolean))) {
      if (this.inFlight.has(id)) continue;
      const state = this.states.get(id);
      if (state && this.now() - (state.errorAt || state.checkedAt || 0) < (state.error ? 60000 : CHAT_STATE_TTL)) continue;
      this.pending.set(id, Math.min(priority, this.pending.get(id) ?? Infinity));
    }
    this.kick();
  }
  kick() {
    if (this.running || this.timer || !this.pending.size || !this.active() || this.now() < this.blockedUntil) return;
    this.timer = setTimeout(() => { this.timer = null; this.drain(); }, this.delay);
  }
  async drain() {
    if (this.running || !this.active() || this.now() < this.blockedUntil) return;
    const generation = this.generation;
    const ids = [...this.pending].sort((a,b) => a[1] - b[1]).slice(0,10).map(([id]) => id);
    if (!ids.length) return;
    for (const id of ids) this.pending.delete(id);
    this.inFlight = new Set(ids);
    this.running = true;
    const startedAt = this.now();
    try {
      const rows = await this.read(ids);
      if (generation !== this.generation) return;
      const returned = new Set(rows.map(row => row.id)); this.set(rows);
      for (const id of ids) if (!returned.has(id) && (this.states.get(id)?.checkedAt || 0) <= startedAt)
        this.states.set(id, { ...this.states.get(id), id, error: '无法读取该聊天', errorAt: this.now() });
      this.changed(this.states);
    } catch (error) {
      if (generation !== this.generation) return;
      for (const id of ids) if ((this.states.get(id)?.checkedAt || 0) <= startedAt)
        this.states.set(id, { ...this.states.get(id), id, error: error.message, errorAt: this.now() });
      if (['AUTH','ACCOUNT_CHANGED','RATE_LIMIT'].includes(error.code)) this.blockedUntil = this.now() + 300000;
      this.changed(this.states);
    } finally {
      if (generation === this.generation) { this.inFlight.clear(); this.running = false; this.kick(); }
    }
  }
}
export async function runArchive({ ids, apply, stopped, progress }) {
  const result = { succeeded: [], skipped: [], failed: [], pending: [...new Set(ids)] };
  while (result.pending.length && !stopped()) {
    const id = result.pending[0];
    try {
      const response = await apply(id);
      if (response?.state?.archived !== true) throw Object.assign(new Error('未能确认聊天已归档'), { code: 'UNCERTAIN' });
      (response.skipped ? result.skipped : result.succeeded).push(id); result.pending.shift();
    } catch (error) {
      result.failed.push({ id, error: error.message }); result.pending.shift();
      if (['AUTH','ACCOUNT_CHANGED','RATE_LIMIT','UNCERTAIN','NETWORK','SOURCE'].includes(error.code)) { result.error = error.message; break; }
    }
    progress?.(result);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  progress?.(result);
  return result;
}
