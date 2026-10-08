// Real Safari extension: read-only pixels and temporary scroll/size changes.
// Run with the grid visible; close Web Inspector during the initial delay.
(async () => {
  if (location.protocol !== 'safari-web-extension:' || !document.body.classList.contains('grid-layout')) throw Error('Safari grid only');
  const host = document.getElementById('grid-scroll'), originalTop = host.scrollTop;
  const originalSize = ['small','medium','large'].find(size=>document.getElementById(`grid-size-${size}`).ariaPressed === 'true');
  const db = await import('./db.js');
  const connection = await db.getValue('settings','connection');
  const images = new Map((await db.getImages(connection.lastAccount)).map(row=>[row.id,row]));
  const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const frames = async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
  const cards = ()=>{
    const bounds=host.getBoundingClientRect();
    return [...document.querySelectorAll('.grid-card')].filter(card=>{const r=card.getBoundingClientRect();return r.bottom>bounds.top&&r.top<bounds.bottom;});
  };
  const sufficient = card=>{const img=card.querySelector('img'),source=images.get(card.dataset.id);return img?.complete && img.naturalWidth>=Math.min(source?.width||Infinity,img.getBoundingClientRect().width*devicePixelRatio);};
  const ready = ()=>cards().length && cards().every(sufficient);
  const untilReady = async()=>{const started=performance.now();while(!ready()){if(performance.now()-started>30000)throw Error('Thumbnail pixels timed out');await sleep(10);}await frames();};
  const measurements=[];
  await sleep(6000);
  try {
    document.getElementById('grid-size-large').click(); await frames(); await untilReady();
    for(const top of window.nativePerformancePositions || [2000,4000,6000]) {
      const back=host.scrollTop, previous=new Map(cards().map(card=>[card.dataset.id,card.querySelector('img')]));
      let start=performance.now(); host.scrollTop=top; await frames(); await untilReady(); const cold=performance.now()-start;
      const originalsCached=cards().every(card=>images.get(card.dataset.id)?.localOriginal);
      if (!originalsCached) throw Error('Performance sample includes uncached originals');
      start=performance.now();host.scrollTop=back;await frames();await untilReady();const warm=performance.now()-start;
      const restored=cards(), reused=restored.filter(card=>previous.has(card.dataset.id)).every(card=>previous.get(card.dataset.id)===card.querySelector('img'));
      const pixels=restored.map(card=>({css:Math.round(card.getBoundingClientRect().width),pixels:card.querySelector('img').naturalWidth}));
      measurements.push({firstMs:Math.round(cold),scrollbackMs:Math.round(warm),originalsCached,reused,pixels,sufficient:restored.every(sufficient)});
    }
    window.nativeGridPerformance={dpr:devicePixelRatio,measurements};
    console.log('NATIVE_GRID_PERFORMANCE',JSON.stringify(window.nativeGridPerformance));
  } catch(error) { console.log('NATIVE_GRID_PERFORMANCE_ERROR',error.message); }
  finally { document.getElementById(`grid-size-${originalSize}`).click();await frames();host.scrollTop=originalTop; }
})()
