// Run only in the localhost test-image preview with agent-browser eval --stdin.
(async () => {
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const waitFor = async condition => {
  const started = performance.now();
  while (!condition()) { if (performance.now() - started > 15000) throw new Error('UI timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
assert(location.hostname === '127.0.0.1' && location.search.includes('preview=1'), 'Preview only');
const { mergeLibrary, getValue, setFavorite } = await import('/db.js');
const { fixtureDimensions } = await import('/preview.js');
const host = document.querySelector('#grid-scroll');
const results = {}, urls = new Set([...document.querySelectorAll('img[src]')].map(node => node.src).filter(url => url.startsWith('blob:')));
let peakURLs = urls.size, peakCards = 0;
const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = blob => { const url = create(blob); urls.add(url); peakURLs = Math.max(peakURLs, urls.size); return url; };
URL.revokeObjectURL = url => { urls.delete(url); return revoke(url); };
const data = Array.from({ length: 30000 }, (_, i) => ({ id: `fixture-${i}`, title: `测试图片 ${i + 1}`, createdAt: Date.UTC(2026, 9, 7) - i * 60000, ...fixtureDimensions(i) }));
await mergeLibrary('preview-account', data, true);
for (const i of [0, 3, 6]) await setFavorite('preview-account', `fixture-${i}`, true);
window.dispatchEvent(new Event('preview-library-event'));
await waitFor(() => document.querySelector('#grid-all-count').textContent === '30000'); await frames();
const widths = [];
for (const size of ['small', 'medium', 'large']) {
  document.querySelector(`#grid-size-${size}`).click(); await frames();
  widths.push(document.querySelector('.grid-card').offsetWidth);
}
assert(widths[0] < widths[1] && widths[1] < widths[2], 'Three card sizes'); results.widths = widths;
const durations = [];
for (const size of ['small', 'medium', 'large']) {
 document.querySelector(`#grid-size-${size}`).click(); await frames();
 for (let i = 0; i < 30; i++) {
  const started = performance.now();
  host.scrollTop = 250000 + i * 2800;
  await frames(); durations.push(performance.now() - started);
  peakCards = Math.max(peakCards, document.querySelectorAll('.grid-card').length);
 }
}
assert(peakCards < 100, 'DOM must stay bounded');
const anchor = () => {
  const top = host.getBoundingClientRect().top;
  const nodes = [...document.querySelectorAll('.grid-card')].map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(x => x.rect.bottom >= top && x.rect.top <= top + 1).sort((a, b) => b.rect.top - a.rect.top);
  const card = nodes[0]; return { id: card.node.dataset.id, offset: card.rect.top - top };
};
const beforeSize = anchor(); document.querySelector('#grid-size-medium').click(); await frames();
let node = document.querySelector(`[data-id="${beforeSize.id}"]`);
assert(node && Math.abs(node.getBoundingClientRect().top - host.getBoundingClientRect().top - beforeSize.offset) < 2, 'Size preserves anchor');
const beforeRefresh = anchor();
await mergeLibrary('preview-account', [{ id: 'fixture-30000', title: '新增测试图片', createdAt: Date.UTC(2026, 9, 8), ...fixtureDimensions(0) }], false);
window.dispatchEvent(new Event('preview-library-event'));
await waitFor(() => document.querySelector('#grid-all-count').textContent === '30001'); await frames();
node = document.querySelector(`[data-id="${beforeRefresh.id}"]`);
assert(node && Math.abs(node.getBoundingClientRect().top - host.getBoundingClientRect().top - beforeRefresh.offset) < 2, 'Refresh preserves anchor');
const beforeViewer = host.scrollTop;
node.querySelector('.grid-open').click();
await waitFor(() => !document.querySelector('#main-image').hidden);
assert(!document.body.classList.contains('grid-layout'), 'Open existing viewer');
assert(document.querySelectorAll('.grid-card').length === 0, 'Hidden grid releases its cards');
assert(document.querySelectorAll('.virtual-thumbnail').length < 20, 'Sidebar is virtual');
document.querySelector('#return-grid').click(); await frames();
assert(document.body.classList.contains('grid-layout') && Math.abs(host.scrollTop - beforeViewer) < 2, 'Return preserves grid position');
assert(document.querySelectorAll('.virtual-thumbnail').length === 0, 'Hidden sidebar releases its cards');
document.querySelector('#grid-filter-favorites').click(); await frames();
assert(document.querySelectorAll('.grid-card').length === 3, 'Favorites filter');
const favoriteCount = document.querySelectorAll('.grid-card').length;
document.querySelector('.grid-favorite').click();
await waitFor(() => document.querySelector('#grid-favorite-count').textContent === String(favoriteCount - 1)); await frames();
assert(document.querySelectorAll('.grid-card').length === favoriteCount - 1, 'Unfavorite removes only that card');
document.querySelector('#grid-open-viewer').click();
await waitFor(() => !document.querySelector('#main-image').hidden);
assert(document.querySelector('#favorite').getAttribute('aria-pressed') === 'true', 'Viewer switch respects favorites filter');
document.querySelector('#return-grid').click(); await frames();
document.querySelector('#grid-filter-all').click(); await frames();
localStorage.setItem('previewCacheState', JSON.stringify({ running: true, activeAsset: { kind: 'original' } }));
document.querySelector('#grid-settings').click();
await waitFor(() => document.querySelector('#grid-cache-progress').textContent.includes('正在缓存原图'));
assert(document.querySelector('#grid-cache-bar').hasAttribute('value'), 'Known total has progress');
localStorage.setItem('previewCacheState', JSON.stringify({ running: true, scanning: true, activeAsset: { kind: 'thumbnail' } }));
document.querySelector('#retry-cache').click();
await waitFor(() => document.querySelector('#grid-cache-progress').textContent.includes('正在缓存缩略图'));
assert(!document.querySelector('#grid-cache-bar').hasAttribute('value'), 'Incomplete scan is indeterminate');
localStorage.setItem('previewCacheState', JSON.stringify({ phase: 'paused', failed: 2 })); document.querySelector('#retry-cache').click();
await waitFor(() => document.querySelector('#grid-cache-progress').textContent.includes('缓存已暂停'));
document.querySelector('#settings-dialog form button').click();
localStorage.removeItem('previewCacheState');
host.scrollTop = 200000; await frames();
await new Promise(resolve => setTimeout(resolve, 250));
const saved = await getValue('views', 'preview-account');
assert(saved.layout === 'grid' && saved.gridSize === 'medium' && saved.gridState.scrollTop > 100000, 'Grid state saved');
// URLs may outlive cards in the bounded decoded-thumbnail LRU. Memory eviction
// and retained-card safety are tested separately in thumbnail-cache.test.js.
results.peakCards = peakCards; results.peakURLs = peakURLs; results.liveURLs = urls.size;
results.twoFramesP95Ms = +durations.sort((a, b) => a - b)[Math.floor(durations.length * .95)].toFixed(1);
results.anchorRefresh = true; results.returnPosition = true; results.favorites = true; results.cacheProgress = true;
results.savedScrollTop = saved.gridState.scrollTop;
window.gridVerification = results;
return JSON.stringify(results);
})()
