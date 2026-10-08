// Run with agent-browser eval --stdin on localhost synthetic preview only.
(async () => {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = async () => { await wait(100); await new Promise(requestAnimationFrame); };
  const until = async predicate => { for (let i = 0; i < 250 && !predicate(); i++) await wait(20); assert(predicate(), 'Timed out'); };
  assert(location.hostname === '127.0.0.1' && location.search.includes('preview=1'), 'Synthetic preview only');
  const $ = id => document.getElementById(id), db = await import('/db.js'), account = 'preview-account';
  const dimensions = [[2400, 900], [900, 2400], [1400, 1400]];
  const records = dimensions.map(([width, height], index) => ({ id: `layout-${index}`, width, height,
    title: `Layout fixture ${index}`, createdAt: Date.now() - index * 1000, conversationId: 'preview-conversation', fileId: `layout-${index}` }));
  await db.mergeLibrary(account, records, false);
  for (const image of records) await db.storeAsset(account, image.id, 'original', new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}"><rect width="100%" height="100%" fill="#adc6d2"/><text x="40" y="90" font-size="45">${image.width} × ${image.height}</text></svg>`], { type: 'image/svg+xml' }));
  window.dispatchEvent(new Event('preview-library-event')); await wait(250);
  if (!document.body.classList.contains('grid-layout')) $('return-grid').click();
  $('grid-filter-all').click(); $('grid-scroll').scrollTop = 0; await settle();
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
  const geometry = () => JSON.stringify({ viewport: $('viewport').getBoundingClientRect().toJSON(), toolbar: $('controls-rail').getBoundingClientRect().toJSON(), transform: $('main-image').style.transform });
  const outside = label => {
    const area = $('viewport').getBoundingClientRect();
    for (const node of document.querySelectorAll('#viewer-controls button,#viewer-controls textarea,#viewer-panel,#status,.sidebar')) {
      let rect = node.getBoundingClientRect();
      // Offscreen items in a scrolling menu have boxes but are clipped before paint.
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (/(auto|hidden|scroll)/.test(getComputedStyle(parent).overflow)) {
          const clip = parent.getBoundingClientRect();
          rect = { left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
            top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom) };
          rect.width = Math.max(0, rect.right - rect.left); rect.height = Math.max(0, rect.bottom - rect.top);
        }
      }
      if (rect.width && rect.height) assert(!overlap(area, rect), `${label}: ${node.id || node.className} overlaps image area`);
    }
    assert(getComputedStyle($('viewport')).overflow === 'hidden' && getComputedStyle($('viewport')).contain.includes('paint'), `${label}: pixels clipped to viewport`);
  };
  const fitted = label => {
    const image = $('main-image').getBoundingClientRect(), area = $('viewport').getBoundingClientRect();
    assert(image.left >= area.left + 10 && image.right <= area.right - 10 && image.top >= area.top + 10 && image.bottom <= area.bottom - 10, `${label}: fit keeps whole picture`);
  };
  const results = [];
  for (let index = 0; index < records.length; index++) {
    if (index === 0) { document.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden); }
    else { $('next').click(); await until(() => $('image-title').textContent === records[index].title && !$('main-image').hidden); }
    await settle(); outside('base'); fitted('base');
    const base = geometry(); $('return-grid').blur();
    document.dispatchEvent(new Event('pointermove')); await wait(2400);
    assert(geometry() === base, 'Idle does not move picture');
    document.dispatchEvent(new Event('pointermove'));
    $('toggle-edit').click(); await settle(); outside('edit'); fitted('edit');
    const editorGeometry = geometry();
    $('edit-prompt').value = 'one\ntwo\nthree\nfour\nfive\nsix'; $('edit-prompt').dispatchEvent(new Event('input')); await settle();
    assert($('edit-prompt').clientHeight === 24 && $('edit-prompt').scrollHeight > $('edit-prompt').clientHeight, 'Single line input scrolls internally');
    assert(geometry() === editorGeometry, 'Long text never increases toolbar height or moves image');
    outside('multiline'); fitted('multiline'); $('edit-prompt').blur(); await wait(2400);
    assert(!$('describe-edits').hidden, 'Draft keeps editor visible');
    $('toggle-edit').click(); $('toggle-more').click(); await settle(); outside('more'); fitted('more');
    assert($('viewer-panel').getBoundingClientRect().height <= 240, 'Menu height capped');
    $('menu-details').click(); await settle(); outside('details');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle(); assert(!$('more-panel').hidden, 'Submenu Back restores parent');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    $('toggle-zoom').click(); await settle(); outside('zoom');
    $('actual-size').click(); $('viewport').dispatchEvent(new WheelEvent('wheel', { deltaY: -70, ctrlKey: true, bubbles: true, cancelable: true,
      clientX: $('viewport').getBoundingClientRect().left + $('viewport').clientWidth / 2, clientY: $('viewport').clientHeight / 2 }));
    $('viewport').dispatchEvent(new WheelEvent('wheel', { deltaX: 35, deltaY: 20, bubbles: true, cancelable: true })); await settle();
    const custom = $('main-image').style.transform;
    $('toggle-more').click(); await settle(); $('toggle-more').click(); await settle(); assert($('main-image').style.transform === custom, 'Closing panel preserves custom scale and viewed center'); outside('custom');
    const navigation = $('return-grid').getBoundingClientRect().toJSON();
    $('toggle-sidebar').click(); await settle(); assert($('main-image').style.transform === custom, 'Sidebar preserves custom scale and viewed center'); outside('sidebar');
    assert(JSON.stringify($('return-grid').getBoundingClientRect().toJSON()) === JSON.stringify(navigation), 'Sidebar does not move top navigation');
    $('toggle-sidebar').click();
    for (const action of ['viewer-settings', 'viewer-help']) {
      $('toggle-more').click(); $('menu-library').click(); $(action).click(); await settle(); outside(action);
      const id = action === 'viewer-settings' ? 'settings-dialog' : 'help-dialog';
      assert($(id).open && $(id).parentElement === $('viewer-panel') && !$(id).matches(':modal'), 'Viewer dialog uses independent panel');
      $(id).close(); await settle(); assert($('viewer-panel').hidden, 'Closing dialog returns rail');
    }
    $('viewport').dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); await settle(); fitted('restored fit');
    $('toggle-edit').click(); $('edit-prompt').value = ''; $('edit-prompt').dispatchEvent(new Event('input')); $('edit-prompt').blur(); await wait(2400);
    assert($('describe-edits').hidden, 'Empty unfocused editor collapses');
    outside('idle'); fitted('idle'); results.push({ dimensions: dimensions[index], toolbar: $('controls-rail').getBoundingClientRect().toJSON() });
  }
  return JSON.stringify({ window: [innerWidth, innerHeight], nonOverlap: true, fit: true, customCenter: true, independentPanels: true, idleStable: true, multiline: true, results });
})()
