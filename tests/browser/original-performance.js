// Safari: existing App originals only. Localhost: synthetic raster originals.
// Close Web Inspector during the initial delay; no edits or persistent cleanup.
(async () => {
  if (!['safari-web-extension:', 'http:'].includes(location.protocol) || location.protocol === 'http:' && location.hostname !== '127.0.0.1') throw Error('Library test origin only');
  const $ = id => document.getElementById(id), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const until = async condition => { const start = performance.now(); while (!condition()) { if (performance.now() - start > 15000) throw Error('Original pixels timed out'); await sleep(2); } };
  const db = await import('./db.js'), { OriginalCache } = await import('./original-cache.js');
  const account = location.hostname === '127.0.0.1' ? 'preview-account' : (await db.getValue('settings','connection')).lastAccount;
  const rows = new Map((await db.getImages(account)).map(row => [row.id,row]));
  const hidden = await db.getHiddenIds(account), host = $('grid-scroll'), top = host.scrollTop;
  const cached = [...document.querySelectorAll('.grid-card')].filter(card => !hidden.has(card.dataset.id) && (location.hostname === '127.0.0.1' || rows.get(card.dataset.id)?.localOriginal));
  if (cached.length < 3 || !document.body.classList.contains('grid-layout')) throw Error('Need a grid region with cached originals');
  let cache, reads = 0, downloads = 0, decodes = 0, lastLease, flashed = false;
  const stages = []; let sample = null, originalRead, originalDownload, originalDecode;
  const acquire = OriginalCache.prototype.acquire;
  OriginalCache.prototype.acquire = function(...args) {
    if (!cache) {
      cache = this; cache.clear();
      const read = originalRead = this.read, download = originalDownload = this.download, decode = originalDecode = this.decode;
      this.read = async (...values) => { reads++; const tag = sample, start = performance.now(); const value = await read(...values); if (tag && values[2]?.foreground()) tag.readMs = Math.round(performance.now()-start); return value; };
      this.download = async (...values) => { downloads++; return download(...values); };
      this.decode = async (...values) => { decodes++; const tag = sample, start = performance.now(); const value = await decode(...values); if (tag) tag.decodeMs = Math.round(performance.now()-start); return value; };
    }
    const lease = acquire.apply(this,args); if (!args[2]?.localOnly) lastLease = lease; return lease;
  };
  const settle = () => until(() => cache && !cache.preloads.running && !cache.reads.running && !cache.decodes.running && !cache.preloads.tasks.length);
  const display = async action => {
    const start = performance.now(); action(); const lease = lastLease;
    const resource = lease.resource || await lease.ready;
    await until(() => !$('main-image').hidden && $('main-image') === resource.image && resource.image.complete && resource.image.naturalWidth > 0);
    await frames(); return Math.round(performance.now() - start);
  };
  const cold = [], repeat = [], neighbors = [];
  await sleep(location.protocol === 'safari-web-extension:' ? 6000 : 100);
  try {
    // Empty session resources before each distinct sample. App files stay intact.
    for (const card of cached.slice(0,10)) {
      if (cache) { await settle(); cache.clear(); }
      sample = {}; cold.push(await display(() => card.querySelector('.grid-open').click())); stages.push(sample); sample = null;
      $('return-grid').click(); await frames();
    }
    const card = document.querySelector(`.grid-card[data-id="${cached[0].dataset.id}"]`);
    await display(() => card.querySelector('.grid-open').click()); await settle();
    const original = $('main-image'), before = { reads, downloads, decodes };
    const observer = new MutationObserver(records => { if (!$('image-loading').hidden || records.some(record => record.oldValue === null)) flashed = true; });
    observer.observe($('image-loading'),{ attributes:true,attributeFilter:['hidden'],attributeOldValue:true });
    for (let n = 0; n < 10; n++) {
      $('return-grid').click(); await frames();
      repeat.push(await display(() => document.querySelector(`.grid-card[data-id="${card.dataset.id}"] .grid-open`).click()));
      if ($('main-image') !== original) throw Error('Repeat did not reuse decoded image');
    }
    observer.disconnect();
    const repeatReads = reads - before.reads, repeatDecodes = decodes - before.decodes, repeatDownloads = downloads - before.downloads;
    if (repeatReads || repeatDecodes || repeatDownloads || flashed) throw Error('Repeat performed IO, decoding or showed loading');
    await settle();
    const neighborBefore = { reads, downloads, decodes };
    for (let n = 0; n < 10; n++) {
      neighbors.push(await display(() => $('next').click())); await settle();
      neighbors.push(await display(() => $('previous').click())); await settle();
    }
    window.originalPerformance = { coldPaintedMs:cold, coldStages:stages, repeatPaintedMs:repeat, neighborPaintedMs:neighbors,
      repeatReads, repeatDecodes, repeatDownloads, repeatedElement:true, loadingFlash:flashed,
      neighborReads:reads-neighborBefore.reads, neighborDecodes:decodes-neighborBefore.decodes, networkDownloads:downloads, originalPixels:true };
    console.log('ORIGINAL_PERFORMANCE',JSON.stringify(window.originalPerformance));
    return JSON.stringify(window.originalPerformance);
  } catch(error) { console.log('ORIGINAL_PERFORMANCE_ERROR',error.message); throw error; }
  finally {
    OriginalCache.prototype.acquire = acquire;
    if (cache) { cache.read = originalRead; cache.download = originalDownload; cache.decode = originalDecode; }
    $('return-grid').click(); await frames(); host.scrollTop = top;
  }
})()
