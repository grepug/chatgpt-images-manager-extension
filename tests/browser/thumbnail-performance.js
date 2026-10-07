// Localhost raster test: measures complete/decode plus painted frames, rather
// than treating mounted cards as proof that their images have appeared.
(async () => {
  if (location.hostname !== '127.0.0.1') throw new Error('Local test images only');
  const { mergeLibrary, storeAsset, getThumbnailAsset, getAsset, getImages } = await import('/db.js');
  const { ThumbnailCache, resizeThumbnail, THUMBNAIL_VERSION } = await import('/thumbnail-cache.js');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const frames = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const wait = async predicate => {
    const start = performance.now();
    while (!predicate()) { if (performance.now() - start > 15000) throw new Error('Raster image timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1408;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e9e5df'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < 1408; y += 16) for (let x = 0; x < 1024; x += 16) {
    ctx.fillStyle = `hsl(${(x * 11 + y * 7) % 360} 35% 55%)`; ctx.fillRect(x, y, 8, 8);
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(20, 20, 984, 110); ctx.fillStyle = '#111'; ctx.font = '44px sans-serif'; ctx.fillText('Retina detail: ABC 0123456789', 40, 92);
  const original = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  const tiny = await resizeThumbnail(original, { width: 160, height: 1e9, dpr: 1, cover: false });
  assert(tiny.blob.type === 'image/jpeg', 'Opaque thumbnails should use native JPEG encoding');
  const transparentCanvas = document.createElement('canvas'); transparentCanvas.width = 256; transparentCanvas.height = 256;
  const transparentContext = transparentCanvas.getContext('2d'); transparentContext.fillStyle = '#00f'; transparentContext.fillRect(100, 100, 100, 100);
  const transparentOriginal = await new Promise(resolve => transparentCanvas.toBlob(resolve));
  const transparentThumbnail = await resizeThumbnail(transparentOriginal, { width: 128, height: 1e9, dpr: 1, cover: false });
  assert(transparentThumbnail.blob.type === 'image/png', 'Transparent thumbnails must keep alpha');
  const transparentBitmap = await createImageBitmap(transparentThumbnail.blob);
  transparentContext.clearRect(0, 0, 256, 256); transparentContext.drawImage(transparentBitmap, 0, 0); transparentBitmap.close();
  assert(transparentContext.getImageData(0, 0, 1, 1).data[3] === 0, 'PNG must preserve transparent pixels');
  const metadata = Array.from({ length: 120 }, (_, index) => ({ id: `raster-${index}`, title: `栅格测试 ${index}`, width: 1024, height: 1408, createdAt: Date.now() - index * 60000 }));
  await mergeLibrary('preview-account', metadata, true);
  for (const image of metadata) {
    await storeAsset('preview-account', image.id, 'original', original);
    await storeAsset('preview-account', image.id, 'thumbnail', tiny.blob);
  }
  let diskReads = 0, network = 0;
  const cache = new ThumbnailCache({ readThumbnail: async (...args) => { diskReads++; return getThumbnailAsset(...args); },
    readOriginal: getAsset, download: async () => { network++; throw new Error('Cached images must not download'); }, persist: async () => {} });
  const retinaBox = { width: 408, height: 1e9, dpr: 2, cover: false };
  let start = performance.now();
  const leases = metadata.slice(0, 12).map(image => cache.acquire('preview-account', image, retinaBox));
  const resources = await Promise.all(leases.map(lease => lease.ready));
  const firstRetinaBatch = performance.now() - start;
  assert(resources.every(value => value.width >= 816 && value.thumbnailVersion === THUMBNAIL_VERSION), 'Retina thumbnail must have enough source pixels');
  leases.forEach(lease => lease.release());
  start = performance.now();
  const returned = metadata.slice(0, 12).map(image => cache.acquire('preview-account', image, retinaBox));
  assert(returned.every((lease, i) => lease.url === resources[i].url), 'Scrollback must provide a synchronous warm URL');
  await Promise.all(returned.map(lease => lease.ready));
  const warmBatch = performance.now() - start;
  assert(diskReads === 12 && network === 0, 'Warm return must not repeat disk or network reads');
  returned.forEach(lease => lease.release()); cache.clear();
  window.dispatchEvent(new Event('preview-library-event'));
  const host = document.querySelector('#grid-scroll');
  document.querySelector('#grid-filter-all').click(); document.querySelector('#grid-size-medium').click();
  await wait(() => document.querySelector('#grid-all-count').textContent === '120'); host.scrollTop = 0;
  const inScreen = () => {
    const rect = host.getBoundingClientRect();
    return [...document.querySelectorAll('.grid-card')].filter(card => { const r = card.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom; });
  };
  const loaded = () => inScreen().length > 0 && inScreen().every(card => { const image = card.querySelector('img'); return image.complete && image.naturalWidth >= Math.min(1024, card.offsetWidth * devicePixelRatio); });
  await wait(loaded); await frames();
  const cold = [], warm = [], sizes = [], samples = [];
  for (const size of ['small', 'medium', 'large']) {
    document.querySelector(`#grid-size-${size}`).click(); await frames(); await wait(loaded); await frames();
    sizes.push({ size, cssWidth: inScreen()[0].offsetWidth, rasterWidth: inScreen()[0].querySelector('img').naturalWidth });
    for (let i = 0; i < 5; i++) {
      const back = host.scrollTop, previousImages = new Map(inScreen().map(card => [card.dataset.id, card.querySelector('img')]));
      const started = performance.now(); host.scrollTop = (i + 1) * 2100;
      await frames(); await wait(loaded); await frames(); cold.push(performance.now() - started);
      const warmStart = performance.now(); host.scrollTop = back;
      await frames(); await wait(loaded); warm.push(performance.now() - warmStart);
      samples.push({ size, i, coldMs: Math.round(cold.at(-1)), warmMs: Math.round(warm.at(-1)) });
      assert(inScreen().every(card => previousImages.get(card.dataset.id) === card.querySelector('img')), 'Scrollback must reattach decoded image elements');
      assert(inScreen().every(card => card.querySelector('img').naturalWidth >= Math.min(1024, card.offsetWidth * devicePixelRatio)), 'Cached originals must not use undersized raster previews');
    }
  }
  const position = host.scrollTop, card = inScreen()[0], id = card.dataset.id;
  card.querySelector('button').click(); await wait(() => !document.querySelector('#main-image').hidden);
  document.querySelector('#return-grid').click(); await frames(); await wait(loaded);
  assert(Math.abs(position - host.scrollTop) < 2 && document.querySelector(`[data-id="${id}"]`), 'Viewer return must retain position and warm images');
  const percentile = values => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length * .95)]);
  window.thumbnailVerification = { firstRetinaBatchMs: Math.round(firstRetinaBatch), warmRetinaBatchMs: +warmBatch.toFixed(2), retinaWidth: resources[0].width,
    diskReads, network, coldPaintedP95Ms: percentile(cold), warmPaintedP95Ms: percentile(warm), sizes, originals: original.size, visibleCards: inScreen().length,
    liveRecords: (await getImages('preview-account')).length, viewerReturn: true, transparency: true, samples };
  return JSON.stringify(window.thumbnailVerification);
})()
