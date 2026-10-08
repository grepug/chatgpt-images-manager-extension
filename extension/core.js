export function visibleImages(images, filter, hiddenIds = new Set()) {
  return images.filter(image => filter === 'hidden' ? hiddenIds.has(image.id) && (!image.deleted || image.favorite || image.localOriginal)
    : !hiddenIds.has(image.id) && (filter === 'favorites' ? image.favorite : !image.deleted || image.localOriginal))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function mergeImages(existing, incoming, complete = false) {
  const records = new Map(existing.map(image => [image.id, { ...image }]));
  const seen = new Set();
  for (const image of incoming) {
    if (!image.id) continue;
    seen.add(image.id);
    const previous = records.get(image.id);
    records.set(image.id, { ...previous, ...image, favorite: previous?.favorite ?? false,
      saved: previous?.saved ?? false, deleted: false,
      width: image.width > 0 ? image.width : previous?.width, height: image.height > 0 ? image.height : previous?.height });
  }
  if (complete) {
    for (const [id, image] of records) if (!seen.has(id)) records.set(id, { ...image, deleted: true });
  }
  return [...records.values()];
}

export function adjacentImages(images, selectedId, distance = 2) {
  const index = images.findIndex(image => image.id === selectedId);
  if (index < 0) return [];
  return images.slice(Math.max(0, index - distance), index + distance + 1).filter(image => image.id !== selectedId);
}

export function moveSelection(images, selectedId, delta, heldCreatedAt = Infinity) {
  if (!images.length) return null;
  const index = images.findIndex(image => image.id === selectedId);
  if (index >= 0) return images[Math.max(0, Math.min(images.length - 1, index + delta))].id;
  // A deleted or uncollected image stays on screen until the user moves away.
  const next = images.findIndex(image => image.createdAt <= heldCreatedAt);
  const target = next < 0 ? images.length - 1 : Math.max(0, next - (delta < 0 ? 1 : 0));
  return images[target].id;
}

export function fitScale(width, height, viewportWidth, viewportHeight) {
  return Math.max(0.02, Math.min((viewportWidth - 24) / width, (viewportHeight - 24) / height));
}

export function zoomAt(transform, requestedScale, point) {
  const scale = Math.max(0.02, Math.min(16, requestedScale));
  const ratio = scale / transform.scale;
  return { scale, x: point.x - (point.x - transform.x) * ratio, y: point.y - (point.y - transform.y) * ratio };
}

export function clampTransform(transform, width, height, viewportWidth, viewportHeight) {
  const maxX = Math.max(0, (width * transform.scale - viewportWidth) / 2 + 32);
  const maxY = Math.max(0, (height * transform.scale - viewportHeight) / 2 + 32);
  return { ...transform, x: Math.max(-maxX, Math.min(maxX, transform.x)), y: Math.max(-maxY, Math.min(maxY, transform.y)) };
}

export function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
