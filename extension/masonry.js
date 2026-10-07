export const GRID_SIZES = { small: 180, medium: 260, large: 360 };

export function masonryLayout(images, width, size = 'medium', dimensions = new Map(), sidebar = false) {
  const gap = sidebar ? 6 : 12, padding = sidebar ? 6 : 16;
  const available = Math.max(1, width - padding * 2);
  const count = sidebar ? 1 : Math.max(1, Math.floor((available + gap) / ((GRID_SIZES[size] || GRID_SIZES.medium) + gap)));
  const cardWidth = (available - gap * (count - 1)) / count;
  const columns = Array.from({ length: count }, () => []), bottoms = Array(count).fill(padding);
  const items = [], byId = new Map();
  images.forEach((image, index) => {
    const measured = dimensions.get(image.id);
    const ratio = image.width > 0 && image.height > 0 ? image.height / image.width : measured || 1;
    const height = sidebar ? (width <= 154 ? 133 : 149) : Math.max(1, cardWidth * ratio);
    let column = 0;
    for (let i = 1; i < count; i++) if (bottoms[i] < bottoms[column]) column = i;
    const item = { id: image.id, index, column, x: padding + column * (cardWidth + gap), y: bottoms[column], width: cardWidth, height };
    items.push(item); columns[column].push(item); byId.set(item.id, item);
    bottoms[column] += height + gap;
  });
  return { items, columns, byId, height: images.length ? Math.max(...bottoms) - gap + padding : 0, gap };
}

// Columns are ordered by vertical position. Scrolling searches each column rather
// than scanning every image; the result size depends on the viewport, not history.
export function masonryWindow(layout, top, height, overscan = 500) {
  const start = Math.max(0, top - overscan), end = top + height + overscan, visible = [];
  for (const column of layout.columns) {
    let low = 0, high = column.length;
    while (low < high) {
      const middle = (low + high) >>> 1, item = column[middle];
      if (item.y + item.height < start) low = middle + 1; else high = middle;
    }
    for (let i = low; i < column.length && column[i].y <= end; i++) visible.push(column[i]);
  }
  return visible.sort((a, b) => a.index - b.index);
}

export function masonryAnchor(layout, top) {
  const candidates = masonryWindow(layout, top, 1, 0);
  const item = candidates.sort((a, b) => b.y - a.y || a.index - b.index)[0] || masonryWindow(layout, top, 100, 0)[0];
  return item ? { id: item.id, index: item.index, offset: top - item.y } : null;
}

export function masonryScrollTop(layout, anchor, fallback = 0) {
  const item = anchor && (layout.byId.get(anchor.id) || layout.items[Math.min(anchor.index || 0, layout.items.length - 1)]);
  return item ? Math.max(0, item.y + Math.min(item.height - 1, anchor.offset || 0)) : fallback;
}
