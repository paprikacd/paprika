import type { TimeBrushPreview } from '@insights/chart-window-controls';
import { formatWindowDuration } from '@insights/time-window';
import plotStyles from '@insights/time-series-chart.module.css';

/**
 * The drag preview over a lab plot: the span under the pointer, labelled with its duration. Production draws the same
 * preview over its own time series; this serves the lab's plots, which position their own marks.
 */
export function TimeBrushOverlay({ preview, top, height }: { preview: TimeBrushPreview | null; top: number; height: number }) {
  if (!preview) return null;
  const left = Math.min(preview.x1, preview.x2), selected = Math.abs(preview.x2 - preview.x1);
  return <div className={plotStyles.brush} style={{ left, width: selected, top, height }} data-time-brush-selection aria-hidden="true">
    <span>{formatWindowDuration(Math.abs(preview.end - preview.start))}</span>
  </div>;
}
