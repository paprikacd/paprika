import type { ChartLinearGradient } from "@tanstack/charts";
import { isValidTimeZone } from "./schema";

/** The default fill opacity at the top of an area gradient. The gradient fades to transparent at zero. */
export const DEFAULT_AREA_OPACITY = 0.28;

/**
 * A zero-anchored area wash. Values above zero fade toward the zero line from the top, and values below it fade
 * toward zero from the bottom. The fill is a presentation of magnitude only, so it never shifts a value.
 */
export function signedAreaGradient(id: string, color: string, values: readonly (number | null)[], opacity = DEFAULT_AREA_OPACITY): ChartLinearGradient {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const low = finite.reduce((minimum, value) => Math.min(minimum, value), 0);
  const high = finite.reduce((maximum, value) => Math.max(maximum, value), 0);
  // Offset of the zero line from the top of the gradient: 0 when all values are non-negative, 1 when all are non-positive.
  const zero = high === low ? 1 : high / (high - low);
  const stops = zero >= 1
    ? [{ offset: 0, color, opacity }, { offset: 1, color, opacity: 0 }]
    : zero <= 0
      ? [{ offset: 0, color, opacity: 0 }, { offset: 1, color, opacity }]
      : [{ offset: 0, color, opacity }, { offset: zero, color, opacity: 0 }, { offset: 1, color, opacity }];
  return { id, type: "linear", x1: 0, y1: 0, x2: 0, y2: 1, stops };
}

interface CalendarFormats { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; full: Intl.DateTimeFormat }
const calendarFormats = new Map<string, CalendarFormats>();

/** Formatters for one zone, cached. An unusable zone formats as UTC, so a label never throws. */
function formatsFor(timeZone: string): CalendarFormats {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  let formats = calendarFormats.get(zone);
  if (!formats) {
    formats = {
      day: new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", day: "numeric" }),
      time: new Intl.DateTimeFormat("en", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      full: new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "short" }),
    };
    calendarFormats.set(zone, formats);
  }
  return formats;
}

/** Temporal scales need Date channels, while exact tooltip datums stay numeric. */
export function timeAxisValue(timestamp: number, calendar: boolean): number | Date {
  return calendar ? new Date(timestamp) : timestamp;
}

/**
 * A calendar tick in the dashboard's zone. A span of a few days adds the time, so sub-day ticks never repeat a date.
 * Wider spans show dates, and narrower ones show clock times.
 */
export function calendarTick(value: number | Date, span: number, timeZone: string): string {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "—";
  const { day, time } = formatsFor(timeZone);
  if (span > 86_400_000 && span <= 345_600_000) return `${day.format(date)} ${time.format(date)}`;
  return (span > 345_600_000 ? day : time).format(date);
}

/** A full timestamp with the zone's name, for bounds and details that must say which zone they use. */
export function calendarDateTime(timestamp: number, timeZone: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return formatsFor(timeZone).full.format(date);
}

/** Maps a timestamp into a span of the plot. A degenerate domain sits at the middle of the span. */
export function temporalPosition(timestamp: number, start: number, end: number, left: number, right: number): number {
  return end > start ? left + ((timestamp - start) / (end - start)) * (right - left) : (left + right) / 2;
}

/**
 * Shared horizontal insets, kept when the space permits and shrunk before the plot can invert. Narrow containers keep
 * a nonnegative plot width, and the left gutter never takes more than the container minus eighty pixels (or eight).
 */
export function horizontalPlotBounds(width: number, requestedLeft: number, requestedRight: number): { left: number; right: number; plotWidth: number } {
  const available = Number.isFinite(width) ? Math.max(0, width) : 0;
  const inset = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
  // Reserve at least one pixel so the plot never collapses into the insets.
  const insetBudget = Math.max(0, available - Math.min(1, available));
  const left = Math.min(inset(requestedLeft), Math.max(8, available - 80), insetBudget);
  const right = Math.min(inset(requestedRight), insetBudget - left);
  return { left, right, plotWidth: available - left - right };
}
