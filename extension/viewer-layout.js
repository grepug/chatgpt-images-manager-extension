// Vertical menus share the available height while preserving the root anchor.
export function menuStackLayout({ surface, trigger, windowHeight, heights, widths }) {
  if (!heights.length) return [];
  const top = Math.min(trigger.bottom + 6, Math.max(0, windowHeight - 8));
  const available = Math.max(0, windowHeight - top - 8);
  const gap = Math.min(6, available / (heights.length * 3));
  let remaining = Math.max(0, available - gap * (heights.length - 1)), y = top;
  const minimum = Math.min(72, remaining / heights.length);
  return heights.map((natural, index) => {
    const width = Math.max(0, Math.min(widths[index], surface.width - 16));
    const height = Math.max(0, Math.min(natural, remaining - minimum * (heights.length - index - 1)));
    const x = Math.max(surface.left + 8, Math.min(trigger.right - width, surface.right - width - 8));
    const position = { x, y, width, height };
    y += height + gap; remaining -= height;
    return position;
  });
}
