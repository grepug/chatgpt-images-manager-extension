export function cacheDisplay(usage) {
  const completed = usage.completed || 0, total = usage.total || 0;
  const counts = `已缓存 ${completed} / 总计 ${total} 张（含隐藏）`;
  let state;
  if (usage.phase === 'paused') state = '缓存已暂停';
  else if (usage.activeAsset) state = usage.activeAsset.kind === 'thumbnail' ? '正在缓存缩略图' : '正在缓存原图';
  else if (usage.scanning) state = usage.running ? '正在查找历史图片' : '等待后台恢复';
  else if (usage.failed) state = '等待重试';
  else if (total && completed === total) state = '缓存已完成';
  else if (usage.running) state = '正在缓存';
  else state = total ? usage.cacheMode === 'demand' ? '按需缓存' : '等待后台缓存' : '等待图片';
  const scan = usage.scanning ? ' · 总数仍在增加' : '';
  const failed = usage.failed ? ` · ${usage.failed} 项失败` : '';
  return { text: `${state} · ${counts}${scan}${failed}`,
    percent: usage.scanning || !total ? null : Math.min(100, completed / total * 100) };
}
