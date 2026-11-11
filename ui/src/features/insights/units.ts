// One number formatter for Insights chart readings, tooltips, axis ticks and footers.
//
// Auto precision keeps three significant figures (100 %, 17.6 req/s, 812 ms, 1.07K req/s). Scaling
// is automatic for durations (us, ms, s), IEC bytes, SI bit rates and per-second rates; it is chosen
// from the rounded value, so 999.5 ms reads 1.00 s. Percent, multipliers and unknown units keep
// their authored unit. An authored `decimals` option fixes the fraction digits exactly and never
// rescales the value. Exact observation details are formatted elsewhere (chart-data.ts).
import { scaleLinear } from "@tanstack/charts/scales/linear";

/** One presentation of a value: the number text (with any SI or count prefix) and the unit text. */
export interface UnitStep {
  /** Attached to the number, as in `1.07K`. */
  prefix: string;
  /** Printed after the number with a space; empty for none. Percent is attached and handled by `unitSuffix`. */
  unit: string;
  /** Multiplier from the authored unit to this step's unit, in the same quantity. */
  factor: number;
}

export interface Reading {
  /** Number text, including any prefix; "—" for a value that is not finite. */
  value: string;
  /** Display unit after scaling. Equal to the authored unit when nothing was scaled. */
  unit: string;
}

export interface FormatOptions {
  /** Abbreviate large plain counts as K, M, B, T. Axis ticks use this; readings do not. */
  compact?: boolean;
  /** Authored fixed fraction digits. Honoured exactly, with no scaling. */
  decimals?: number;
}

export interface AxisScale {
  /** Display unit chosen for the whole axis. Use it for the caption when the unit is separated. */
  unit: string;
  /** The tick values the labels were derived from. */
  ticks: number[];
  /** Label one value. `withUnit` false leaves the unit to a caption. */
  label(value: number, withUnit?: boolean): string;
}

export const SIGNIFICANT_FIGURES = 3;
const MAX_DECIMALS = 8;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const SI_PREFIXES = ["", "k", "M", "G", "T", "P"];
const COUNT_PREFIXES = ["", "K", "M", "B", "T"];
const BYTE_NUMERATOR = /^(?:[KMGTP]?i?B|bytes?)$/;

const fixedFormats = new Map<number, Intl.NumberFormat>();
const compactFormats = new Map<number, Intl.NumberFormat>();

function fixedFormat(digits: number, compact: boolean) {
  const cache = compact ? compactFormats : fixedFormats;
  let format = cache.get(digits);
  if (!format) {
    format = new Intl.NumberFormat("en", {
      ...(compact ? { notation: "compact" as const } : {}),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    cache.set(digits, format);
  }
  return format;
}

/** Fixed fraction digits, normalising negative zero. */
function fixed(value: number, digits: number, compact = false) {
  return fixedFormat(digits, compact).format(value === 0 ? 0 : value);
}

/** The magnitude rounded to three significant figures. */
function rounded(magnitude: number) {
  // The relative nudge absorbs binary error, so 0.9995 (from 999.5 ms) rounds up to 1.00 as it reads.
  return magnitude === 0 ? 0 : Number((magnitude * (1 + 1e-9)).toPrecision(SIGNIFICANT_FIGURES));
}

/**
 * Fraction digits for a value whose three-figure rounding is `roundedMagnitude`. Values of one or more keep at most
 * two fraction digits and never lose integer digits (18,423 stays whole); smaller values keep three significant
 * figures (0.0042, 0.995).
 */
function autoPlaces(magnitude: number, roundedMagnitude: number) {
  if (roundedMagnitude === 0) return 0;
  const places = Math.max(0, SIGNIFICANT_FIGURES - 1 - Math.floor(Math.log10(roundedMagnitude) + 1e-12));
  return magnitude >= 1 ? Math.min(2, places) : places;
}

const trimmedFormat = new Map<number, Intl.NumberFormat>();

/** Up to `places` fraction digits, with trailing zeros and the decimal point trimmed. */
function trimmed(value: number, places: number) {
  let format = trimmedFormat.get(places);
  if (!format) {
    format = new Intl.NumberFormat("en", { minimumFractionDigits: 0, maximumFractionDigits: places });
    trimmedFormat.set(places, format);
  }
  return format.format(value === 0 ? 0 : value);
}

function unitsFor(unit: string, compact: boolean): { steps: UnitStep[]; index: number } {
  const single = [{ prefix: "", unit, factor: 1 }];
  if (unit === "%" || unit === "x" || unit === "×") return { steps: single, index: 0 };
  const bytes = unit === "bytes" ? "B" : unit;
  const bytesIndex = BYTE_UNITS.indexOf(bytes);
  if (bytesIndex >= 0)
    return { steps: BYTE_UNITS.map((name, i) => ({ prefix: "", unit: name, factor: 1024 ** i })), index: bytesIndex };
  const durations = [
    { unit: "us", factor: 1e-6 },
    { unit: "ms", factor: 1e-3 },
    { unit: "s", factor: 1 },
  ];
  const durationIndex = durations.findIndex((step) => step.unit === (unit === "µs" ? "us" : unit));
  if (durationIndex >= 0) return { steps: durations.map(step => ({ prefix: "", ...step })), index: durationIndex };
  const bits = /^([kKMGTP]?)(bit|b)\/s$/.exec(unit);
  if (bits) {
    const prefix = bits[1] === "K" ? "k" : bits[1];
    return {
      steps: SI_PREFIXES.map((name, i) => ({ prefix: "", unit: `${name}${bits[2]}/s`, factor: 1000 ** i })),
      index: SI_PREFIXES.indexOf(prefix),
    };
  }
  const rate = /^([^/]*)\/s$/.exec(unit);
  if (rate && !BYTE_NUMERATOR.test(rate[1]))
    return {
      steps: COUNT_PREFIXES.map((prefix, i) => ({ prefix, unit: rate[1] ? `${rate[1]}/s` : "/s", factor: 1000 ** i })),
      index: 0,
    };
  if (compact) return { steps: COUNT_PREFIXES.map((prefix, i) => ({ prefix, unit, factor: 1000 ** i })), index: 0 };
  return { steps: single, index: 0 };
}

/** The largest step whose value rounds to at least one of that step's unit. Falls back to the smallest. */
function chooseStep(steps: readonly UnitStep[], index: number, value: number) {
  if (value === 0) return index;
  const base = value * steps[index].factor;
  for (let candidate = steps.length - 1; candidate > 0; candidate--)
    if (rounded(Math.abs(base / steps[candidate].factor)) >= 1) return candidate;
  return 0;
}

/** `value`, authored in `steps[index]`, expressed in `steps[candidate]`. */
function inStep(value: number, steps: readonly UnitStep[], index: number, candidate: number) {
  return (value * steps[index].factor) / steps[candidate].factor;
}

/**
 * Automatic text for a value already expressed in its step's unit. The fraction digits come from rounding to three
 * significant figures; the value is then formatted to those digits and trimmed. Halves round away from zero on the
 * decimal reading (1.005 becomes 1.01, 0.995 stays 0.995), so the value is nudged by a relative 1e-9 first.
 */
function autoNumber(value: number) {
  const magnitude = rounded(Math.abs(value));
  if (magnitude >= 1e15 || (magnitude > 0 && magnitude < 1e-6)) return Number((value === 0 ? 0 : value).toPrecision(SIGNIFICANT_FIGURES)).toExponential();
  return trimmed(value * (1 + 1e-9), autoPlaces(Math.abs(value), magnitude));
}

export function unitSuffix(unit: string) {
  return unit === "%" ? "%" : unit ? ` ${unit}` : "";
}

export function joinReading(reading: Reading) {
  return `${reading.value}${unitSuffix(reading.unit)}`;
}

/** Format one value with its unit family, returning the number and the display unit separately. */
export function formatReading(value: number, unit = "", options: FormatOptions = {}): Reading {
  if (!Number.isFinite(value)) return { value: "—", unit };
  const { compact = false, decimals } = options;
  if (decimals !== undefined && Number.isFinite(decimals)) {
    const digits = Math.max(0, Math.min(MAX_DECIMALS, Math.floor(decimals)));
    return { value: fixed(value, digits, compact), unit };
  }
  const { steps, index } = unitsFor(unit, compact);
  const candidate = chooseStep(steps, index, value);
  const step = steps[candidate];
  return { value: `${autoNumber(inStep(value, steps, index, candidate))}${step.prefix}`, unit: step.unit };
}

/** Format one value as a single string, for text that has no separate unit element. */
export function formatMetric(value: number, unit = "", compact = false, decimals?: number): string {
  if (!Number.isFinite(value)) return "—";
  return joinReading(formatReading(value, unit, { compact, decimals }));
}

/** Smallest number of fraction digits (up to 8) that writes every value exactly. */
function digitsNeeded(values: readonly number[]) {
  for (let digits = 0; digits < MAX_DECIMALS; digits++) {
    const scale = 10 ** digits;
    if (values.every(value => {
      const scaled = value * scale;
      return Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled));
    })) return digits;
  }
  return MAX_DECIMALS;
}

/**
 * The labels for one axis. Every tick shares a unit (chosen from the largest tick) and a fraction-digit count
 * taken from the tick step, so 0.1 and 0.2 read as "0.1" and "0.2". Labels that still collide after rounding get
 * more digits. Pass `ticks` to label custom evenly spaced ticks; otherwise the nice ticks for `count` are used.
 */
export function axisScale(
  domain: readonly [number, number],
  unit: string,
  options: FormatOptions & { count?: number; ticks?: readonly number[] } = {},
): AxisScale {
  const { compact = false, decimals, count = 5 } = options;
  const ticks = (options.ticks ?? (domain.every(Number.isFinite) ? scaleLinear().domain(domain).ticks(count) : [])).filter(Number.isFinite);
  if (decimals !== undefined && Number.isFinite(decimals)) {
    return {
      unit,
      ticks: [...ticks],
      label: (value, withUnit = true) => {
        const reading = formatReading(value, unit, { compact, decimals });
        return withUnit ? joinReading(reading) : reading.value;
      },
    };
  }
  const { steps, index } = unitsFor(unit, compact);
  const largest = ticks.reduce((maximum, tick) => Math.max(maximum, Math.abs(tick)), 0);
  const candidate = chooseStep(steps, index, largest);
  const step = steps[candidate];
  const scaled = ticks.map(tick => inStep(tick, steps, index, candidate));
  let digits = digitsNeeded(scaled);
  const labelsFor = (places: number) => scaled.map(value => fixed(value, places, false));
  while (digits < MAX_DECIMALS && new Set(labelsFor(digits)).size < scaled.length) digits++;
  return {
    unit: step.unit,
    ticks: [...ticks],
    label: (value, withUnit = true) => {
      const text = `${fixed(inStep(value, steps, index, candidate), digits)}${step.prefix}`;
      return withUnit ? `${text}${unitSuffix(step.unit)}` : text;
    },
  };
}

/** Axis bounds rounded outwards to nice ticks, as d3 does. Used when guides or a symmetric axis set the domain. */
export function niceDomain(domain: readonly [number, number], count = 5): [number, number] {
  const [low, high] = domain;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return [low, high];
  const [start, end] = scaleLinear().domain([low, high]).nice(count).domain();
  return [start, end];
}

/** A symmetric domain around zero, with the extent rounded to a nice tick. */
export function symmetricDomain(low: number, high: number, count = 5): [number, number] {
  const extent = Math.max(Math.abs(low), Math.abs(high));
  return niceDomain([-extent, extent], count);
}

/**
 * The domain a value axis gets when nothing fixes it: the extent of the values, nice for `count` ticks. Mirrors the
 * automatic scale of the charting library, which includes zero for filled areas and bars.
 */
export function autoAxisDomain(values: readonly number[], count: number, includeZero: boolean): [number, number] {
  let low = includeZero ? 0 : Infinity, high = includeZero ? 0 : -Infinity;
  for (const value of values)
    if (Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (low === high) return niceDomain([Math.min(0, low), Math.max(1, high)], count);
  return niceDomain([low, high], count);
}
