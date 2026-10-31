/** Presentation-only geometry for the authored outcome fixture. Counts and
 * reference positions remain independent of the current panel size. */
export function outcomeLayout(availableWidth: number, bucketCount: number, group: number, adaptive: boolean) {
  const width = adaptive && Number.isFinite(availableWidth) ? Math.max(120, availableWidth) : 446;
  const height = adaptive ? Math.round(Math.max(190, Math.min(260, width * .45))) : 155;
  const plot = adaptive ? { x: 40, y: 12, w: Math.max(1, width - 52), h: height - 52 } : { x: 37, y: 8, w: 400, h: 111 };
  const pitch = plot.w / Math.max(1, bucketCount);
  const barWidth = group === 1 ? adaptive ? Math.max(1, Math.min(14, plot.w * 9 / 400)) : 9 : Math.max(1, pitch - 3);
  return { adaptive, width, height, plot, pitch, barWidth };
}

export function outcomeBarX(layout: ReturnType<typeof outcomeLayout>, index: number, referenceX: number, group: number) {
  if (group !== 1) return layout.plot.x + index * layout.pitch + 1;
  const originalCenter = referenceX - 588;
  return (layout.adaptive ? layout.plot.x + (originalCenter - 37) / 400 * layout.plot.w : originalCenter) - layout.barWidth / 2;
}
