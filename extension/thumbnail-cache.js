// Keeps thumbnail pixels warm across virtual card lifetimes. Disk reads and
// missing-image downloads have separate queues so network stalls cannot block hits.
export const THUMBNAIL_MEMORY_BYTES = 256 * 1024 * 1024;
export const THUMBNAIL_VERSION = 2;

export class PriorityQueue {
  constructor(limit) { this.limit = limit; this.running = 0; this.tasks = []; }
  run(work, alive = () => true, priority = () => 0) {
    return new Promise((resolve, reject) => {
      this.tasks.push({ work, alive, priority, resolve, reject }); this.drain();
    });
  }
  drain() {
    this.tasks.sort((a, b) => a.priority() - b.priority());
    while (this.running < this.limit && this.tasks.length) {
      const task = this.tasks.shift();
      if (!task.alive()) { task.resolve(null); continue; }
      this.running++;
      Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => { this.running--; this.drain(); });
    }
  }
}

export function rasterSize(width, height, box) {
  const scale = Math.min(1, (box.cover ? Math.max : Math.min)(box.width / width, box.height / height) * box.dpr);
  // Bucket sizes prevent rebuilding for tiny viewport changes; never upscale.
  const targetWidth = Math.min(width, Math.ceil(width * scale / 128) * 128);
  return { width: targetWidth, height: Math.max(1, Math.round(height * targetWidth / width)) };
}
export function fitsThumbnail(entry, box) {
  if (!entry?.sourceWidth || !entry.sourceHeight) return false;
  const size = rasterSize(entry.sourceWidth, entry.sourceHeight, box);
  return entry.width >= size.width && entry.height >= size.height;
}

export async function decodeThumbnail(blob) {
  const url = URL.createObjectURL(blob), image = new Image();
  image.src = url;
  try { await image.decode(); return { url, image, width: image.naturalWidth, height: image.naturalHeight }; }
  catch (error) { URL.revokeObjectURL(url); throw error; }
}
export async function resizeThumbnail(blob, box) {
  const source = await createImageBitmap(blob);
  try {
    const size = rasterSize(source.width, source.height, box);
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, size.width, size.height);
    // Safari falls back to PNG for WebP encoding. JPEG avoids multi-megabyte
    // opaque previews; inspect alpha so transparent artwork stays transparent.
    const rgba = context.getImageData(0, 0, size.width, size.height).data;
    let transparent = false;
    for (let alpha = 3; alpha < rgba.length; alpha += 4) if (rgba[alpha] !== 255) { transparent = true; break; }
    const resized = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成清晰缩略图')), transparent ? 'image/png' : 'image/jpeg', .97));
    return { blob: resized, ...size, sourceWidth: source.width, sourceHeight: source.height, thumbnailVersion: THUMBNAIL_VERSION };
  } finally { source.close(); }
}

export class ThumbnailCache {
  constructor({ readThumbnail, readOriginal, download, persist, budget = THUMBNAIL_MEMORY_BYTES,
    decode = decodeThumbnail, resize = resizeThumbnail, revoke = url => URL.revokeObjectURL(url) }) {
    Object.assign(this, { readThumbnail, readOriginal, download, persist, budget, decode, resize, revoke });
    this.entries = new Map(); this.bytes = 0; this.clock = 0; this.generation = 0; this.serial = 0;
    this.reads = new PriorityQueue(12); this.downloads = new PriorityQueue(3); this.resizes = new PriorityQueue(3);
    this.decodes = new PriorityQueue(4);
  }
  acquire(account, image, box, alive = () => true, priority = () => 0, localOnly = false) {
    const prefix = `${account}:${image.id}:`;
    let entry = [...this.entries.values()].find(value => !value.stale && value.prefix === prefix && value.resource && fitsThumbnail(value.resource, box));
    const base = `${prefix}${Math.ceil(box.width * box.dpr / 128)}:${Math.ceil(box.height * box.dpr / 128)}:${Boolean(box.cover)}`;
    entry ||= [...this.entries.values()].find(value => !value.stale && value.base === base && !value.resource);
    if (!entry) {
      entry = { key: `${base}:${++this.serial}`, base, prefix, refs: 0, used: ++this.clock, generation: this.generation, consumers: new Set() };
      this.entries.set(entry.key, entry);
      entry.ready = Promise.resolve().then(() => this.load(entry, account, image, box)).then(resource => {
        if (!resource) { this.drop(entry); return null; }
        if (entry.generation !== this.generation) { this.revoke(resource.url); return null; }
        entry.resource = resource; entry.cost = resource.blob.size + resource.width * resource.height * 4;
        this.bytes += entry.cost; this.trim(); return resource;
      }).catch(error => { this.drop(entry); throw error; });
    }
    const consumer = { alive, priority, localOnly }; entry.consumers.add(consumer); entry.refs++; entry.used = ++this.clock;
    let released = false;
    return { url: entry.resource?.url, resource: entry.resource, ready: entry.ready, release: () => {
      if (released) return;
      released = true; entry.consumers.delete(consumer); entry.refs--; entry.used = ++this.clock;
      if (entry.stale && !entry.refs) this.drop(entry);
      this.trim();
    } };
  }
  async load(entry, account, image, box) {
    const alive = () => entry.generation === this.generation && [...entry.consumers].some(c => c.alive());
    const priority = () => Math.min(...[...entry.consumers].map(c => c.priority()));
    const cached = await this.reads.run(() => this.readThumbnail(account, image.id, box), alive, priority);
    if (!alive()) return null;
    let data;
    if (cached?.thumbnailVersion === THUMBNAIL_VERSION && fitsThumbnail(cached, box)) {
      data = cached;
      const size = rasterSize(cached.sourceWidth, cached.sourceHeight, box);
      // Avoid re-encoding ordinary cache hits. Only substantially oversized
      // rasters need shrinking to protect the decoded-memory working set.
      if (cached.width > size.width * 2.5) {
        const resized = await this.resizes.run(() => this.resize(cached.blob, box), alive, priority);
        if (!resized || !alive()) return null;
        data = { ...resized, sourceWidth: cached.sourceWidth, sourceHeight: cached.sourceHeight, thumbnailVersion: THUMBNAIL_VERSION };
      }
    }
    else {
      let original = await this.reads.run(() => this.readOriginal(account, image.id), alive, priority);
      const fullQuality = Boolean(original);
      if (!alive()) return null;
      if (!original && !cached) {
        if (![...entry.consumers].some(consumer => !consumer.localOnly)) return null;
        original = await this.downloads.run(() => this.download(account, image), alive, priority);
      }
      if (!alive()) return null;
      const blob = original || cached?.blob;
      if (!blob) return null;
      data = await this.resizes.run(() => this.resize(blob, box), alive, priority);
      if (!data || !alive()) return null;
      // Only a local original proves full quality. Recheck after a later cache update
      // when a small server preview was the only available source.
      data.thumbnailVersion = fullQuality ? THUMBNAIL_VERSION : 0;
      if (fullQuality) this.persist(account, image.id, data, cached).catch(() => {});
    }
    if (!alive()) return null;
    const decoded = await this.decodes.run(() => this.decode(data.blob), alive, priority);
    if (!decoded) return null;
    const resource = { ...data, ...decoded };
    if (!alive()) { this.revoke(resource.url); return null; }
    if (entry.originalReady && resource.thumbnailVersion === 0) {
      this.revoke(resource.url); entry.originalReady = false;
      return this.load(entry, account, image, box);
    }
    return resource;
  }
  drop(entry) {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    if (entry.resource) { this.bytes -= entry.cost; this.revoke(entry.resource.url); entry.resource.image = null; }
  }
  trim() {
    for (const entry of [...this.entries.values()].filter(value => !value.refs && value.resource).sort((a, b) => a.used - b.used)) {
      if (this.bytes <= this.budget) break;
      this.drop(entry);
    }
  }
  clear() {
    this.generation++;
    for (const entry of this.entries.values()) this.drop(entry);
  }
  invalidatePreview(account, id) {
    for (const entry of this.entries.values()) if (entry.prefix === `${account}:${id}:`) {
      entry.originalReady = true;
      if (entry.resource?.thumbnailVersion === 0) {
        entry.stale = true;
        if (!entry.refs) this.drop(entry);
      }
    }
  }
}
