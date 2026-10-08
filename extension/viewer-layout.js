// Menus reserve space below the toolbar; picture proportions never move controls.
export function viewerTopLayout({ height, railHeight = 48, panelHeight = 0 }) {
  const available = Math.max(0, height - railHeight);
  const reserved = Math.min(panelHeight, 240, available / 3, Math.max(0, available - 80));
  return { panelHeight: reserved, imageHeight: Math.max(0, available - reserved) };
}
