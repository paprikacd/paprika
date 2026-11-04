export type ReferenceChartKind = 'edge' | 'reliability';

const authored = {
  edge: { width: 946, height: 253, left: 55, top: 17, plotWidth: 874, plotHeight: 200 },
  reliability: { width: 933, height: 235, left: 52, top: 12, plotWidth: 859, plotHeight: 182 },
} as const;

/** Keep the comparison fixture exact; operational plots use CSS-pixel geometry. */
export function referenceChartLayout(kind: ReferenceChartKind, measuredWidth: number, responsive: boolean) {
  const source = authored[kind];
  const width = responsive && Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : source.width;
  const left = responsive ? Math.min(width * .2, width < 400 ? 44 : source.left) : source.left;
  const right = responsive ? Math.min(width * .08, width < 400 ? 10 : 18) : source.width - source.left - source.plotWidth;
  const top = responsive ? 20 : source.top;
  // Reflow plot space, not text/marks. A compact panel retains enough vertical
  // room for signed values; broad panels gain useful detail without an artboard.
  const plotHeight = responsive ? Math.round(Math.min(360, Math.max(210, (width - left - right) * .27))) : source.plotHeight;
  const height = responsive ? top + plotHeight + 36 : source.height;
  const plot = { left, top, width: Math.max(1, width - left - right), height: plotHeight };
  const yFromSource = (position: number) => responsive ? top + (position - source.top) / source.plotHeight * plotHeight : position;
  return { width, height, plot, source, yFromSource };
}

/** Fit a full-size annotation inside its visible interval; the legend is retained. */
export function referenceBandLabel(start: number, end: number, left: number, right: number, labelWidth: number) {
  const visibleStart = Math.max(left, start), visibleEnd = Math.min(right, end);
  if (!Number.isFinite(visibleStart) || !Number.isFinite(visibleEnd) || visibleEnd - visibleStart < labelWidth + 8) return null;
  return (visibleStart + visibleEnd) / 2;
}

export function referenceTickAnchor(position: number, labelWidth: number, width: number): 'start' | 'middle' | 'end' {
  if (position + labelWidth / 2 > width - 2) return 'end';
  if (position - labelWidth / 2 < 2) return 'start';
  return 'middle';
}
