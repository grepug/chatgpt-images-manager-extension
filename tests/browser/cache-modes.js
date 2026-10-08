// Synthetic localhost preview only. Exercise the real gallery/settings wiring.
(async () => {
  if (location.hostname !== '127.0.0.1' || !location.search.includes('preview=1')) throw Error('Preview only');
  const assert = (value, message) => { if (!value) throw Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = id => document.getElementById(id), db = await import('/db.js');
  await db.mergeLibrary('preview-account', Array.from({ length:2000 }, (_,n) => ({ id:`fixture-${n}`, title:`Fixture ${n}`, createdAt:2000000-n, width:900,height:1200 })),false);
  window.dispatchEvent(new Event('preview-library-event')); await wait(250);
  $('grid-filter-all').click(); $('return-grid').click();
  $('grid-settings').click(); await wait(100);
  assert($('cache-mode').value === 'full','Default full');
  $('cache-mode').value = 'demand'; $('cache-mode').dispatchEvent(new Event('change')); await wait(100);
  assert(!$('settings-progress').textContent.includes('待缓存'),'Demand has no unseen pending count');
  assert($('settings-progress').textContent.includes('含隐藏'),'Source total includes hidden');
  $('pause-cache').click(); await wait(100); assert(!$('resume-cache').hidden,'Pause offers resume');
  $('resume-cache').click(); await wait(100); assert(!$('pause-cache').hidden,'Resume offers pause');
  $('settings-dialog').close();
  const notified = new Set(); window.addEventListener('preview-demand-cache', event => event.detail.ids.forEach(id => notified.add(id)));
  const host = $('grid-scroll'); host.scrollTop = host.scrollHeight; await wait(100); host.scrollTop = 0; await wait(400);
  assert(![...notified].some(id => Number(id.split('-')[1]) > 1900),'A brief flyby does not queue originals');
  notified.clear(); host.scrollTop = host.scrollHeight; await wait(400);
  assert(notified.size > 0,'Visible cells queue after dwell');
  const bounds = host.getBoundingClientRect();
  for (const id of notified) {
    const rect = document.querySelector(`[data-id="${id}"]`).getBoundingClientRect();
    assert(rect.bottom > bounds.top && rect.top < bounds.bottom,'Overscan does not queue originals');
  }
  assert(document.querySelectorAll('.grid-card').length < 80,'Long gallery remains virtualized');
  await db.mergeLibrary('preview-account',[{id:'retained-fixture',title:'Retained fixture',createdAt:3000000,width:900,height:1200}],false);
  await db.updateValue('images','preview-account:retained-fixture',{deleted:true,localOriginal:true,favorite:true});
  window.dispatchEvent(new Event('preview-library-event')); await wait(150);
  $('grid-filter-favorites').click(); await wait(100); host.scrollTop = 0; await wait(100);
  const retained = document.querySelector('[data-id="retained-fixture"]');
  assert(retained && !retained.querySelector('.grid-locate').hidden,'A retained favorite offers locate');
  retained.querySelector('.grid-locate').click(); await wait(100);
  assert($('grid-filter-all').ariaPressed === 'true' && document.querySelector('[data-id="retained-fixture"]'),'Retained locate opens all');
  return JSON.stringify({ modes:true, pauseResume:true, dwell:true, overscan:true, mounted:document.querySelectorAll('.grid-card').length });
})()
