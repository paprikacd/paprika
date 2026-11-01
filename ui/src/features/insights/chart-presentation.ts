import type { ChartLinearGradient } from "@tanstack/charts";
import { isFormattableTimeZone } from "./schema";

/** The default fill opacity at the top of an area gradient. The gradient fades to transparent at the baseline. */
export const DEFAULT_AREA_OPACITY = 0.28;

/**
 * The zero line within the visible domain: zero when the domain includes it, otherwise the plot edge nearest zero. An area
 * closes at zero, so its fade has to meet this line. A domain that excludes zero would fade toward a zero off the plot.
 */
export function visibleBaseline(domain: readonly [number, number] | undefined): number {
  return domain ? Math.min(Math.max(0, domain[0]), domain[1]) : 0;
}

/**
 * A baseline-anchored area wash. Its opacity peaks at the run's highest and lowest values and reaches zero at `baseline`,
 * the visible zero line (see visibleBaseline). Values above the baseline fade toward it from the top, and values below it
 * fade toward it from the bottom. The fill is a presentation of magnitude only, so it never shifts a value.
 */
export function signedAreaGradient(id: string, color: string, values: readonly (number | null)[], opacity = DEFAULT_AREA_OPACITY, baseline = 0): ChartLinearGradient {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  // The path closes at zero, so the gradient spans the run's highest and lowest values together with zero.
  const low = finite.reduce((minimum, value) => Math.min(minimum, value), 0);
  const high = finite.reduce((maximum, value) => Math.max(maximum, value), 0);
  // Offset of the baseline from the top of the gradient: 0 at the highest value, 1 at the lowest.
  const at = high === low ? 1 : Math.min(1, Math.max(0, (high - baseline) / (high - low)));
  // A side of the baseline is filled only where the run has data on it, so the closing zero never sets an edge.
  const top = finite.some(value => value > baseline) ? opacity : 0;
  const bottom = finite.some(value => value < baseline) ? opacity : 0;
  const stops = at >= 1
    ? [{ offset: 0, color, opacity: top }, { offset: 1, color, opacity: 0 }]
    : at <= 0
      ? [{ offset: 0, color, opacity: 0 }, { offset: 1, color, opacity: bottom }]
      : [{ offset: 0, color, opacity: top }, { offset: at, color, opacity: 0 }, { offset: 1, color, opacity: bottom }];
  return { id, type: "linear", x1: 0, y1: 0, x2: 0, y2: 1, stops };
}

interface CalendarFormats { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; full: Intl.DateTimeFormat }
const calendarFormats = new Map<string, CalendarFormats>();

/** Formatters for one zone, cached. An unusable zone formats as UTC, so a label never throws. */
function formatsFor(timeZone: string): CalendarFormats {
  const zone = isFormattableTimeZone(timeZone) ? timeZone : "UTC";
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

export type CalendarGrain = "minute" | "hour" | "day" | "week" | "month" | "year";
export interface CalendarTick { value: number; grain: CalendarGrain }

const MINUTE_MS = 60_000, HOUR_MS = 3_600_000, DAY_MS = 86_400_000;
/** Candidate spacings, finest first. Each takes `every` units of its grain. */
const CALENDAR_STEPS: readonly { grain: CalendarGrain; every: number; approx: number }[] = [
  ...[1, 5, 10, 15, 30].map((every) => ({ grain: "minute" as const, every, approx: every * MINUTE_MS })),
  ...[1, 2, 3, 6, 12].map((every) => ({ grain: "hour" as const, every, approx: every * HOUR_MS })),
  ...[1, 2].map((every) => ({ grain: "day" as const, every, approx: every * DAY_MS })),
  { grain: "week", every: 1, approx: 7 * DAY_MS },
  ...[1, 2, 3, 6].map((every) => ({ grain: "month" as const, every, approx: every * 30.44 * DAY_MS })),
  ...[1, 2, 5, 10].map((every) => ({ grain: "year" as const, every, approx: every * 365.25 * DAY_MS })),
];

const wallFormats = new Map<string, Intl.DateTimeFormat>();
/** The zone's wall-clock fields. Unusable zones fall back to UTC, as elsewhere in this module. */
function wallFormat(timeZone: string): Intl.DateTimeFormat {
  const zone = isFormattableTimeZone(timeZone) ? timeZone : "UTC";
  let format = wallFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    wallFormats.set(zone, format);
  }
  return format;
}

/** The wall-clock reading of an instant, as UTC milliseconds. Seconds are whole, so sub-second precision is dropped. */
function wallClock(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const parts = Object.fromEntries(wallFormat(timeZone).formatToParts(new Date(whole)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
}

/**
 * The instant at which a zone reads `wall`. `exact` is false when the zone never shows that reading (a spring-forward gap),
 * so a caller can skip an hour that does not exist instead of placing it at a guessed instant.
 */
function instantOfWall(wall: number, timeZone: string): { instant: number; exact: boolean } {
  const offsetAt = (instant: number) => wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
  const instant = wall - offsetAt(wall - offsetAt(wall));
  return { instant, exact: wallClock(instant, timeZone) === wall };
}

/**
 * The first instant at which a zone reads `wall` or later. A spring-forward gap skips the reading, so this is the
 * transition itself. The wall clock never runs backwards across a whole second except for a fall-back, which repeats
 * readings without skipping any, so a bisection over whole seconds is exact.
 */
function firstInstantAtOrAfter(wall: number, timeZone: string): number {
  let low = wall - 2 * DAY_MS, high = wall + 2 * DAY_MS;
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2000) * 1000;
    if (wallClock(middle, timeZone) >= wall) high = middle;
    else low = middle;
  }
  return high;
}

/** Wall-clock starts of one grain's ticks, from the last start at or before `from` through `to`. */
function wallStarts(grain: CalendarGrain, every: number, from: number, to: number): number[] {
  const starts: number[] = [];
  const push = (wall: number) => { if (wall <= to) starts.push(wall); };
  if (grain === "minute" || grain === "hour" || grain === "day") {
    const unit = grain === "minute" ? MINUTE_MS : grain === "hour" ? HOUR_MS : DAY_MS;
    for (let wall = Math.floor(from / (every * unit)) * every * unit; wall <= to; wall += every * unit) push(wall);
  } else if (grain === "week") {
    const day = Math.floor(from / DAY_MS) * DAY_MS;
    // Weeks start on Monday, the first day of the local week for most of the calendar.
    for (let wall = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS; wall <= to; wall += 7 * DAY_MS) push(wall);
  } else {
    const monthIndex = (wall: number) => new Date(wall).getUTCFullYear() * 12 + new Date(wall).getUTCMonth();
    const monthStart = (index: number) => Date.UTC(Math.floor(index / 12), ((index % 12) + 12) % 12, 1);
    if (grain === "month") {
      for (let index = Math.floor(monthIndex(from) / every) * every; monthStart(index) <= to; index += every) push(monthStart(index));
    } else {
      for (let year = Math.floor(new Date(from).getUTCFullYear() / every) * every; Date.UTC(year, 0, 1) <= to; year += every) push(Date.UTC(year, 0, 1));
    }
  }
  return starts;
}

/**
 * Calendar ticks across [start, end], aligned to the zone's own calendar: clock times on the hour or minute, local
 * midnights for days, Mondays for weeks, the first of each month and January 1st for years. The grain is the finest
 * one that gives no more than `count` ticks. Each tick is a true instant, so a linear scale places it by elapsed time:
 * a day that is 23 hours long shows as a shorter gap, and a skipped local hour shows as a label jump.
 */
export function calendarTicks(start: number, end: number, count: number, timeZone: string): CalendarTick[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return [];
  const zone = isFormattableTimeZone(timeZone) ? timeZone : "UTC";
  const limit = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 4;
  const span = end - start;
  const step = CALENDAR_STEPS.find((candidate) => span / candidate.approx <= limit) ?? CALENDAR_STEPS.at(-1)!;
  const from = wallClock(start, zone), to = wallClock(end, zone);
  const ticks = new Map<number, CalendarTick>();
  const dated = step.grain === "day" || step.grain === "week" || step.grain === "month" || step.grain === "year";
  for (const wall of wallStarts(step.grain, step.every, from, to)) {
    const placed = instantOfWall(wall, zone);
    // A date that begins in a gap (a local midnight that never happens) starts at the transition. A clock time in a gap is skipped.
    const instant = placed.exact ? placed.instant : dated ? firstInstantAtOrAfter(wall, zone) : undefined;
    if (instant !== undefined && instant >= start && instant <= end && !ticks.has(instant)) ticks.set(instant, { value: instant, grain: step.grain });
  }
  return [...ticks.values()].sort((a, b) => a.value - b.value);
}

const calendarLabelFormats = new Map<string, { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat; month: Intl.DateTimeFormat; monthYear: Intl.DateTimeFormat }>();
function labelFormats(timeZone: string) {
  const zone = isFormattableTimeZone(timeZone) ? timeZone : "UTC";
  let formats = calendarLabelFormats.get(zone);
  if (!formats) {
    formats = {
      time: new Intl.DateTimeFormat("en", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      day: new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", day: "numeric" }),
      month: new Intl.DateTimeFormat("en", { timeZone: zone, month: "short" }),
      monthYear: new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", year: "numeric" }),
    };
    calendarLabelFormats.set(zone, formats);
  }
  return formats;
}

/**
 * A label for a calendar tick in the zone. Clock times read HH:mm; a local midnight reads as its date. Months read as
 * their name, with the year on January. Years read as the year.
 */
export function calendarTickLabel(tick: CalendarTick, timeZone: string): string {
  if (!Number.isFinite(tick.value)) return "—";
  const formats = labelFormats(timeZone);
  const wall = wallClock(tick.value, timeZone);
  const date = new Date(tick.value);
  if (tick.grain === "minute" || tick.grain === "hour") return wall % DAY_MS === 0 ? formats.day.format(date) : formats.time.format(date);
  if (tick.grain === "day" || tick.grain === "week") return formats.day.format(date);
  if (tick.grain === "month") return new Date(wall).getUTCMonth() === 0 ? formats.monthYear.format(date) : formats.month.format(date);
  return String(new Date(wall).getUTCFullYear());
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
