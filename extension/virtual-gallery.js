import { masonryLayout, masonryWindow, masonryAnchor, masonryScrollTop } from './masonry.js';
import { chatStatus, chatLabel } from './chat-archive.js';

export class VirtualGallery {
  constructor({ host, canvas, sidebar = false, loadImage, openImage, favorite, hideImage, locateImage, onScroll, onVisible, starIcon, actionIcon, selection, selectImage, chatState, onVisibleChats }) {
    Object.assign(this, { host, canvas, sidebar, loadImage, openImage, favorite, hideImage, locateImage, onScroll, onVisible, starIcon, actionIcon, selection, selectImage });
    Object.assign(this, { chatState, onVisibleChats });
    this.visibilityTimers = new Map(); this.notified = new Set();
    this.images = []; this.byId = new Map(); this.nodes = new Map(); this.dimensions = new Map();
    this.prefetches = new Map(); this.exits = new Set(); this.filter = 'all';
    this.size = 'medium'; this.active = false; this.saved = { scrollTop: 0, anchor: null };
    this.layout = masonryLayout([], 1); this.layoutWidth = 0; this.frame = null;
    host.addEventListener('scroll', () => { if (this.active) { this.schedule(); onScroll?.(); } }, { passive: true });
    canvas.addEventListener('keydown', event => this.keydown(event));
    new ResizeObserver(() => { if (this.active && host.clientWidth !== this.layoutWidth) this.rebuild(); }).observe(host);
    window.addEventListener('resize', () => { if (this.active) this.schedule(); });
  }
  state() {
    return this.active ? { scrollTop: this.host.scrollTop, anchor: masonryAnchor(this.layout, this.host.scrollTop) } : this.saved;
  }
  restore(state = {}) {
    this.saved = { scrollTop: state.scrollTop || 0, anchor: state.anchor || null };
    if (this.active) this.rebuild(this.saved);
  }
  reset() {
    this.clear(); this.notified.clear(); this.dimensions.clear(); this.images = []; this.byId.clear();
    this.layout = masonryLayout([], 1); this.saved = { scrollTop: 0, anchor: null };
    this.canvas.style.height = '0px'; this.host.scrollTop = 0;
  }
  setActive(active) {
    if (this.active === active) return;
    if (!active) { this.saved = this.state(); this.active = false; this.clear(); return; }
    this.active = true; this.rebuild(this.saved);
  }
  setSize(size) {
    if (this.size === size) return;
    this.size = size;
    if (this.active) this.rebuild();
  }
  updateSelection(record) {
    if (this.sidebar || !this.selection) return;
    const active = this.selection.active, chosen = active && this.selection.ids.has(record.node.dataset.id);
    record.node.classList.toggle('multi-select-card', active);
    record.node.classList.toggle('is-batch-selected', chosen);
    record.open.disabled = active && this.selection.locked;
    if (active) record.open.setAttribute('aria-pressed', String(chosen)); else record.open.removeAttribute('aria-pressed');
  }
  selectionChanged() { for (const record of this.nodes.values()) this.updateSelection(record); }
  setImages(images, selectedId, preserve = true, animate = false) {
    const positions = animate && this.active && !matchMedia('(prefers-reduced-motion: reduce)').matches
      ? new Map([...this.nodes].map(([id, record]) => [id, record.node.getBoundingClientRect()])) : null;
    this.finishAnimations();
    const sameGeometry = this.images.length === images.length && images.every((image, i) => {
      const previous = this.images[i];
      return previous.id === image.id && previous.width === image.width && previous.height === image.height;
    });
    const state = preserve ? this.state() : { scrollTop: 0, anchor: null };
    if (state.anchor && !images.some(image => image.id === state.anchor.id)) {
      const retained = new Set(images.map(image => image.id));
      const nearby = masonryWindow(this.layout, state.scrollTop, this.host.clientHeight || 500)
        .filter(item => retained.has(item.id)).sort((a, b) => Math.abs(a.y - state.scrollTop) - Math.abs(b.y - state.scrollTop))[0];
      if (nearby) state.anchor = { id: nearby.id, index: nearby.index, offset: state.scrollTop - nearby.y };
    }
    this.images = images; this.byId = new Map(images.map(image => [image.id, image])); this.selectedId = selectedId;
    if (!preserve) this.saved = state;
    if (!this.active) { this.saved = state; return; }
    if (positions) {
      for (const [id, record] of this.nodes) if (!this.byId.has(id)) {
        this.nodes.delete(id); this.exits.add(record);
        record.node.inert = true; record.node.setAttribute('aria-hidden', 'true');
        const animation = record.node.animate([{ opacity: 1, transform: record.node.style.transform },
          { opacity: 0, transform: `${record.node.style.transform} scale(.96)` }], { duration: 200, easing: 'ease-out' });
        record.animation = animation;
        animation.finished.catch(() => {}).finally(() => { if (this.exits.delete(record)) this.remove(record); });
      }
    }
    if (!sameGeometry || !preserve) this.rebuild(state); else this.schedule();
    if (positions) {
      this.render();
      for (const [id, record] of this.nodes) {
        const before = positions.get(id); if (!before) continue;
        const after = record.node.getBoundingClientRect(), dx = before.left - after.left, dy = before.top - after.top;
        if (Math.abs(dx) + Math.abs(dy) < 1) continue;
        const target = record.node.style.transform;
        record.animation = record.node.animate([{ transform: `${target} translate(${dx}px, ${dy}px)` },
          { transform: target }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
  }
  finishAnimations() {
    for (const record of this.nodes.values()) { record.animation?.cancel(); record.animation = null; }
    for (const record of this.exits) this.remove(record);
    this.exits.clear();
  }
  measure(id, width, height) {
    const image = this.byId.get(id);
    if (!image || image.width > 0 && image.height > 0 || !width || !height || this.dimensions.get(id) === height / width) return;
    this.dimensions.set(id, height / width);
    if (!this.sidebar && this.active) {
      clearTimeout(this.measureTimer);
      this.measureTimer = setTimeout(() => { if (this.active) this.rebuild(); }, 80);
    }
  }
  rebuild(state = this.state()) {
    if (!this.active || !this.host.clientWidth) return;
    this.layoutWidth = this.host.clientWidth;
    this.layout = masonryLayout(this.images, this.layoutWidth, this.size, this.dimensions, this.sidebar);
    this.canvas.style.height = `${this.layout.height}px`;
    this.host.scrollTop = masonryScrollTop(this.layout, state.anchor, state.scrollTop);
    this.schedule();
  }
  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; if (this.active) this.render(); });
  }
  clear() {
    for (const timer of this.visibilityTimers.values()) clearTimeout(timer);
    this.visibilityTimers.clear();
    this.finishAnimations();
    clearTimeout(this.measureTimer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const record of this.nodes.values()) this.remove(record);
    this.nodes.clear();
    for (const record of this.prefetches.values()) { record.alive = false; record.lease?.release(); }
    this.prefetches.clear();
  }
  remove(record) {
    record.animation?.cancel();
    record.alive = false; record.node.remove();
    record.img.remove();
    record.lease?.release(); record.pending?.release();
  }
  create(image) {
    const node = document.createElement(this.sidebar ? 'button' : 'div');
    node.className = this.sidebar ? 'thumbnail virtual-thumbnail' : 'grid-card';
    node.dataset.id = image.id; node.setAttribute('role', 'listitem');
    const open = this.sidebar ? node : document.createElement('button');
    if (!this.sidebar) { open.className = 'grid-open'; node.append(open); }
    const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.decoding = 'async';
    img.className = this.sidebar ? 'thumbnail-image' : 'grid-image';
    const title = document.createElement('span'); title.className = this.sidebar ? 'thumbnail-title' : 'grid-card-title';
    const archiveBadge = document.createElement('span'); archiveBadge.className = 'chat-archive-badge'; open.append(archiveBadge);
    open.append(img, title); open.addEventListener('click', event => {
      if (this.selection?.active) this.selectImage(image.id, event.shiftKey);
      else this.openImage(image.id);
    });
    if (!this.sidebar) {
      const check = document.createElement('span'); check.className = 'grid-selection-check'; check.setAttribute('aria-hidden', 'true');
      if (this.actionIcon) check.append(this.actionIcon('check')); open.append(check);
    }
    const star = document.createElement(this.sidebar ? 'span' : 'button');
    star.className = this.sidebar ? 'thumbnail-star' : 'grid-favorite'; star.append(this.starIcon());
    if (this.sidebar) {
      const date = document.createElement('span'); date.className = 'thumbnail-date'; open.append(date, star);
    } else {
      node.append(star); star.addEventListener('click', () => this.favorite(image.id));
    }
    let hide, locate;
    if (!this.sidebar && this.hideImage) {
      hide = document.createElement('button'); hide.className = 'grid-action grid-hide'; hide.append(this.actionIcon('hide'));
      hide.addEventListener('click', () => this.hideImage(image.id)); node.append(hide);
      locate = document.createElement('button'); locate.className = 'grid-action grid-locate'; locate.append(this.actionIcon('locate'));
      locate.addEventListener('click', () => this.locateImage(image.id)); node.append(locate);
    }
    const record = { node, open, img, title, star, hide, locate, archiveBadge, alive: true, url: null };
    this.nodes.set(image.id, record); this.canvas.append(node);
    return record;
  }
  load(record, image, item) {
    const box = { width: this.sidebar ? item.width - 12 : item.width,
      height: this.sidebar ? (this.layoutWidth <= 154 ? 80 : 96) : 1e9,
      cover: this.sidebar, dpr: window.devicePixelRatio || 1 };
    const pixels = Math.ceil(box.width * box.dpr);
    if (record.requestedPixels >= pixels && !record.failed) return;
    if (record.failed && Date.now() < record.retryAt) return;
    record.requestedPixels = pixels; record.failed = false;
    record.pending?.release();
    const priority = () => {
      const top = this.host.scrollTop, bottom = top + this.host.clientHeight;
      return item.y + item.height >= top && item.y <= bottom ? 0 : Math.min(Math.abs(item.y - bottom), Math.abs(item.y + item.height - top)) + 1;
    };
    const lease = this.loadImage(image, () => record.alive && record.pending === lease, box, priority);
    record.pending = lease;
    const apply = resource => {
      // Reattach the decoded image itself. A fresh img with the same Blob URL
      // still has a separate loading/painting lifecycle in Safari.
      const img = resource.image;
      img.className = this.sidebar ? 'thumbnail-image' : 'grid-image'; img.alt = ''; img.draggable = false; img.decoding = 'sync';
      if (record.img !== img) { record.img.replaceWith(img); record.img = img; }
      record.url = resource.url; record.node.classList.remove('thumbnail-unavailable');
    };
    if (lease.resource) apply(lease.resource);
    lease.ready.then(resource => {
      if (!record.alive || record.pending !== lease) { lease.release(); return; }
      record.pending = null;
      if (!resource) { lease.release(); record.requestedPixels = 0; this.schedule(); return; }
      record.lease?.release(); record.lease = lease; apply(resource);
      record.preview = resource.thumbnailVersion === 0;
      this.measure(image.id, resource.width, resource.height);
      this.schedule();
    }).catch(() => {
      lease.release();
      if (!record.alive || record.pending !== lease) return;
      record.pending = null; record.failed = true; record.retryAt = Date.now() + 3000;
      if (!record.url) record.node.classList.add('thumbnail-unavailable');
    });
  }
  refreshPreview(id) {
    const record = this.nodes.get(id);
    if (record && (record.preview || !record.url) && !record.pending) { record.requestedPixels = 0; this.schedule(); }
  }
  render() {
    const visible = masonryWindow(this.layout, this.host.scrollTop, this.host.clientHeight);
    const wanted = new Set(visible.map(item => item.id));
    for (const [id, record] of this.nodes) if (!wanted.has(id)) { this.remove(record); this.nodes.delete(id); }
    // Screen pixels take precedence over overscan; queued work uses live distance.
    const top = this.host.scrollTop, bottom = top + this.host.clientHeight;
    const loadingOrder = [...visible].sort((a, b) => {
      const distance = item => item.y + item.height >= top && item.y <= bottom ? 0 : Math.min(Math.abs(item.y - bottom), Math.abs(item.y + item.height - top)) + 1;
      return distance(a) - distance(b);
    });
    for (const item of loadingOrder) {
      const image = this.byId.get(item.id), record = this.nodes.get(item.id) || this.create(image);
      const { node, open, title, star, hide, locate, archiveBadge } = record;
      const state = this.chatState?.(image.conversationId);
      archiveBadge.dataset.state = chatStatus(state);
      archiveBadge.textContent = { archived: '已归档', unarchived: '未归档', unknown: '待确认' }[chatStatus(state)];
      archiveBadge.setAttribute('aria-label', chatLabel(state));
      archiveBadge.title = state?.checkedAt ? chatLabel(state) + ' · 上次核验 ' + new Date(state.checkedAt).toLocaleString('zh-CN') : chatLabel(state);
      archiveBadge.hidden = !this.chatState;
      node.style.transform = `translate(${item.x}px, ${item.y}px)`;
      node.style.width = `${item.width}px`; node.style.height = `${item.height}px`;
      this.load(record, image, item);
      node.setAttribute('aria-setsize', this.images.length); node.setAttribute('aria-posinset', item.index + 1);
      open.setAttribute('aria-label', `${image.title}${image.favorite ? '，已收藏' : ''}`);
      open.setAttribute('aria-current', String(image.id === this.selectedId));
      if (this.chatState) open.setAttribute('aria-label', open.getAttribute('aria-label') + '，' + chatLabel(state));
      node.classList.toggle('selected', image.id === this.selectedId);
      this.updateSelection(record);
      title.textContent = image.deleted ? `${image.title} · 来源已删除` : image.title;
      if (this.sidebar) {
        star.hidden = !image.favorite;
        node.querySelector('.thumbnail-date').textContent = image.deleted ? '来源已删除' : image.createdAt ? new Intl.DateTimeFormat('zh-CN').format(image.createdAt) : '';
      } else {
        node.classList.toggle('is-favorite', Boolean(image.favorite));
        star.setAttribute('aria-label', image.favorite ? `取消收藏：${image.title}` : `收藏：${image.title}`);
        star.setAttribute('aria-pressed', String(Boolean(image.favorite)));
        star.title = image.favorite ? '取消收藏' : '收藏图片';
        if (hide) {
          hide.title = this.filter === 'hidden' ? '取消隐藏' : '隐藏图片';
          hide.setAttribute('aria-label', `${hide.title}：${image.title}`);
          hide.classList.toggle('restore-hidden', this.filter === 'hidden');
          locate.hidden = this.filter !== 'favorites' || (image.deleted && !image.localOriginal);
          locate.title = '在全部图片中定位'; locate.setAttribute('aria-label', `${locate.title}：${image.title}`);
        }
      }
    }
    // Keep tab order in source order without detaching retained nodes or focus.
    let previous = null;
    for (const item of visible) {
      const node = this.nodes.get(item.id).node;
      if (node.previousElementSibling !== previous) this.canvas.insertBefore(node, previous ? previous.nextElementSibling : this.canvas.firstElementChild);
      previous = node;
    }
    const screenReady = visible.filter(item => item.y + item.height >= top && item.y <= bottom)
      .every(item => { const record = this.nodes.get(item.id); return record.url && (!record.pending || record.pending.resource); });
    this.onVisibleChats?.(visible.filter(item => item.y + item.height > top && item.y < bottom)
      .map(item => this.byId.get(item.id).conversationId).filter(Boolean));
    if (!this.sidebar && this.onVisible) {
      const screen = new Set(visible.filter(item => item.y + item.height > top && item.y < bottom).map(item => item.id));
      for (const [id, timer] of this.visibilityTimers) if (!screen.has(id)) { clearTimeout(timer); this.visibilityTimers.delete(id); }
      for (const id of screen) if (!this.notified.has(id) && !this.visibilityTimers.has(id)) {
        this.visibilityTimers.set(id, setTimeout(() => {
          this.visibilityTimers.delete(id);
          const item = this.layout.byId.get(id), top = this.host.scrollTop;
          if (document.hidden || !this.active || !item || item.y + item.height <= top || item.y >= top + this.host.clientHeight) return;
          this.notified.add(id);
          Promise.resolve(this.onVisible(id)).catch(() => { this.notified.delete(id); });
        }, 300));
      }
    }
    this.prefetch(wanted, screenReady);
  }
  prefetch(mounted, allowStart) {
    const nearby = masonryWindow(this.layout, this.host.scrollTop, this.host.clientHeight, this.sidebar ? 800 : 2000)
      .filter(item => !mounted.has(item.id));
    const wanted = new Set(nearby.map(item => item.id));
    for (const [id, record] of this.prefetches) if (!wanted.has(id) || record.width !== this.layoutWidth || record.size !== this.size || record.dpr !== window.devicePixelRatio) {
      record.alive = false; record.lease?.release(); this.prefetches.delete(id);
    }
    if (!allowStart) return;
    for (const item of nearby) {
      if (this.prefetches.has(item.id)) continue;
      const record = { alive: true, width: this.layoutWidth, size: this.size, dpr: window.devicePixelRatio }; this.prefetches.set(item.id, record);
      const box = { width: this.sidebar ? item.width - 12 : item.width, height: this.sidebar ? (this.layoutWidth <= 154 ? 80 : 96) : 1e9,
        cover: this.sidebar, dpr: window.devicePixelRatio || 1 };
      const lease = this.loadImage(this.byId.get(item.id), () => record.alive, box,
        () => 2001 + Math.abs(item.y - this.host.scrollTop), true);
      record.lease = lease;
      lease.ready.catch(() => {}).finally(() => { lease.release(); record.lease = null; record.alive = false; });
    }
  }
  scrollToId(id, focus = false, align = false) {
    const item = this.layout.byId.get(id); if (!item) return;
    const top = this.host.scrollTop, bottom = top + this.host.clientHeight;
    if (align || item.y < top || item.y + item.height > bottom) this.host.scrollTop = item.y;
    this.render();
    if (focus) this.nodes.get(id)?.open.focus({ preventScroll: true });
  }
  keydown(event) {
    if (this.sidebar || event.metaKey || event.ctrlKey || event.altKey || !event.key.startsWith('Arrow')) return;
    const item = this.layout.byId.get(event.target.closest('[data-id]')?.dataset.id); if (!item) return;
    let next;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = this.layout.items[item.index + (event.key === 'ArrowLeft' ? -1 : 1)];
    else {
      const column = this.layout.columns[item.column], index = column.indexOf(item);
      next = column[index + (event.key === 'ArrowUp' ? -1 : 1)];
    }
    event.preventDefault(); if (next) this.scrollToId(next.id, true);
  }
}
