import { getImages, getValue, putValue, getAsset, getThumbnailAsset, storeAsset, getHiddenIds } from './db.js';
import { visibleImages, adjacentImages, moveSelection, fitScale, zoomAt, clampTransform, formatBytes } from './core.js';
import { GRID_SIZES } from './masonry.js';
import { VirtualGallery } from './virtual-gallery.js';
import { cacheDisplay } from './cache-display.js';
import { ThumbnailCache } from './thumbnail-cache.js';
import { OriginalCache } from './original-cache.js';
import { GridSelection, runBulk } from './grid-selection.js';

const extension = globalThis.browser || globalThis.chrome;
const preview = new URLSearchParams(location.search).get('preview') === '1' && !extension?.runtime?.id;
const $ = id => document.getElementById(id);
let mainImage = $('main-image');
const viewport = $('viewport'), thumbnails = $('thumbnails');
let originalLease = null;
let account = null, online = false, images = [], filter = 'all', selectedId = null, selectedImage = null;
let transform = { scale: 1, x: 0, y: 0 }, width = 0, height = 0;
let viewMode = 'fit', sidebarHidden = true, chromeTimer;
let viewerPanel = null;
let layout = 'grid', gridSize = 'medium';
let hiddenIds = new Set(), filterStates = {}, listHidden;
const hiddenPending = new Set(), promptCache = new Map();
let promptJob = null;
const editDrafts = new Map();
let editJob = null;
let loadSequence = 0, refreshSequence = 0, reloadSequence = 0, restoring = false, syncing = false;
let currentURL = null, saveTimer, gestureStart = null, dragStart = null;
const queue = []; let queueRunning = 0;
let storageSequence = 0;
let listImages, listFilter, visibleList = [], imageById = new Map(), reloadTimer;
let demandFrame = 0, demandAccount = null;
const demandIds = new Set();
const gridSelection = new GridSelection();
let bulkJob = null, bulkAnimationUntil = 0;
function demandVisible(id) {
  if (demandAccount !== account) { demandIds.clear(); demandAccount = account; }
  demandIds.add(id);
  if (demandFrame) return;
  demandFrame = requestAnimationFrame(() => {
    demandFrame = 0;
    const ids = [...demandIds], targetAccount = demandAccount; demandIds.clear();
    if (targetAccount === account && ids.length) rpc('demand-cache', { account, ids }).catch(() => {});
  });
}
const thumbnailCache = new ThumbnailCache({ readThumbnail: getThumbnailAsset, readOriginal: getAsset,
  download: async (targetAccount, image) => {
    const result = await rpc('asset', { account: targetAccount, id: image.id, kind: 'thumbnail' });
    return (await fetch(result.dataURL)).blob();
  },
  persist: (targetAccount, id, data) => storeAsset(targetAccount, id, 'thumbnail', data.blob, {
    width: data.width, height: data.height, sourceWidth: data.sourceWidth, sourceHeight: data.sourceHeight, thumbnailVersion: data.thumbnailVersion
  }) });
const originalCache = new OriginalCache({ read: (targetAccount, id, options) => getAsset(targetAccount, id, 'original', options), download: async (targetAccount, image) => {
  const result = await rpc('asset', { account: targetAccount, id: image.id, kind: 'original' });
  return (await fetch(result.dataURL)).blob();
} });
const gallery = new VirtualGallery({ host: $('grid-scroll'), canvas: $('grid-canvas'), loadImage: thumbnailURL,
  openImage: openViewer, favorite: toggleFavorite, hideImage: toggleHidden, locateImage: locateAll,
  onVisible: demandVisible,
  selection: gridSelection, selectImage: (id, range) => { gridSelection.toggle(id, range); updateGridSelection(); },
  onScroll: saveView, starIcon: () => icon('star'), actionIcon: icon });
const sidebarGallery = new VirtualGallery({ host: thumbnails, canvas: $('thumbnail-canvas'), sidebar: true,
  loadImage: thumbnailURL, openImage: select, onScroll: saveView, starIcon: () => icon('star') });

async function rpc(type, args = {}) {
  if (preview) return (await import('./preview.js')).previewRPC(type, args);
  if (!extension?.runtime?.id) throw new Error('请从浏览器扩展图标打开图片库。');
  const response = await extension.runtime.sendMessage({ type, ...args });
  if (!response?.ok) throw Object.assign(new Error(response?.error || '扩展连接中断，请重试。'), { code: response?.code });
  return response.result;
}
function status(text) {
  $('status-text').textContent = $('notice-text').textContent = text || '';
  $('notice-toggle').title = text || '查看提示';
  $('notice-toggle').setAttribute('aria-label', text || '查看提示');
  $('status').hidden = !text;
}
// Menus are owned by the open-source component; this controller only owns
// the editor and standalone content dialogs.
function closeViewerPanel(focus = true) {
  const previous = viewerPanel;
  viewerPanel = null;
  $('edit-panel').hidden = $('describe-edits').hidden = true;
  document.body.classList.remove('editing-image');
  $('toggle-edit').setAttribute('aria-expanded', 'false');
  window.viewerMenus?.close();
  for (const id of ['help-dialog', 'settings-dialog', 'prompt-dialog']) {
    const node = $(id);
    if (node.open && !node.closest('.component-menu')) node.close();
  }
  if (focus && previous === 'edit') $('toggle-edit').focus({ preventScroll: true });
}
function openViewerPanel(kind) {
  if (kind !== 'edit') { showDialog(kind); return; }
  window.viewerMenus?.close();
  viewerPanel = 'edit';
  $('edit-panel').hidden = false;
  document.body.classList.add('editing-image');
  $('toggle-edit').setAttribute('aria-expanded', 'true');
  updateControls(); resizeEditPrompt();
  $('edit-prompt').focus({ preventScroll: true });
}
function showDialog(id) {
  viewerPanel = id;
  const node = $(id);
  if (layout === 'viewer') { node.classList.add('viewer-dialog'); node.show(); }
  else { node.classList.remove('viewer-dialog'); node.showModal(); }
}
function requestViewerLayout() { window.viewerMenus?.layout(); }

function displayDate(time) { return time ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(time) : ''; }
function list() {
  if (listImages !== images || listFilter !== filter || listHidden !== hiddenIds) {
    listImages = images; listFilter = filter; listHidden = hiddenIds; visibleList = visibleImages(images, filter, hiddenIds);
    imageById = new Map(images.map(image => [image.id, image]));
  }
  return visibleList;
}
function current() {
  list(); const image = imageById.get(selectedId) || selectedImage;
  return image && hiddenIds.has(image.id) === (filter === 'hidden') ? image : null;
}
function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#icon-${name}`); svg.append(use);
  return svg;
}
function schedule(work) {
  return new Promise((resolve, reject) => { queue.push({ work, resolve, reject }); drain(); });
}
function drain() {
  while (queueRunning < 3 && queue.length) {
    const task = queue.shift(); queueRunning++;
    Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => { queueRunning--; drain(); });
  }
}
function clearImageURLs() {
  const placeholder = document.createElement('img'); placeholder.id = 'main-image'; placeholder.className = 'main-image'; placeholder.hidden = true;
  mainImage.replaceWith(placeholder); mainImage = placeholder;
  originalLease?.release(); originalLease = null; originalCache.clear(); currentURL = null;
  gallery.reset(); sidebarGallery.reset(); thumbnailCache.clear();
}
function thumbnailURL(image, alive, box, priority, localOnly = false) {
  const targetAccount = account;
  return thumbnailCache.acquire(targetAccount, image, box, () => alive() && account === targetAccount, priority, localOnly);
}
function renderList(preserve = true, animate = false) {
  const visible = list();
  gridSelection.reconcile(visible);
  gallery.filter = sidebarGallery.filter = filter;
  gallery.setImages(visible, selectedId, preserve, animate); sidebarGallery.setImages(visible, selectedId, preserve, animate);
  const emptyText = filter === 'hidden' ? '隐藏的图片只会出现在这里。' : filter === 'favorites' ? '收藏喜欢的图片，在这里随时找回。' : online ? '正在加载你的图片…' : '连接 ChatGPT 后，你的图片会出现在这里。';
  $('grid-empty').hidden = Boolean(visible.length); $('grid-empty-text').textContent = emptyText;
  $('sidebar-empty').hidden = Boolean(visible.length); $('sidebar-empty').textContent = emptyText;
  for (const prefix of ['', 'grid-']) {
    $(`${prefix}all-count`).textContent = visibleImages(images, 'all', hiddenIds).length;
    $(`${prefix}favorite-count`).textContent = images.filter(image => image.favorite && !hiddenIds.has(image.id)).length;
    $(`${prefix}hidden-count`).textContent = visibleImages(images, 'hidden', hiddenIds).length;
    for (const value of ['all', 'favorites', 'hidden']) {
      $(`${prefix}filter-${value}`).classList.toggle('active', filter === value);
      $(`${prefix}filter-${value}`).setAttribute('aria-pressed', String(filter === value));
    }
  }
  $('list-label').textContent = filter === 'hidden' ? '隐藏的图片' : filter === 'favorites' ? '收藏的图片' : '最近的图片';
  updateControls(); updateGridSelection(); updateEmptyState();
}

function updateGridSelection() {
  const active = gridSelection.active, busy = Boolean(bulkJob), count = gridSelection.ids.size;
  document.body.classList.toggle('grid-selecting', active);
  $('grid-tools-normal').inert = active; $('grid-selection-tools').inert = !active;
  $('grid-select').disabled = !account || !list().length;
  $('grid-selection-count').textContent = busy ? `${bulkJob.verb} ${bulkJob.done} / ${bulkJob.total}` : `已选 ${count} 张`;
  const chosen = list().filter(image => gridSelection.ids.has(image.id));
  $('grid-select-all').disabled = busy || !list().length || count === list().length;
  $('grid-clear-selection').disabled = busy || !count;
  $('grid-hide-selected').disabled = busy || !count;
  const hideLabel = filter === 'hidden' ? '取消隐藏' : '隐藏';
  $('grid-hide-selected').querySelector('span').textContent = hideLabel;
  $('grid-hide-selected').title = $('grid-hide-selected').ariaLabel = hideLabel;
  const favored = count && chosen.every(image => image.favorite);
  $('grid-favorite-selected').disabled = busy || !count || favored;
  $('grid-favorite-selected').querySelector('span').textContent = favored ? '已收藏' : '收藏';
  $('grid-favorite-selected').title = $('grid-favorite-selected').ariaLabel = favored ? '已收藏' : '收藏';
  $('grid-unfavorite-selected').disabled = busy || !chosen.some(image => image.favorite);
  $('grid-selection-done').hidden = busy; $('grid-selection-stop').hidden = !busy;
  $('grid-selection-stop').disabled = Boolean(bulkJob?.stopped);
  $('grid-selection-stop').textContent = bulkJob?.stopped ? '停止中' : '停止';
  $('grid-open-viewer').disabled = active || !list().length;
  for (const prefix of ['', 'grid-']) for (const scope of ['all','favorites','hidden']) $(`${prefix}filter-${scope}`).disabled = busy;
  gallery.selectionChanged();
}

async function bulkFlags(kind, value) {
  if (!gridSelection.active || !gridSelection.ids.size || bulkJob || !account) return;
  const ids = [...gridSelection.ids], targetAccount = account;
  const verb = kind === 'hidden' ? value ? '隐藏' : '取消隐藏' : value ? '收藏' : '取消收藏';
  const job = { account: targetAccount, verb, total: ids.length, done: 0, stopped: false, images: new Map() };
  bulkJob = job; gridSelection.locked = true; reloadSequence++; window.viewerMenus?.close(); updateGridSelection();
  const result = await runBulk({ ids, stopped: () => job.stopped || bulkJob !== job || account !== targetAccount,
    apply: async chunk => {
      const response = await rpc('bulk-flags', { account: targetAccount, ids: chunk, kind, value });
      for (const image of response.images || []) job.images.set(image.id, image);
      return response;
    }, progress: result => {
      job.done = result.succeeded.length + result.failed.length;
      if (bulkJob === job && account === targetAccount) updateGridSelection();
    } });
  if (bulkJob !== job || account !== targetAccount) return;
  const previous = list(), succeeded = new Set(result.succeeded);
  if (kind === 'hidden') {
    hiddenIds = new Set(hiddenIds);
    for (const id of succeeded) { if (value) hiddenIds.add(id); else hiddenIds.delete(id); }
  } else images = images.map(image => job.images.get(image.id) || image);
  gridSelection.complete(result.succeeded); gridSelection.locked = false; bulkJob = null;
  // One animation at completion; broadcasts during each chunk must not rebuild the grid.
  bulkAnimationUntil = performance.now() + 240;
  renderList(true, true); reconcileHiddenSelection(previous); saveView();
  const parts = [`${verb} ${result.succeeded.length} 张`];
  if (result.failed.length) parts.push(`${result.failed.length} 张失败，仍选中可重试`);
  if (result.pending.length) parts.push(`${result.pending.length} 张未处理`);
  if (kind === 'favorite' && value && result.succeeded.length) parts.push('原图缓存独立进行');
  status(parts.join(' · ')); queueReload(); updateStorage().catch(() => {});
}

function changeLayout(value) {
  if (bulkJob) return;
  if (value !== 'grid') gridSelection.exit();
  gallery.setActive(false); sidebarGallery.setActive(false);
  closeViewerPanel(false);
  layout = value; document.body.classList.toggle('grid-layout', layout === 'grid');
  gallery.setActive(layout === 'grid'); sidebarGallery.setActive(layout === 'viewer' && !sidebarHidden);
  if (layout === 'viewer') $('notice-slot').append($('status')); else document.body.append($('status'));
  requestViewerLayout(); revealControls(); saveView();
}
function openViewer(id) {
  if (gridSelection.active) return;
  id ||= list().some(image => image.id === selectedId) ? selectedId : list()[0]?.id;
  if (!id) return;
  changeLayout('viewer'); sidebarGallery.scrollToId(id); select(id);
}
function returnToGrid() {
  loadSequence++; changeLayout('grid');
  mainImage.hidden = true; width = 0; height = 0;
  saveView(true)?.catch(() => {});
  rpc('view-hold', { account, id: null }).catch(() => {});
  $('grid-scroll').focus({ preventScroll: true });
}
function updateControls() {
  const image = current(), visible = list(), index = visible.findIndex(value => value.id === selectedId);
  $('grid-open-viewer').disabled = gridSelection.active || !visible.length;
  $('previous').disabled = !image || !visible.length || index === 0;
  $('next').disabled = !image || !visible.length || index === visible.length - 1;
  $('favorite').disabled = !image;
  $('hide-image').disabled = !image || hiddenPending.has(`${account}:${image?.id}`);
  $('hide-image-label').textContent = filter === 'hidden' ? '取消隐藏' : '隐藏图片';
  $('hide-image').title = $('hide-image').ariaLabel = filter === 'hidden' ? '取消隐藏' : '隐藏图片';
  $('locate-all').hidden = filter !== 'favorites' || !image || (image.deleted && !image.localOriginal);
  $('copy-prompt').disabled = !image?.conversationId || Boolean(promptJob);
  const canEdit = Boolean(image?.conversationId && image?.fileId && !image.deleted);
  $('toggle-edit').disabled = !canEdit;
  if (!canEdit && viewerPanel === 'edit') closeViewerPanel(false);
  $('describe-edits').hidden = !canEdit || viewerPanel !== 'edit';
  $('submit-edit').disabled = !image || !online || Boolean(editJob) || !$('edit-prompt').value.trim();
  $('favorite').classList.toggle('favorited', Boolean(image?.favorite));
  $('menu-favorite').disabled = !image;
  $('menu-favorite').querySelector('span').textContent = image?.favorite ? '取消收藏' : '收藏图片';
  $('favorite').setAttribute('aria-label', image?.favorite ? '取消收藏' : '收藏图片');
  $('favorite').setAttribute('aria-pressed', String(Boolean(image?.favorite)));
  $('favorite').title = image?.favorite ? '取消收藏（F）' : '收藏图片（F）';
  $('conversation').disabled = !image?.conversationId;
  $('conversation').hidden = Boolean(image && !image.conversationId);
  $('download').disabled = !currentURL || !width;
  for (const id of ['zoom-in', 'zoom-out', 'fit', 'actual-size', 'toggle-zoom', 'menu-zoom']) $(id).disabled = !width;
  $('image-position').textContent = image ? index >= 0 ? `${index + 1} / ${visible.length}` : '当前图片已移出列表' : '';
  $('favorite-status').textContent = image?.favorite ? image.saved ? '已收藏 · 已保存在本地' : '已收藏 · 尚未保存原图' : '';
  if (image) {
    $('image-title').textContent = image.title;
    $('image-meta').textContent = [displayDate(image.createdAt), width && `${width} × ${height}`, image.deleted && '来源已删除'].filter(Boolean).join(' · ');
  }
  $('floating-title').textContent = image?.title || '';
  $('floating-meta').textContent = image ? $('image-meta').textContent : '';
  document.querySelector('.preview-title').hidden = !image;
}
function applyTransform() {
  if (!width) return;
  transform = clampTransform(transform, width, height, viewport.clientWidth, viewport.clientHeight);
  mainImage.style.transform = `translate(-50%, -50%) translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
  $('actual-size').textContent = `${Math.round(transform.scale * 100)}%`;
  const percentage = $('zoom-percentage');
  if (percentage) percentage.textContent = $('actual-size').textContent;
}
function fit() {
  if (!width) return;
  viewMode = 'fit';
  transform = { scale: fitScale(width, height, viewport.clientWidth, viewport.clientHeight), x: 0, y: 0 };
  applyTransform(); saveView();
}
function zoom(scale, point = { x: 0, y: 0 }) {
  if (!width) return;
  viewMode = 'custom';
  transform = zoomAt(transform, scale, point); applyTransform(); saveView();
}
function viewportPoint(event) {
  const rect = viewport.getBoundingClientRect();
  return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
}
async function select(id, restoredTransform = null) {
  list(); const image = imageById.get(id);
  if (!image || hiddenIds.has(id) !== (filter === 'hidden')) return;
  if (id !== selectedId && viewerPanel === 'edit') closeViewerPanel(false);
  const sequence = ++loadSequence, targetAccount = account;
  selectedId = id; selectedImage = { ...image }; width = 0; height = 0;
  $('edit-prompt').value = editDrafts.get(`${account}:${id}`) || ''; resizeEditPrompt();
  const lease = originalCache.acquire(targetAccount, image, { alive: () => sequence === loadSequence && targetAccount === account && layout === 'viewer' });
  $('empty-state').hidden = true; $('image-error').hidden = true;
  // A decoded hit is mounted synchronously in this click/key event: no spinner,
  // no native transfer and no second decode before the next painted frame.
  if (!lease.resource) { mainImage.hidden = true; $('image-loading').hidden = false; viewport.classList.remove('has-image'); }
  sidebarGallery.setImages(list(), id); updateControls();
  try {
    const resource = lease.resource || await lease.ready;
    if (sequence !== loadSequence || targetAccount !== account || layout !== 'viewer') { lease.release(); return; }
    if (!resource) throw new Error('原图加载已中断，请重试。');
    const previousLease = originalLease; originalLease = lease;
    if (mainImage !== resource.image) { mainImage.replaceWith(resource.image); mainImage = resource.image; }
    mainImage.id = 'main-image'; mainImage.className = 'main-image'; mainImage.draggable = false; mainImage.alt = image.title;
    currentURL = resource.url; width = resource.width; height = resource.height;
    previousLease?.release();
    gallery.measure(id, width, height); requestViewerLayout();
    transform = restoredTransform || { scale: fitScale(width, height, viewport.clientWidth, viewport.clientHeight), x: 0, y: 0 };
    if (!restoredTransform) viewMode = 'fit';
    mainImage.hidden = false; $('image-loading').hidden = true; viewport.classList.add('has-image');
    applyTransform(); updateControls(); saveView();
    // Prepare the nearest cached originals after the current frame. Preserve
    // existing neighbor downloads, but the new decoded preload is local only.
    requestAnimationFrame(() => {
      if (sequence !== loadSequence || targetAccount !== account || layout !== 'viewer') return;
      const index = list().findIndex(value => value.id === id);
      for (const neighbor of [list()[index - 1], list()[index + 1]].filter(Boolean)) {
        originalCache.preload(targetAccount, neighbor,
          () => targetAccount === account && sequence === loadSequence && layout === 'viewer').catch(() => {});
      }
      for (const neighbor of adjacentImages(list(), id)) {
        if (neighbor.localOriginal || neighbor.saved || originalCache.hasFile(targetAccount, neighbor.id)) continue;
        schedule(() => targetAccount === account && !originalCache.hasFile(targetAccount, neighbor.id)
          ? rpc('asset', { account: targetAccount, id: neighbor.id, kind: 'original' }) : null).catch(() => {});
      }
    });
  } catch (error) {
    lease.release();
    if (sequence !== loadSequence || targetAccount !== account) return;
    $('image-loading').hidden = true; $('image-error-text').textContent = error.message; $('image-error').hidden = false;
    updateControls();
  }
}

function next(delta) {
  const id = moveSelection(list(), selectedId, delta, current()?.createdAt);
  if (id && id !== selectedId) {
    select(id); sidebarGallery.scrollToId(id);
  }
}
async function toggleFavorite(id = selectedId) {
  list(); const image = imageById.get(id) || (id === selectedId ? selectedImage : null); if (!image) return;
  const targetAccount = account;
  try {
    const updated = await rpc('favorite', { account: targetAccount, id: image.id, favorite: !image.favorite });
    if (targetAccount !== account) return;
    images = images.map(value => value.id === updated.id ? updated : value);
    if (selectedId === updated.id) selectedImage = updated;
    renderList(); saveView(); await updateStorage();
  } catch (error) { status(error.message); }
}
function clearSelection() {
  loadSequence++; selectedId = null; selectedImage = null; width = height = 0;
  currentURL = null; mainImage.hidden = true;
  $('image-loading').hidden = $('image-error').hidden = true;
  $('empty-state').hidden = false; viewport.classList.remove('has-image');
  $('image-title').textContent = '你的图片，随时浏览。'; $('image-meta').textContent = '';
  rpc('view-hold', { account, id: null }).catch(() => {});
}
function reconcileHiddenSelection(previous = []) {
  if (!selectedId || current()) return;
  const index = Math.max(0, previous.findIndex(image => image.id === selectedId));
  const image = list()[Math.min(index, list().length - 1)];
  clearSelection();
  if (image && layout === 'viewer') { select(image.id); sidebarGallery.scrollToId(image.id); }
  updateControls(); updateEmptyState();
}
async function toggleHidden(id = selectedId) {
  const targetAccount = account, key = `${account}:${id}`;
  if (!id || hiddenPending.has(key)) return false;
  hiddenPending.add(key); updateControls();
  try {
    const result = await rpc('hidden', { account: targetAccount, id, hidden: !hiddenIds.has(id) });
    if (account !== targetAccount) return false;
    const previous = list();
    hiddenIds = new Set(hiddenIds);
    if (result.hidden) hiddenIds.add(id); else hiddenIds.delete(id);
    renderList(true, true); reconcileHiddenSelection(previous); saveView();
    return true;
  } catch (error) { status(error.message); return false; }
  finally { hiddenPending.delete(key); updateControls(); }
}
function locateAll(id = selectedId) {
  list(); const image = imageById.get(id);
  if (filter !== 'favorites' || !image || (image.deleted && !image.localOriginal) || hiddenIds.has(id)) return;
  changeFilter('all'); returnToGrid();
  gallery.scrollToId(id, true, true); saveView(true)?.catch(() => {});
}
function copyPrompt() {
  const image = current(), targetAccount = account;
  if (!image?.conversationId || promptJob) return;
  const key = `${account}:${image.id}`, job = {}; promptJob = job; updateControls();
  // Start clipboard.write during this click. Safari keeps the user gesture
  // while ClipboardItem waits for its data Promise, including the chat request.
  const textPromise = (promptCache.has(key) ? Promise.resolve(promptCache.get(key)) : rpc('prompt', { account, id: image.id }).then(result => result.text))
    .then(text => {
      if (account !== targetAccount) throw new Error('账号已切换，复制已取消。');
      if (typeof text !== 'string' || !text.trim()) throw new Error('无法取得该图片的 prompt，请打开原聊天。');
      promptCache.set(key, text);
      if (promptCache.size > 200) promptCache.delete(promptCache.keys().next().value);
      return text;
    });
  textPromise.catch(() => {});
  let writing;
  try {
    if (globalThis.ClipboardItem && navigator.clipboard?.write) {
      const data = textPromise.then(text => new Blob([text], { type: 'text/plain' })); data.catch(() => {});
      writing = navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
    } else if (promptCache.has(key) && navigator.clipboard?.writeText) {
      writing = navigator.clipboard.writeText(promptCache.get(key));
    } else {
      writing = textPromise.then(text => {
        $('prompt-text').value = text; showDialog('prompt-dialog');
        throw new Error('请手动复制已显示的 prompt。');
      });
    }
  } catch (error) { writing = Promise.reject(error); }
  Promise.resolve(writing).then(() => {
    if (account === targetAccount) status('prompt 已复制');
  }).catch(async error => {
    try { await textPromise; } catch (lookupError) { error = lookupError; }
    if (account === targetAccount) status(promptCache.has(key) && !$('prompt-dialog').open
      ? '浏览器未完成复制，请再次点击“复制 prompt”重试。' : error.message);
  }).finally(() => { if (promptJob === job) promptJob = null; updateControls(); });
}
async function updateStorage() {
  const targetAccount = account, sequence = ++storageSequence;
  const usage = await rpc('cache-status', { account: targetAccount });
  if (targetAccount !== account || sequence !== storageSequence) return;
  const storage = `缓存 ${formatBytes(usage.cache)} · 收藏 ${formatBytes(usage.favorites)}`;
  for (const id of ['storage-usage', 'settings-storage', 'grid-storage']) $(id).textContent = storage;
  const display = cacheDisplay(usage);
  for (const id of ['cache-progress', 'grid-cache-progress', 'settings-progress', 'viewer-cache-progress']) $(id).textContent = display.text;
  for (const id of ['sidebar-cache-bar', 'grid-cache-bar']) {
    if (display.percent === null) $(id).removeAttribute('value'); else $(id).value = display.percent;
    $(id).classList.toggle('cache-paused', usage.phase === 'paused');
    $(id).setAttribute('aria-valuetext', display.text);
  }
  $('settings-error').textContent = usage.error || ''; $('settings-error').hidden = !usage.error;
  $('cache-mode').value = usage.cacheMode || 'full';
  $('pause-cache').hidden = Boolean(usage.paused); $('resume-cache').hidden = !usage.paused;
  $('local-retained').textContent = `本地保留 ${usage.retained || 0} 张 · 来源已删除，仍可查看`;
  const migration = usage.migration || {};
  const phases = { pending: '等待迁移', copying: '正在迁移', verifying: '正在核对原图', paused: '迁移已暂停', verified: '迁移已核对完成，旧副本仍保留', cleaned: '旧原图副本已清理', empty: '当前扩展存储中没有旧原图；其它签名版本的旧存储需单独导入', preview: '预览使用合成数据' };
  $('migration-status').textContent = [phases[migration.phase] || '', migration.total ? `${migration.completed || 0} / ${migration.total} 张` : '', migration.error].filter(Boolean).join(' · ');
  $('retry-migration').hidden = !['paused', 'pending'].includes(migration.phase) || Boolean(migration.external);
  $('clean-legacy').hidden = migration.phase !== 'verified';
  $('clean-legacy').textContent = migration.external ? '清理旧存储…' : '清理旧存储';
  $('retry-cache').disabled = !targetAccount;
}
function snapshotView() {
  const sidebar = sidebarGallery.state();
  filterStates = { ...filterStates, [filter]: { grid: gallery.state(), sidebar } };
  return { key: account, selectedId, filter, scrollTop: sidebar.scrollTop, sidebarAnchor: sidebar.anchor,
    transform: { ...transform }, viewMode, sidebarHidden, layout, gridSize, gridState: gallery.state(), filterStates };
}
function saveView(immediate = false) {
  if (!account || restoring) return;
  clearTimeout(saveTimer);
  const value = snapshotView();
  if (immediate) return putValue('views', value);
  saveTimer = setTimeout(() => putValue('views', value).catch(() => {}), 180);
}
async function reloadImages() {
  if (bulkJob) return;
  if (performance.now() < bulkAnimationUntil) { queueReload(bulkAnimationUntil - performance.now()); return; }
  const sequence = ++reloadSequence, targetAccount = account;
  if (!targetAccount) return;
  const [records, hidden] = await Promise.all([getImages(targetAccount), getHiddenIds(targetAccount)]);
  if (sequence !== reloadSequence || targetAccount !== account) return;
  const previous = list(); images = records; hiddenIds = hidden;
  if (images.some(image => image.id === selectedId)) selectedImage = { ...images.find(image => image.id === selectedId) };
  renderList();
  reconcileHiddenSelection(previous);
  if (layout === 'viewer' && !selectedId && list().length) await select(list()[0].id);
  await updateStorage();
}
async function restoreAccount(identity) {
  if (bulkJob) bulkJob.stopped = true;
  bulkJob = null; gridSelection.locked = false; gridSelection.exit();
  loadSequence++; reloadSequence++; clearTimeout(saveTimer); restoring = true;
  if (account) await putValue('views', snapshotView());
  account = identity.id; images = []; hiddenIds = new Set(); filterStates = {}; promptCache.clear(); editDrafts.clear();
  $('edit-prompt').value = ''; resizeEditPrompt();
  selectedId = null; selectedImage = null; width = 0; height = 0;
  clearImageURLs(); mainImage.hidden = true; $('image-error').hidden = true; $('image-loading').hidden = true;
  viewport.classList.remove('has-image'); $('empty-state').hidden = false;
  if (account) {
    images = await getImages(account);
    hiddenIds = await getHiddenIds(account);
    const saved = await getValue('views', account);
    viewMode = saved?.viewMode === 'custom' ? 'custom' : 'fit';
    transform = saved?.transform || { scale: 1, x: 0, y: 0 };
    sidebarHidden = typeof saved?.sidebarHidden === 'boolean' ? saved.sidebarHidden : true;
    filter = ['all', 'favorites', 'hidden'].includes(saved?.filter) ? saved.filter : 'all';
    filterStates = saved?.filterStates || { [filter]: { grid: saved?.gridState || {}, sidebar: { scrollTop: saved?.scrollTop, anchor: saved?.sidebarAnchor } } };
    gridSize = Object.hasOwn(GRID_SIZES, saved?.gridSize) ? saved.gridSize : 'medium';
    updateGridSize();
    renderList(false);
    const restoredId = list().some(image => image.id === saved?.selectedId) ? saved.selectedId : list()[0]?.id;
    selectedId = restoredId || null; selectedImage = imageById.get(selectedId) || null;
    changeLayout(saved?.layout === 'viewer' ? 'viewer' : 'grid'); updateSidebar();
    gallery.restore(filterStates[filter]?.grid || {});
    sidebarGallery.restore(filterStates[filter]?.sidebar || {});
    if (restoredId && layout === 'viewer') await select(restoredId, saved?.selectedId === restoredId ? saved.transform : null);
    else rpc('view-hold', { account, id: null }).catch(() => {});
    await updateStorage();
  } else { filter = 'all'; renderList(false); changeLayout('grid'); }
  restoring = false;
}
function updateEmptyState() {
  $('grid-connect').hidden = online || Boolean(list().length);
  if (selectedId) return;
  $('empty-title').textContent = online ? syncing ? '正在加载你的图片' : '这里还没有图片' : '连接你的 ChatGPT 图片库';
  $('empty-text').textContent = online ? '图片加载后会出现在左侧，历史图片会逐步补齐。' : '在当前浏览器登录 ChatGPT，即可开始浏览。缓存和收藏保存在本地。';
  $('connect').hidden = online;
}
async function refresh() {
  if (syncing || document.hidden) return;
  const sequence = ++refreshSequence;
  syncing = true; $('refresh').classList.add('busy'); $('grid-refresh').classList.add('busy');
  try {
    const identity = await rpc('connect');
    if (sequence !== refreshSequence) return;
    online = identity.online;
    if (account !== identity.id) await restoreAccount(identity);
    $('account-name').textContent = identity.name || 'ChatGPT';
    $('grid-account').textContent = `${identity.name || 'ChatGPT'}${online ? '' : ' · 离线'}`;
    $('account-avatar').textContent = (identity.name || 'C').slice(0, 1).toUpperCase();
    $('connection-status').textContent = online ? '自动刷新已开启' : '离线 · 本地图片仍可查看';
    $('connection-dot').classList.toggle('online', online);
    updateEmptyState();
    if (!online || !account) { status(identity.error); return; }
    status('');
    await rpc('sync', { account });
    await reloadImages();
    $('connection-status').textContent = `刚刚更新 · 每 30 秒刷新`;
    rpc('retry-favorites', { account }).catch(() => {});
  } catch (error) { status(error.message); }
  finally { syncing = false; $('refresh').classList.remove('busy'); $('grid-refresh').classList.remove('busy'); updateEmptyState(); }
}
function changeFilter(value) {
  if (bulkJob || filter === value) return;
  gridSelection.exit(); window.viewerMenus?.close();
  const previous = list();
  filterStates = { ...filterStates, [filter]: { grid: gallery.state(), sidebar: sidebarGallery.state() } };
  filter = value; renderList(false);
  gallery.restore(filterStates[filter]?.grid || {}); sidebarGallery.restore(filterStates[filter]?.sidebar || {});
  reconcileHiddenSelection(previous);
  saveView();
}
$('filter-all').addEventListener('click', () => changeFilter('all'));
$('filter-favorites').addEventListener('click', () => changeFilter('favorites'));
$('grid-filter-all').addEventListener('click', () => changeFilter('all'));
$('grid-filter-favorites').addEventListener('click', () => changeFilter('favorites'));
$('filter-hidden').addEventListener('click', () => changeFilter('hidden'));
$('grid-filter-hidden').addEventListener('click', () => changeFilter('hidden'));
$('return-grid').addEventListener('click', returnToGrid);
$('grid-open-viewer').addEventListener('click', () => openViewer());
$('grid-select').addEventListener('click', () => { gridSelection.enter(); updateGridSelection(); $('grid-selection-done').focus({ preventScroll: true }); });
$('grid-selection-done').addEventListener('click', () => { gridSelection.exit(); updateGridSelection(); $('grid-select').focus({ preventScroll: true }); });
$('grid-select-all').addEventListener('click', () => {
  gridSelection.all();
  updateGridSelection();
});
$('grid-clear-selection').addEventListener('click', () => { gridSelection.clear(); updateGridSelection(); });
$('grid-hide-selected').addEventListener('click', () => bulkFlags('hidden', filter !== 'hidden'));
$('grid-favorite-selected').addEventListener('click', () => bulkFlags('favorite', true));
$('grid-unfavorite-selected').addEventListener('click', () => bulkFlags('favorite', false));
$('grid-selection-stop').addEventListener('click', () => { if (bulkJob) { bulkJob.stopped = true; updateGridSelection(); } });
function updateGridSize() {
  gallery.setSize(gridSize);
  for (const value of Object.keys(GRID_SIZES)) {
    $(`grid-size-${value}`).classList.toggle('active', value === gridSize);
    $(`grid-size-${value}`).setAttribute('aria-pressed', String(value === gridSize));
  }
}
for (const size of Object.keys(GRID_SIZES)) $(`grid-size-${size}`).addEventListener('click', () => { gridSize = size; updateGridSize(); saveView(); });
function updateSidebar() {
  document.body.classList.toggle('sidebar-hidden', sidebarHidden);
  $('toggle-sidebar').setAttribute('aria-expanded', String(!sidebarHidden));
  $('toggle-sidebar').setAttribute('aria-label', sidebarHidden ? '展开缩略图栏' : '收起缩略图栏');
  $('toggle-sidebar').title = sidebarHidden ? '展开缩略图栏' : '收起缩略图栏';
  sidebarGallery.setActive(layout === 'viewer' && !sidebarHidden);
  requestViewerLayout();
}
$('toggle-sidebar').addEventListener('click', () => { sidebarHidden = !sidebarHidden; updateSidebar(); saveView(); });
$('refresh').addEventListener('click', refresh);
$('grid-refresh').addEventListener('click', refresh);
$('previous').addEventListener('click', () => next(-1)); $('next').addEventListener('click', () => next(1));
$('favorite').addEventListener('click', () => toggleFavorite());
$('hide-image').addEventListener('click', () => toggleHidden());
$('locate-all').addEventListener('click', () => locateAll());
$('copy-prompt').addEventListener('click', copyPrompt);
$('fit').addEventListener('click', fit); $('actual-size').addEventListener('click', () => zoom(1));
$('zoom-in').addEventListener('click', () => zoom(transform.scale * 1.25)); $('zoom-out').addEventListener('click', () => zoom(transform.scale / 1.25));
$('retry').addEventListener('click', () => selectedId && select(selectedId, transform));
$('help').addEventListener('click', () => showDialog('help-dialog'));
$('settings').addEventListener('click', () => { showDialog('settings-dialog'); updateStorage().catch(error => status(error.message)); });
$('grid-settings').addEventListener('click', () => $('settings').click());
$('grid-help').addEventListener('click', () => $('help').click());
$('grid-connect').addEventListener('click', () => $('connect').click());
$('toggle-edit').addEventListener('click', () => viewerPanel === 'edit' ? closeViewerPanel() : openViewerPanel('edit'));
$('menu-favorite').addEventListener('click', () => toggleFavorite());
for (const button of document.querySelectorAll('[data-close-viewer-panel]')) button.addEventListener('click', () => closeViewerPanel());
for (const id of ['help-dialog', 'settings-dialog', 'prompt-dialog']) $(id).addEventListener('close', () => {
  if (viewerPanel === id) viewerPanel = null;
});
$('viewer-refresh').addEventListener('click', refresh);
$('edit-prompt').addEventListener('focus', revealControls);
$('edit-prompt').addEventListener('blur', revealControls);
let viewerDimensions = '';
const toolbarObserver = new ResizeObserver(() => {
  const dimensions = `${document.body.clientWidth}:${document.body.clientHeight}:${$('controls-rail').offsetHeight}`;
  if (dimensions !== viewerDimensions) { viewerDimensions = dimensions; requestViewerLayout(); }
});
toolbarObserver.observe(document.body); toolbarObserver.observe($('controls-rail'));
$('cache-mode').addEventListener('change', async event => {
  event.target.disabled = true;
  try { await rpc('set-settings', { account, cacheMode: event.target.value }); await updateStorage(); }
  catch (error) { status(error.message); }
  finally { event.target.disabled = false; }
});
$('retry-cache').addEventListener('click', async () => {
  try { await rpc('retry-cache', { account }); await updateStorage(); }
  catch (error) { status(error.message); }
});
for (const type of ['pause-cache', 'resume-cache', 'retry-migration', 'clean-legacy']) $(type).addEventListener('click', async event => {
  event.target.disabled = true;
  try {
    const result = await rpc(type, { account });
    if (result?.receipt) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.receipt)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'images-manager-migration-receipt.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status('核对凭据已下载。在旧存储导出工具中选择此文件，再点击清理；旧存储现在仍保留。');
    }
    await updateStorage();
  }
  catch (error) { status(error.message); }
  finally { event.target.disabled = false; }
});
$('connect').addEventListener('click', () => extension?.tabs ? extension.tabs.create({ url: 'https://chatgpt.com/images' }) : window.open('https://chatgpt.com/images', '_blank', 'noopener'));
$('conversation').addEventListener('click', () => {
  const image = current(); if (!image?.conversationId || !/^[\w-]+$/.test(image.conversationId)) return;
  const url = `https://chatgpt.com/c/${encodeURIComponent(image.conversationId)}`;
  if (extension?.tabs) extension.tabs.create({ url }); else window.open(url, '_blank', 'noopener');
});
$('download').addEventListener('click', async () => {
  if (!currentURL || !width) return;
  const anchor = document.createElement('a'); anchor.href = currentURL;
  const mime = (await (await fetch(currentURL)).blob()).type;
  const suffix = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[mime] || 'png';
  anchor.download = `${(current()?.title || 'ChatGPT 图片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.${suffix}`;
  anchor.click();
});
document.addEventListener('keydown', event => {
  if (window.viewerMenus?.isOpen() || event.defaultPrevented) return;
  if (event.key === 'Escape' && viewerPanel) { event.preventDefault(); closeViewerPanel(); return; }
  if (event.target.closest('input,textarea,select,[contenteditable]') || $('help-dialog').open || $('settings-dialog').open || $('prompt-dialog').open) return;
  if (layout === 'grid' && gridSelection.active) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault(); gridSelection.all(); updateGridSelection(); return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'Escape') { event.preventDefault(); if (!bulkJob) $('grid-selection-done').click(); }
      else if (event.key.toLowerCase() === 'f' && !event.repeat) { event.preventDefault(); $('grid-favorite-selected').click(); }
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (layout === 'grid') {
    const id = event.target.closest('.grid-card')?.dataset.id;
    if (id && ['f', 'F'].includes(event.key) && !event.repeat) { event.preventDefault(); toggleFavorite(id); }
    return;
  }
  const actions = { ArrowLeft: () => next(-1), ArrowRight: () => next(1), f: () => toggleFavorite(), F: () => toggleFavorite(), '0': fit, '1': () => zoom(1), Escape: returnToGrid };
  if (actions[event.key]) {
    event.preventDefault();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') hideControls(true);
    if (!event.repeat || event.key.startsWith('Arrow')) actions[event.key]();
  }
});
viewport.addEventListener('wheel', event => {
  if (!width || event.target.closest('button')) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) zoom(transform.scale * Math.exp(-event.deltaY * .01), viewportPoint(event));
  else {
    viewMode = 'custom';
    const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    transform.x -= event.deltaX * factor; transform.y -= event.deltaY * factor; applyTransform(); saveView();
  }
}, { passive: false });
viewport.addEventListener('gesturestart', event => { event.preventDefault(); gestureStart = { scale: transform.scale, point: viewportPoint(event) }; }, { passive: false });
viewport.addEventListener('gesturechange', event => { event.preventDefault(); if (gestureStart) zoom(gestureStart.scale * event.scale, gestureStart.point); }, { passive: false });
viewport.addEventListener('gestureend', event => { event.preventDefault(); gestureStart = null; }, { passive: false });
viewport.addEventListener('pointerdown', event => {
  if (!width || event.button !== 0 || event.target.closest('button')) return;
  dragStart = { clientX: event.clientX, clientY: event.clientY, x: transform.x, y: transform.y };
  viewMode = 'custom';
  viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
});
viewport.addEventListener('pointermove', event => { if (dragStart) { transform.x = dragStart.x + event.clientX - dragStart.clientX; transform.y = dragStart.y + event.clientY - dragStart.clientY; applyTransform(); } });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, () => { dragStart = null; viewport.classList.remove('dragging'); saveView(); });
new ResizeObserver(() => { if (width && layout === 'viewer') {
  if (viewMode === 'fit') transform = { scale: fitScale(width, height, viewport.clientWidth, viewport.clientHeight), x: 0, y: 0 };
  applyTransform(); saveView();
} }).observe(viewport);
let lastMousePosition = null;
function hideControls(keyboard = false) {
  clearTimeout(chromeTimer);
  document.body.classList.add('controls-idle');
  document.body.classList.toggle('keyboard-browsing', keyboard);
  if (viewerPanel === 'edit' && !editJob && !$('edit-prompt').value && !$('edit-panel').contains(document.activeElement)) closeViewerPanel(false);
}
function revealControls(event) {
  if (event?.type !== 'pointermove' || (event.pointerType && event.pointerType !== 'mouse')) return;
  const position = `${event.clientX}:${event.clientY}`;
  if (position === lastMousePosition) return;
  lastMousePosition = position;
  document.body.classList.remove('controls-idle', 'keyboard-browsing');
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => hideControls(), 2000);
}

function resizeEditPrompt() {
  $('edit-prompt').style.height = '24px';
}
$('edit-prompt').addEventListener('input', () => {
  const key = `${account}:${selectedId}`;
  if ($('edit-prompt').value) editDrafts.set(key, $('edit-prompt').value); else editDrafts.delete(key);
  resizeEditPrompt(); updateControls(); revealControls();
});
$('edit-prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('describe-edits').requestSubmit(); }
});
$('describe-edits').addEventListener('submit', async event => {
  event.preventDefault();
  const image = current(), prompt = $('edit-prompt').value.trim(), targetAccount = account;
  if (!image?.fileId || !image.conversationId || image.deleted || !online || !prompt || editJob) return;
  const job = { id: crypto.randomUUID(), imageId: image.id }; editJob = job; updateControls(); revealControls();
  $('submit-edit').classList.add('submitting'); status('正在打开 Describe edits…');
  try {
    await rpc('describe-edit', { account: targetAccount, id: image.id, prompt, jobId: job.id });
    if (account === targetAccount) {
      const key = `${account}:${image.id}`;
      if ((editDrafts.get(key) || '').trim() === prompt) {
        editDrafts.delete(key);
        if (selectedId === image.id) { $('edit-prompt').value = ''; resizeEditPrompt(); if (viewerPanel === 'edit') closeViewerPanel(false); }
      }
      status('Describe edits 已在新窗口提交');
    }
  } catch (error) { if (account === targetAccount) status(error.message); }
  finally { if (editJob === job) editJob = null; $('submit-edit').classList.remove('submitting'); updateControls(); }
});
document.addEventListener('pointermove', revealControls, { passive: true });
document.body.classList.add('controls-idle');
window.addEventListener('pagehide', () => { if (bulkJob) bulkJob.stopped = true; saveView(true); clearImageURLs(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else saveView(true); });
if (extension?.runtime?.onMessage) extension.runtime.onMessage.addListener(message => {
  if (message?.type !== 'library-event' || message.account !== account) return;
  if (message.event === 'asset-cached') {
    if (message.kind === 'original') {
      thumbnailCache.invalidatePreview(account, message.id);
    }
    gallery.refreshPreview(message.id); sidebarGallery.refreshPreview(message.id);
  } else if (message.event === 'hidden-updated') {
    if (!hiddenPending.has(`${account}:${message.id}`)) queueReload();
  } else if (message.event === 'updated') {
    $('load-progress').textContent = message.complete ? '' : message.loaded !== undefined ? `已加载 ${message.loaded}` : $('load-progress').textContent;
    queueReload();
  } else if (message.event === 'cache-progress') updateStorage().catch(() => {});
  else if (message.event === 'sync-error' || message.event === 'favorite-error') status(message.error);
});
window.viewerMenuBridge = {
  action(id) { $(id)?.click(); },
  prepare(id) { if (id === 'settings-dialog') updateStorage().catch(error => status(error.message)); },
  closeEditor() { if (viewerPanel === 'edit') closeViewerPanel(false); },
};
window.dispatchEvent(new Event('viewer-menu-ready'));

if (preview) {
  await (await import('./preview.js')).seedPreview();
  window.addEventListener('preview-library-event', event => {
    if (!event.detail?.hiddenId || !hiddenPending.has(`${account}:${event.detail.hiddenId}`)) queueReload();
  });
}
function queueReload(delay = 120) {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => { reloadTimer = null; reloadImages().catch(error => status(error.message)); }, delay);
}
setInterval(() => { if (!document.hidden) refresh(); }, 30000);
try {
  if (!preview && extension?.storage?.local) {
    const { lastAccount } = await extension.storage.local.get('lastAccount');
    if (lastAccount) await restoreAccount({ id: lastAccount });
  }
  await refresh();
} catch (error) { status(error.message); }
