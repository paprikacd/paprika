import type { ChartLinearGradient } from '@tanstack/charts';

/** A zero-anchored area wash. Negative series fade toward zero, too. */
export function signedAreaGradient(id: string, color: string, values: readonly (number | null)[], opacity = .2): ChartLinearGradient {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const low = Math.min(0, ...finite), high = Math.max(0, ...finite);
  const zero = high === low ? 1 : high / (high - low);
  const faint = Math.min(.025, opacity);
  return { id, type: 'linear', x1: 0, y1: 0, x2: 0, y2: 1,
    stops: zero === 1 ? [{ offset: 0, color, opacity }, { offset: 1, color, opacity: faint }]
      : zero === 0 ? [{ offset: 0, color, opacity: faint }, { offset: 1, color, opacity }]
        : [{ offset: 0, color, opacity }, { offset: zero, color, opacity: faint }, { offset: 1, color, opacity }],
  };
}

const calendarDay = new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const calendarTime = new Intl.DateTimeFormat('en', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Temporal factories require Date channels; exact tooltip datums stay numeric. */
export function timeAxisValue(timestamp: number, calendar: boolean): number | Date {
  return calendar ? new Date(timestamp) : timestamp;
}
export function calendarTick(value: number | Date, span: number) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '—';
  // Zooming to a few days introduces sub-day ticks; date-only labels would
  // repeat even though the observations are twelve or six hours apart.
  if (span > 86_400_000 && span <= 345_600_000) return `${calendarDay.format(date)} ${calendarTime.format(date)}`;
  return (span > 345_600_000 ? calendarDay : calendarTime).format(date);
}

/** Shared plot bounds align timestamp positions across different chart families. */
export function temporalPosition(timestamp: number, start: number, end: number, left: number, right: number) {
  return end > start ? left + (timestamp - start) / (end - start) * (right - left) : (left + right) / 2;
}

/** Exact shared insets when space permits; shrink them before the plot can invert. */
export function horizontalPlotBounds(width: number, requestedLeft: number, requestedRight: number) {
  const available = Number.isFinite(width) ? Math.max(0, width) : 0;
  const inset = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  // Preserve the established left-gutter limit, including room for the right
  // axis. Extremely narrow containers still retain a nonnegative plot width.
  const insetBudget = Math.max(0, available - Math.min(1, available));
  const left = Math.min(inset(requestedLeft), Math.max(8, available - 80), insetBudget);
  const right = Math.min(inset(requestedRight), insetBudget - left);
  return { left, right, plotWidth: available - left - right };
}
