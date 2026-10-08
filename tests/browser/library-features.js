// Run only in the localhost test-image preview with agent-browser eval --stdin.
(async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const until = async (predicate, message) => {
    const start = performance.now();
    while (!predicate()) { if (performance.now() - start > 15000) throw new Error(`Timeout: ${message}`); await wait(20); }
  };
  assert(location.hostname === '127.0.0.1' && location.search.includes('preview=1'), 'Test preview only');
  const db = await import('/db.js'), preview = await import('/preview.js'), $ = id => document.getElementById(id);
  const host = $('grid-scroll'), account = 'preview-account';
  if (!document.body.classList.contains('grid-layout')) $('return-grid').click();
  $('grid-filter-all').click();
  const images = Array.from({ length: 2000 }, (_, index) => ({ id: `fixture-${index}`, title: `测试图片 ${index}`,
    conversationId: 'preview-conversation', createdAt: Date.UTC(2026, 9, 7) - index * 60000, ...preview.fixtureDimensions(index) }));
  await db.mergeLibrary(account, images, true);
  for (let index = 0; index < 600; index += 3) await db.setFavorite(account, `fixture-${index}`, true);
  window.dispatchEvent(new Event('preview-library-event'));
  await until(() => $('grid-all-count').textContent === '2000', 'seed'); await frames();
  const anchor = () => {
    const top = host.getBoundingClientRect().top;
    return [...document.querySelectorAll('.grid-card')].map(node => ({ id: node.dataset.id, offset: node.getBoundingClientRect().top - top,
      bottom: node.getBoundingClientRect().bottom - top })).filter(item => item.bottom > 0 && item.offset <= 0).sort((a, b) => b.offset - a.offset)[0];
  };
  const matches = saved => { const node = document.querySelector(`.grid-card[data-id="${saved.id}"]`);
    return node && Math.abs(node.getBoundingClientRect().top - host.getBoundingClientRect().top - saved.offset) < 2; };
  host.scrollTop = 15000; await frames(); const all = anchor();
  $('grid-filter-favorites').click(); await frames(); host.scrollTop = 7000; await frames(); const favorites = anchor();
  $('grid-filter-all').click(); await frames(); assert(matches(all), 'All restores its anchor');
  $('grid-filter-favorites').click(); await frames(); assert(matches(favorites), 'Favorites restores its anchor');
  const card = document.querySelector(`.grid-card[data-id="${favorites.id}"]`);
  assert(!card.querySelector('.grid-locate').hidden, 'Favorite card offers locate');
  card.querySelector('.grid-locate').click(); await frames();
  assert($('grid-filter-all').ariaPressed === 'true', 'Locate switches to all');
  const located = document.querySelector(`.grid-card[data-id="${favorites.id}"]`);
  assert(located && Math.abs(located.getBoundingClientRect().top - host.getBoundingClientRect().top) < 2, 'Locate aligns the target image');
  $('grid-filter-favorites').click(); await frames(); assert(matches(favorites), 'Locate preserves outgoing favorite position');
  $('grid-filter-all').click(); await frames();
  const hiding = document.querySelector('.grid-card .grid-hide').closest('.grid-card').dataset.id;
  document.querySelector(`.grid-card[data-id="${hiding}"] .grid-hide`).click();
  await until(() => $('grid-hidden-count').textContent === '1', 'hide');
  assert((await db.getHiddenIds(account)).has(hiding), 'Hidden ID persisted');
  const animations = document.getAnimations().filter(animation => animation.effect.getTiming().duration === 200);
  assert(animations.length > 0, 'Hide has a bounded 200ms animation');
  await wait(240); await frames();
  assert(!document.querySelector(`.grid-card[data-id="${hiding}"]`), 'Hidden card leaves normal grid');
  $('grid-filter-hidden').click(); await frames();
  const hiddenCard = document.querySelector(`.grid-card[data-id="${hiding}"]`);
  assert(hiddenCard && hiddenCard.querySelector('.grid-locate').hidden, 'Hidden view has no locate action');
  hiddenCard.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden, 'hidden original');
  assert($('locate-all').hidden, 'Hidden viewer has no locate action');
  $('filter-all').click(); await until(() => !$('main-image').hidden, 'visible replacement');
  assert(!document.querySelector(`.virtual-thumbnail[data-id="${hiding}"]`), 'Normal sidebar excludes hidden');
  assert(!$('image-title').textContent.endsWith(hiding.split('-')[1]), 'Hidden original does not leak into normal viewer');
  const beforeHide = $('image-title').textContent;
  $('hide-image').click(); await until(() => $('hidden-count').textContent === '2' && $('image-title').textContent !== beforeHide, 'hide current advances');
  $('return-grid').click(); await frames(); $('grid-filter-hidden').click(); await frames();
  document.querySelector('.grid-hide').click(); await until(() => $('grid-hidden-count').textContent === '1', 'unhide'); await wait(240);
  assert(document.querySelectorAll('.grid-card').length === 1, 'Unhide removes only one hidden card');
  document.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden, 'last hidden opens');
  $('hide-image').click(); await until(() => $('hidden-count').textContent === '0', 'last unhide');
  assert($('main-image').hidden && !$('empty-state').hidden, 'Last hidden removal clears viewer');
  $('filter-favorites').click(); $('return-grid').click(); await frames();
  document.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden, 'prompt viewer');
  assert(!$('locate-all').hidden, 'Favorite viewer offers locate');
  let clipboardCalled = false, clipboardText = null;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const OriginalItem = window.ClipboardItem;
  window.ClipboardItem = class { constructor(data) { this.data = data; } };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: items => {
    clipboardCalled = true;
    return Promise.resolve(items[0].data['text/plain']).then(blob => blob.text()).then(text => { clipboardText = text; });
  } } });
  $('copy-prompt').click(); assert(clipboardCalled, 'Clipboard write starts synchronously in click');
  await until(() => clipboardText !== null, 'clipboard text');
  assert(clipboardText.includes('保留完整的用户原文'), 'Deferred prompt is copied');
  await until(() => !$('copy-prompt').disabled, 'clipboard completion');
  window.ClipboardItem = OriginalItem;
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else delete navigator.clipboard;
  $('locate-all').click(); await frames(); assert(document.body.classList.contains('grid-layout'), 'Viewer locate opens all grid');
  host.scrollTop = 19000; await frames();
  $('grid-filter-favorites').click(); await frames(); host.scrollTop = 9000; await frames();
  $('grid-filter-all').click(); await frames();
  await wait(260);
  const saved = await db.getValue('views', account);
  assert(saved.filterStates.all.grid.scrollTop > 18000 && saved.filterStates.favorites.grid.scrollTop > 8500, 'Separate filter positions persisted');
  localStorage.setItem('featureExpectedState', JSON.stringify(saved.filterStates));
  return JSON.stringify({ hidden: true, hiddenViewerIsolation: true, unhide: true, lastRemoval: true,
    filterAnchors: true, locateGridAndViewer: true, animationCount: animations.length, clipboardInGesture: true,
    persistedAll: saved.filterStates.all.grid.scrollTop, persistedFavorites: saved.filterStates.favorites.grid.scrollTop,
    mountedCards: document.querySelectorAll('.grid-card').length });
})()
