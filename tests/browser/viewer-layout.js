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
  const geometry = () => JSON.stringify({ viewport: $('viewport').getBoundingClientRect().toJSON(), transform: $('main-image').style.transform });
  const withinWindow = () => {
    for (const node of document.querySelectorAll('.component-menu')) {
      const box = node.getBoundingClientRect();
      assert(box.left >= -.5 && box.right <= innerWidth + .5 && box.top >= -.5 && box.bottom <= innerHeight + .5, 'Menu stays inside window');
    }
    assert(getComputedStyle($('viewport')).overflow === 'hidden' && getComputedStyle($('viewport')).contain.includes('paint'), 'Panning is clipped to canvas');
  };
  const fitted = label => {
    const image = $('main-image').getBoundingClientRect(), area = $('viewport').getBoundingClientRect();
    assert(image.left >= area.left + 10 && image.right <= area.right - 10 && image.top >= area.top + 10 && image.bottom <= area.bottom - 10, `${label}: fit keeps whole picture`);
  };
  const results = [];
  for (let index = 0; index < records.length; index++) {
    if (index === 0) { document.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden); }
    else { $('next').click(); await until(() => $('image-title').textContent === records[index].title && !$('main-image').hidden); }
    await settle(); fitted('base');
    const base = geometry();
    document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:innerWidth/2,clientY:innerHeight/2}));
    await wait(2250); assert(geometry() === base, 'Idle never moves picture');
    $('toggle-edit').click(); await settle(); assert(geometry() === base, 'Floating editor never moves picture');
    $('edit-prompt').value = 'one\ntwo\nthree\nfour\nfive\nsix'; $('edit-prompt').dispatchEvent(new Event('input')); await settle();
    assert($('edit-prompt').clientHeight === 24 && $('edit-prompt').scrollHeight > $('edit-prompt').clientHeight, 'Input scrolls internally');
    assert(geometry() === base, 'Long text never moves picture');
    $('edit-prompt').blur(); await wait(2250); assert(!$('describe-edits').hidden, 'Draft keeps editor visible');
    $('toggle-edit').click(); $('toggle-more').click(); await settle();
    assert(document.querySelector('.component-menu'), 'Real dropdown component opens');
    assert(geometry() === base, 'More never changes picture geometry'); withinWindow();
    document.querySelector('[data-branch="details"]').click(); await settle();
    assert(document.querySelectorAll('.component-menu').length === 2, 'Detail keeps parent'); withinWindow();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await settle();
    $('actual-size').click(); $('viewport').dispatchEvent(new WheelEvent('wheel',{deltaY:-70,ctrlKey:true,bubbles:true,cancelable:true,
      clientX:$('viewport').getBoundingClientRect().left+$('viewport').clientWidth/2,clientY:innerHeight/2}));
    $('viewport').dispatchEvent(new WheelEvent('wheel',{deltaX:35,deltaY:20,bubbles:true,cancelable:true})); await settle();
    const custom = $('main-image').style.transform;
    $('toggle-more').click(); await settle(); $('toggle-more').click(); await settle();
    assert($('main-image').style.transform === custom, 'Menus preserve custom scale and viewed center');
    $('toggle-sidebar').click(); await settle(); assert($('main-image').style.transform === custom, 'Sidebar preserves custom scale and viewed center');
    $('toggle-sidebar').click(); await settle();
    for (const action of ['settings','help']) {
      $('toggle-more').click(); await settle(); document.querySelector('[data-branch="library"]').click(); await settle();
      document.querySelector(`[data-branch="${action}"]`).click(); await settle(); withinWindow();
      const id = action === 'settings' ? 'settings-dialog' : 'help-dialog';
      assert($(id).open && $(id).closest('.component-menu') && !$(id).matches(':modal'), 'Content is embedded in submenu');
      assert($('main-image').style.transform === custom, 'Embedded content never moves image');
      $(id).close(); await settle(); assert(!document.querySelector('.component-menu'), 'Close dismisses chain');
    }
    $('viewport').dispatchEvent(new KeyboardEvent('keydown',{key:'0',bubbles:true})); await settle(); fitted('restored fit');
    $('toggle-edit').click(); $('edit-prompt').value=''; $('edit-prompt').dispatchEvent(new Event('input')); $('edit-prompt').blur();
    document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:index+10,clientY:index+10})); await wait(2250);
    assert($('describe-edits').hidden, 'Empty unfocused editor collapses'); fitted('idle');
    results.push({dimensions:dimensions[index]});
  }
  return JSON.stringify({window:[innerWidth,innerHeight], floatingStable:true, fit:true, customCenter:true, embeddedPanels:true, multiline:true, results});
})()
