// Keyboard and compact-menu regression; localhost fixtures only.
(async () => {
  if (location.hostname !== '127.0.0.1' || !location.search.includes('preview=1')) throw Error('Preview only');
  const $ = id => document.getElementById(id), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (value, label) => { if (!value) throw Error(label); };
  const key = value => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
  for (let n = 0; n < 200 && !document.querySelector('.grid-open') && $('main-image').hidden; n++) await wait(20);
  key('Escape');
  if (document.body.classList.contains('grid-layout')) {
    for (let n = 0; n < 200 && !document.querySelector('.grid-open'); n++) await wait(20);
    document.querySelector('.grid-open').click(); await wait(200);
  }
  const image = $('image-title').textContent;
  $('toggle-more').click(); await wait(100);
  assert($('more-panel').getAttribute('role') === 'menu', 'More uses menu semantics');
  key('End'); assert(document.activeElement.id === 'menu-library', 'End selects last enabled menu item');
  key('ArrowRight'); await wait(100);
  assert(!$('library-panel').hidden, 'Right arrow opens submenu');
  assert($('more-panel').hidden === (innerWidth < 680), 'Narrow submenu replaces parent, wide keeps it');
  key('ArrowDown'); assert(document.activeElement.id === 'viewer-refresh', 'Down selects next submenu action');
  key('Home'); assert(document.activeElement.dataset.viewerMenu === 'more', 'Home selects submenu Back');
  key('ArrowLeft'); await wait(100); assert(!$('more-panel').hidden && $('library-panel').hidden, 'Left returns to parent');
  key('Escape'); assert($('viewer-panel').hidden, 'Escape dismisses menu');
  assert(document.activeElement.id === 'toggle-more' && $('image-title').textContent === image, 'Menu keys preserve current picture and restore trigger focus');
  $('toggle-more').click(); $('menu-library').click(); $('toggle-more').click();
  assert($('viewer-panel').hidden, 'Trigger dismisses open submenu');
  $('toggle-more').click(); await wait(80);
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
  assert($('viewer-panel').hidden, 'Clicking outside menu dismisses it');
  if (innerWidth <= 440) {
    $('toggle-more').click(); $('menu-zoom').click(); await wait(100);
    const menu = $('zoom-panel').getBoundingClientRect();
    assert(menu.width > 100 && menu.left >= 0 && menu.right <= innerWidth, 'Collapsed zoom menu remains within narrow window');
    key('Escape'); assert(document.activeElement.id === 'toggle-more', 'Collapsed zoom restores visible trigger');
  }
  return JSON.stringify({ window: [innerWidth, innerHeight], keyboard: true, submenus: true, outsideDismiss: true, noImageNavigation: true });
})()
