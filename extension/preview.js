// Only used by the explicit localhost preview; never enabled on an extension origin.
import { mergeLibrary, storeAsset, setFavorite, setHidden, setBulkFlags, getImages, getAsset, putValue, trimCache, assetMetadata, storageUsage } from './db.js';
import { cacheMode, cacheProgress } from './cache-policy.js';
const account = 'preview-account';
let held = null;
export function fixtureDimensions(index) {
  const [width, height] = [[1200, 900], [900, 1400], [900, 900], [1600, 900]][index % 4];
  return { width, height };
}
export function fixtureSVG(index) {
  const { width, height } = fixtureDimensions(index);
  const colors = [['#c4d5ce', '#345d52'], ['#eed9bb', '#d08c50'], ['#bcc9dd', '#53647c'], ['#d5c9d8', '#8a6685'], ['#d6dac4', '#818b58'], ['#dbbdb4', '#9e645b']];
  const [background, foreground] = colors[index % colors.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1200 900" preserveAspectRatio="none"><rect width="1200" height="900" fill="${background}"/><circle cx="850" cy="240" r="145" fill="${foreground}" opacity=".22"/><path d="M0 700 Q280 350 570 620T1200 560V900H0Z" fill="${foreground}" opacity=".45"/><path d="M0 800Q380 570 650 740T1200 690V900H0Z" fill="${foreground}" opacity=".65"/><text x="65" y="80" font-family="sans-serif" font-size="24" fill="${foreground}">TEST IMAGE ${String(index + 1).padStart(2, '0')}</text></svg>`;
}
async function fixtureBlob(index) {
  // Raster fixtures exercise the same thumbnail path as downloaded originals.
  const url = URL.createObjectURL(new Blob([fixtureSVG(index)], { type:'image/svg+xml' })), image = new Image();
  try {
    image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image,0,0);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('测试图片生成失败')),'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
export async function seedPreview() {
  const existing = await getImages(account);
  if (existing.length) {
    for (const image of existing.filter(image=>/^fixture-\d+$/.test(image.id))) {
      const original = await getAsset(account,image.id);
      if (original?.type === 'image/svg+xml') {
        const blob = await fixtureBlob(Number(image.id.split('-')[1]));
        await storeAsset(account,image.id,'original',blob); await storeAsset(account,image.id,'thumbnail',blob);
      }
    }
    return;
  }
  const titles = ['山间的清晨', '一束暖光', '海岸与远山', '傍晚的花园', '夏日的森林', '窗边的日落', '远处的山脉', '安静的午后', '天空的颜色', '柔和的光影', '长长的夏天', '雨后的街道'];
  await mergeLibrary(account, titles.map((title, index) => ({ id: `fixture-${index}`, title, createdAt: Date.UTC(2026, 9, 7) - index * 86400000, conversationId: 'preview-conversation', fileId: `preview-file-${index}`, ...fixtureDimensions(index) })), true);
  for (let index = 0; index < titles.length; index++) {
    const blob = await fixtureBlob(index);
    await storeAsset(account, `fixture-${index}`, 'original', blob);
    await storeAsset(account, `fixture-${index}`, 'thumbnail', blob);
  }
  await setFavorite(account, 'fixture-0', true); await setFavorite(account, 'fixture-3', true); await setFavorite(account, 'fixture-6', true);
  await putValue('accounts', { key: account, name: '预览 · 测试图片' });
}
export async function previewRPC(type, args) {
  const mode = cacheMode(localStorage.getItem('previewCacheMode'));
  if (type === 'connect') return { id: account, name: '预览 · 测试图片', online: true };
  if (type === 'sync' || type === 'retry-favorites') return {};
  if (type === 'view-hold') {
    held = args.id;
    return {};
  }
  if (type === 'settings') return { cacheMode: mode };
  if (type === 'set-settings') {
    localStorage.setItem('previewCacheMode', cacheMode(args.cacheMode));
    return {};
  }
  if (type === 'demand-cache') { window.dispatchEvent(new CustomEvent('preview-demand-cache', { detail: args })); return {}; }
  if (['retry-cache', 'retry-migration'].includes(type)) return {};
  if (['pause-cache', 'resume-cache'].includes(type)) { localStorage.setItem('previewPaused', String(type === 'pause-cache')); return {}; }
  if (type === 'cache-status') return { cacheMode: mode, paused: localStorage.getItem('previewPaused') === 'true', migration: { phase: 'preview' }, ...cacheProgress(await getImages(account), await assetMetadata(account)), ...await storageUsage(account), phase: localStorage.getItem('previewPaused') === 'true' ? 'paused' : 'idle', failed: 0, ...JSON.parse(localStorage.getItem('previewCacheState') || '{}') };
  if (type === 'favorite') {
    const image = await setFavorite(account, args.id, args.favorite);
    window.dispatchEvent(new Event('preview-library-event')); return image;
  }
  if (type === 'hidden') {
    const result = await setHidden(account, args.id, args.hidden);
    window.dispatchEvent(new CustomEvent('preview-library-event', { detail: { hiddenId: args.id } })); return result;
  }
  if (type === 'bulk-flags') {
    const result = await setBulkFlags(account, args.ids, args.kind, args.value);
    window.dispatchEvent(new Event('preview-library-event')); return result;
  }
  if (type === 'prompt') return { text: `生成测试图片 ${args.id}，保留完整的用户原文。` };
  if (type === 'describe-edit') {
    window.dispatchEvent(new CustomEvent('preview-edit', { detail: args }));
    return { submitted: true };
  }
  if (type === 'asset') {
    let blob = await getAsset(account, args.id, args.kind);
    if (!blob && /^fixture-\d+$/.test(args.id)) {
      blob = await fixtureBlob(Number(args.id.split('-')[1]));
      await storeAsset(account, args.id, args.kind, blob);
    }
    if (!blob) throw new Error('测试图片不可用');
    return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve({ dataURL: reader.result }); reader.readAsDataURL(blob); });
  }
  throw new Error('不支持的预览操作');
}
