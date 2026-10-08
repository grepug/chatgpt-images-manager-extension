// Compare the actual remaining image area, rather than guessing from orientation.
export function viewerDock({ width, height, imageWidth, imageHeight, panelWidth = 0, panelHeight = 0, current = 'bottom' }) {
  const railHeight = 32 * Math.max(1, Math.ceil(240 / Math.max(1, width)));
  const sidePanel = Math.min(panelWidth, Math.max(0, width - 112));
  const bottomPanel = Math.min(panelHeight, Math.max(0, Math.min(height * .45, height - railHeight - 80)));
  const candidates = [
    { edge: 'bottom', panelWidth: width, panelHeight: bottomPanel, railHeight, imageWidth: width, imageHeight: height - railHeight - bottomPanel },
    { edge: 'side', panelWidth: sidePanel, panelHeight: height, railHeight: height, imageWidth: width - 32 - sidePanel, imageHeight: height }
  ];
  for (const candidate of candidates) {
    candidate.score = candidate.imageWidth > 24 && candidate.imageHeight > 24 && (candidate.edge !== 'side' || height >= 240)
      ? Math.min((candidate.imageWidth - 24) / (imageWidth || 1), (candidate.imageHeight - 24) / (imageHeight || 1)) : 0;
  }
  const best = candidates.reduce((a, b) => b.score > a.score ? b : a);
  const previous = candidates.find(candidate => candidate.edge === current);
  return previous.score > 0 && previous.score >= best.score * .99 ? previous : best;
}
