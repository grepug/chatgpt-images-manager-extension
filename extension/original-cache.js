import { PriorityQueue, decodeThumbnail } from './thumbnail-cache.js';

export const ORIGINAL_MEMORY_BYTES = 128 * 1024 * 1024;

// Session-only originals. Decoded pixels are reclaimed before verified files;
// pinned leases keep the displayed or most recently closed picture available.
export class OriginalCache {
  constructor({ read, download, decode = decodeThumbnail, budget = ORIGINAL_MEMORY_BYTES,
    revoke = url => URL.revokeObjectURL(url) }) {
    Object.assign(this, { read, download, decode, budget, revoke });
    this.entries = new Map(); this.bytes = 0; this.clock = 0; this.generation = 0;
    this.reads = new PriorityQueue(2); this.preloads = new PriorityQueue(1);
    this.downloads = new PriorityQueue(2); this.decodes = new PriorityQueue(2);
  }
  acquire(account, image, { localOnly = false, alive = () => true } = {}) {
    const key = JSON.stringify([account, image.id]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, account, image, refs: 0, used: ++this.clock, generation: this.generation, consumers: new Set(), blob: null, resource: null };
      this.entries.set(key, entry);
    }
    const consumer = { localOnly, alive }; entry.consumers.add(consumer); entry.refs++; entry.used = ++this.clock;
    if (!entry.resource && !entry.task) {
      entry.task = Promise.resolve().then(() => this.load(entry)).then(resource => {
        if (!resource) { if (!entry.blob) this.drop(entry); return null; }
        if (!this.valid(entry)) { this.dispose(resource); return null; }
        entry.resource = resource; entry.pixelBytes = resource.width * resource.height * 4;
        this.bytes += entry.pixelBytes; this.trim(); return resource;
      }).catch(error => { if (!entry.blob) this.drop(entry); throw error; })
        .finally(() => { entry.task = null; this.trim(); });
    }
    let released = false;
    return { resource: entry.resource, ready: entry.resource ? Promise.resolve(entry.resource) : entry.task,
      release: () => {
        if (released) return;
        released = true; entry.consumers.delete(consumer); entry.refs--; entry.used = ++this.clock; this.trim();
      } };
  }
  valid(entry) { return entry.generation === this.generation && this.entries.get(entry.key) === entry; }
  hasFile(account, id) { return Boolean(this.entries.get(JSON.stringify([account, id]))?.blob); }
  preload(account, image, alive = () => true) {
    // Create the lease when this preload actually starts, so a later foreground
    // request cannot be trapped behind a queued local-only acquisition.
    return this.preloads.run(async () => {
      const lease = this.acquire(account, image, { localOnly: true, alive });
      try { return await lease.ready; } finally { lease.release(); }
    }, alive, () => 100);
  }
  async load(entry) {
    const alive = () => this.valid(entry) && [...entry.consumers].some(consumer => consumer.alive());
    const foreground = () => [...entry.consumers].some(consumer => !consumer.localOnly && consumer.alive());
    const priority = () => foreground() ? 0 : 100;
    if (!entry.blob) {
      let blob = await this.reads.run(() => this.read(entry.account, entry.image.id, { foreground, alive }), alive, priority);
      if (!alive()) return null;
      if (!blob && foreground()) blob = await this.downloads.run(() => this.download(entry.account, entry.image), alive, priority);
      if (!blob || !alive()) return null;
      entry.blob = blob; this.bytes += blob.size;
    }
    const resource = await this.decodes.run(() => this.decode(entry.blob), alive, priority);
    if (!resource) return null;
    if (!alive()) { this.dispose(resource); return null; }
    return resource;
  }
  dispose(resource) {
    this.revoke(resource.url);
    resource.image?.removeAttribute?.('src');
  }
  trim() {
    const candidates = [...this.entries.values()].filter(entry => !entry.refs && !entry.task).sort((a, b) => a.used - b.used);
    for (const entry of candidates) {
      if (this.bytes <= this.budget) break;
      if (entry.resource) {
        this.dispose(entry.resource); entry.resource = null;
        this.bytes -= entry.pixelBytes; entry.pixelBytes = 0;
      }
    }
    for (const entry of candidates) {
      if (this.bytes <= this.budget) break;
      this.drop(entry);
    }
  }
  drop(entry) {
    if (!this.valid(entry)) return;
    this.entries.delete(entry.key);
    if (entry.resource) { this.dispose(entry.resource); this.bytes -= entry.pixelBytes; }
    if (entry.blob) this.bytes -= entry.blob.size;
    entry.resource = null; entry.blob = null;
  }
  clear() {
    for (const entry of this.entries.values()) this.drop(entry);
    this.generation++; this.bytes = 0;
  }
}
