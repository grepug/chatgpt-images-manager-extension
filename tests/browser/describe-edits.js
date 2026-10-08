// Local fixtures only; never submits a real edit to ChatGPT.
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => { for (let n = 0; n < 200 && !predicate(); n++) await wait(25); assert(predicate(), 'Timed out'); };
  assert(location.hostname === '127.0.0.1' && location.search.includes('preview=1'), 'Preview only');
  const $ = id => document.getElementById(id), db = await import('/db.js');
  const images = (await db.getImages('preview-account')).slice(0, 3).map(image => ({ ...image, fileId: image.id, conversationId: 'preview-conversation' }));
  await db.mergeLibrary('preview-account', images, false);
  window.dispatchEvent(new Event('preview-library-event')); await wait(200);
  if (!document.body.classList.contains('grid-layout')) $('return-grid').click();
  await until(() => document.querySelector('.grid-open'));
  document.querySelector('.grid-open').click(); await until(() => !$('main-image').hidden && !$('describe-edits').hidden);
  const first = $('image-title').textContent;
  $('edit-prompt').value = '保留第一张的草稿'; $('edit-prompt').dispatchEvent(new Event('input'));
  $('next').click(); await until(() => $('image-title').textContent !== first);
  assert($('edit-prompt').value === '', 'Draft does not leak into next image');
  $('previous').click(); await until(() => $('image-title').textContent === first);
  assert($('edit-prompt').value === '保留第一张的草稿', 'Draft restored by image identity');
  $('edit-prompt').focus(); document.body.classList.add('controls-idle');
  await wait(250);
  assert(getComputedStyle($('describe-edits')).opacity === '1', 'Focused composer remains visible');
  $('edit-prompt').blur(); await until(() => getComputedStyle($('describe-edits')).opacity === '0');
  assert(getComputedStyle($('describe-edits')).opacity === '0', 'Idle composer hides');
  document.body.classList.remove('controls-idle');
  const composer = $('describe-edits').getBoundingClientRect(), zoom = $('zoom-controls').getBoundingClientRect();
  assert(composer.width <= 480 && composer.height < 70, 'Composer stays compact');
  assert(zoom.bottom < composer.top, 'Zoom controls do not overlap composer');
  let submitted;
  const viewState = () => JSON.stringify({ title: $('image-title').textContent, position: $('image-position').textContent,
    transform: $('main-image').style.transform, sidebar: $('thumbnails').scrollTop, grid: $('grid-scroll').scrollTop,
    layout: document.body.classList.contains('grid-layout') });
  const beforeSubmit = viewState();
  window.addEventListener('preview-edit', event => submitted = event.detail, { once: true });
  $('describe-edits').requestSubmit(); await until(() => submitted && $('submit-edit').disabled && !$('edit-prompt').value);
  assert(submitted.prompt === '保留第一张的草稿' && submitted.id === images[0].id, 'Submit uses exact image and draft');
  assert(viewState() === beforeSubmit, 'Submit preserves source image, zoom, layout and scroll positions');
  const toast = $('status').getBoundingClientRect();
  assert(Math.abs(toast.left + toast.width / 2 - innerWidth / 2) < 1, 'Toast centered in full viewport');
  assert(toast.width <= 420, 'Toast remains narrow');
  return JSON.stringify({ imageDrafts: true, nativeRequestIdentity: true, sourceViewPreserved: true, focusAndIdle: true, composer: { width: composer.width, height: composer.height }, toastCentered: true });
})()
