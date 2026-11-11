// One number formatter for Insights chart readings, tooltips, axis ticks and footers.
//
// Readings keep three significant figures, trimmed (100 %, 17.6 req/s, 812 ms, 1.07K req/s, 1 s for 999.5 ms).
// Values of one or more keep at most two fraction digits and never lose integer digits (18,423 stays whole). Scaling
// is automatic for recognised durations (ns, us, ms, s), IEC bytes, B/s, SI bit rates and per-second rates of counting
// nouns; the scaled unit is chosen after rounding. Axes also abbreviate unrecognised units (1.5K W). Percent keeps the
// older Auto precision and never shows 100 unless the value is exactly 100. Authored unit text is never rewritten when
// nothing scales. An authored `decimals` option fixes the fraction digits exactly and never rescales. Exact observation
// details are formatted elsewhere (chart-data.ts).
//
// Axes take their domain and ticks from `axisScale`, and the chart draws exactly those ticks, so each gridline sits at
// the value its label shows.

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
  /** Display unit after scaling. The authored text when nothing was scaled. */
  unit: string;
}

export interface FormatOptions {
  /** Abbreviate large counts as K, M, B, T. Axes use this, including for units without a recognised family. */
  compact?: boolean;
  /** Authored fixed fraction digits. Honoured exactly, with no scaling. */
  decimals?: number;
  /**
   * `reading` (default) keeps three significant figures and scales. `record` keeps the older Auto precision (at most
   * two fraction digits for values of one or more) and never scales or uses exponents, for table cells and previews.
   */
  precision?: "reading" | "record";
  /**
   * Thresholds or objectives in the authored unit. Rounding never moves the shown value to the other side of one:
   * precision grows until it does not, and falls back to the exact value.
   */
  keepSides?: readonly number[];
}

export interface AxisScale {
  /** Display unit chosen for the whole axis. Use it for the caption when the unit is separated. */
  unit: string;
  /** The domain to draw, in the authored unit, rounded to readable ticks in the display unit. */
  domain: [number, number];
  /** The tick values to draw, in the authored unit. Each is exactly a value its label shows. */
  ticks: number[];
  /** Label one value. `withUnit` false leaves the unit to a caption. */
  label(value: number, withUnit?: boolean): string;
}

export const SIGNIFICANT_FIGURES = 3;
const MAX_DECIMALS = 8;
const MAX_PERCENT_DECIMALS = 8;
const MAX_GUARD_DECIMALS = 12;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const SI_PREFIXES = ["", "k", "M", "G", "T", "P"];
const COUNT_PREFIXES = ["", "K", "M", "B", "T"];
const NICE_MANTISSAS = [1, 2, 2.5, 5];
/** Counting nouns that may take a count prefix in readings (req/s, obs/s, requests). */
const COUNT_NOUNS = new Set(["req", "requests", "obs", "observations", "ops", "operations", "events", "msgs", "messages", "queries", "samples", "hits", "errors", "calls", "writes", "reads", "items", "rows", "spans", "traces", "logs", "connections", "packets"]);
const DURATIONS = [
  { unit: "ns", factor: 1e-9 },
  { unit: "us", factor: 1e-6 },
  { unit: "ms", factor: 1e-3 },
  { unit: "s", factor: 1 },
];
/** U+00B5 (micro sign) and U+03BC (Greek mu) both read as micro. */
const DURATION_ALIASES: Record<string, string> = { "µs": "us", "μs": "us" };

const formats = new Map<string, Intl.NumberFormat>();
function formatFor(key: string, options: Intl.NumberFormatOptions) {
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en", options);
    formats.set(key, format);
  }
  return format;
}

/**
 * Intl rounds the shortest decimal that round-trips the value, so 1.005 becomes 1.01 and 5e8 stays whole. No nudge
 * is needed, and large integers keep every digit.
 */
function plainText(value: number, places: number, grouping = true) {
  return formatFor(`plain-${grouping}-${places}`, { useGrouping: grouping, minimumFractionDigits: 0, maximumFractionDigits: places }).format(value === 0 ? 0 : value);
}

function fixedText(value: number, digits: number, compact = false) {
  const options = { ...(compact ? { notation: "compact" as const } : {}), minimumFractionDigits: digits, maximumFractionDigits: digits };
  return formatFor(`fixed-${compact}-${digits}`, options).format(value === 0 ? 0 : value);
}

const significantFormat = new Intl.NumberFormat("en", { useGrouping: false, maximumSignificantDigits: SIGNIFICANT_FIGURES });

/** The magnitude rounded to three significant figures, half up on its decimal reading. */
function roundedMagnitude(magnitude: number) {
  return magnitude === 0 ? 0 : Number(significantFormat.format(magnitude));
}

/** Fraction digits that show a three-figure value. */
function sigPlaces(rounded: number) {
  if (rounded === 0) return 0;
  return Math.max(0, SIGNIFICANT_FIGURES - 1 - Math.floor(Math.log10(rounded) + 1e-12));
}

/** Reading precision: three significant figures; at most two fraction digits from one upwards. */
function readingPlaces(magnitude: number) {
  const places = sigPlaces(roundedMagnitude(magnitude));
  return magnitude >= 1 ? Math.min(2, places) : places;
}

/** Record precision, the older Auto: at most two fraction digits from one upwards, three significant figures below. */
function recordPlaces(magnitude: number) {
  return magnitude >= 1 ? 2 : sigPlaces(roundedMagnitude(magnitude));
}

/** The number a text shows, for comparing against a threshold. */
function shownNumber(value: number, places: number) {
  return Number(plainText(value, places, false));
}

/** The exact value, which crosses no threshold. Used only when no reasonable precision keeps the side. */
function exactText(value: number) {
  return plainText(value, MAX_GUARD_DECIMALS + 3);
}

/**
 * Raises precision until the shown value is on the same side of every guard as the true value. Guards are in the same
 * unit as `value`. At the limit the exact value is shown, so no guard is ever crossed.
 */
function keepingSides(value: number, guards: readonly number[], places: number, textAt: (places: number) => string) {
  const sideMatches = (shown: number) => guards.every(guard => (shown >= guard) === (value >= guard));
  let digits = places;
  while (digits < MAX_GUARD_DECIMALS && !sideMatches(shownNumber(value, digits))) digits++;
  return sideMatches(shownNumber(value, digits)) ? textAt(digits) : exactText(value);
}

/**
 * Percent keeps the older Auto precision on every surface, and never shows 100 unless the value is exactly 100 (on
 * either side of zero): digits are added until the value stops rounding to 100. Past the limit the exact value is
 * shown.
 */
function percentText(value: number, guards: readonly number[]) {
  const magnitude = Math.abs(value);
  const showsHundred = (places: number) => Math.abs(shownNumber(value, places)) === 100 && magnitude !== 100;
  let places = recordPlaces(magnitude);
  while (places < MAX_PERCENT_DECIMALS && showsHundred(places)) places++;
  if (showsHundred(places)) return exactText(value);
  return keepingSides(value, guards, places, textAt => plainText(value, textAt));
}

function unitsFor(unit: string, compact: boolean): { steps: UnitStep[]; index: number } {
  const single = [{ prefix: "", unit, factor: 1 }];
  if (unit === "%" || unit === "x" || unit === "×") return { steps: single, index: 0 };
  if (unit === "B/s") return { steps: BYTE_UNITS.map((name, i) => ({ prefix: "", unit: `${name}/s`, factor: 1024 ** i })), index: 0 };
  const bytes = unit === "bytes" ? "B" : unit;
  const bytesIndex = BYTE_UNITS.indexOf(bytes);
  if (bytesIndex >= 0)
    return { steps: BYTE_UNITS.map((name, i) => ({ prefix: "", unit: name, factor: 1024 ** i })), index: bytesIndex };
  const durationName = DURATION_ALIASES[unit] ?? unit;
  const durationIndex = DURATIONS.findIndex(step => step.unit === durationName);
  if (durationIndex >= 0) return { steps: DURATIONS.map(step => ({ prefix: "", ...step })), index: durationIndex };
  const bits = /^([kKMGTP]?)(bit|b)\/s$/.exec(unit);
  if (bits) {
    const prefix = bits[1] === "K" ? "k" : bits[1];
    return {
      steps: SI_PREFIXES.map((name, i) => ({ prefix: "", unit: `${name}${bits[2]}/s`, factor: 1000 ** i })),
      index: SI_PREFIXES.indexOf(prefix),
    };
  }
  const rate = /^([^/]*)\/s$/.exec(unit);
  if (rate && (rate[1] === "" || COUNT_NOUNS.has(rate[1])))
    return {
      steps: COUNT_PREFIXES.map((prefix, i) => ({ prefix, unit: rate[1] ? `${rate[1]}/s` : "/s", factor: 1000 ** i })),
      index: 0,
    };
  // Axes abbreviate any other unit, as they always have; readings keep an unrecognised unit as authored.
  if (compact) return { steps: COUNT_PREFIXES.map((prefix, i) => ({ prefix, unit, factor: 1000 ** i })), index: 0 };
  return { steps: single, index: 0 };
}

/**
 * `value`, authored in `steps[index]`, expressed in `steps[candidate]`. A changed unit drops the binary noise of the
 * factor (999.5 us is exactly 0.9995 ms), so the magnitude chosen after rounding is the one that reads. An unchanged
 * unit keeps the value exactly.
 */
function inStep(value: number, steps: readonly UnitStep[], index: number, candidate: number) {
  if (candidate === index) return value;
  return Number(((value * steps[index].factor) / steps[candidate].factor).toPrecision(12));
}

/** The largest step whose value rounds to at least one of that step's unit. Falls back to the smallest. */
function chooseStep(steps: readonly UnitStep[], index: number, value: number) {
  if (value === 0) return index;
  for (let candidate = steps.length - 1; candidate > 0; candidate--)
    if (roundedMagnitude(Math.abs(inStep(value, steps, index, candidate))) >= 1) return candidate;
  return 0;
}

export function unitSuffix(unit: string) {
  return unit === "%" ? "%" : unit ? ` ${unit}` : "";
}

export function joinReading(reading: Reading) {
  return `${reading.value}${unitSuffix(reading.unit)}`;
}

/** Reading text for a value already in its step's unit. */
function readingText(value: number, guards: readonly number[]) {
  const magnitude = Math.abs(value);
  if (magnitude >= 1e15 || (magnitude > 0 && magnitude < 1e-6)) return Number(value.toPrecision(SIGNIFICANT_FIGURES)).toExponential();
  return keepingSides(value, guards, readingPlaces(magnitude), textAt => plainText(value, textAt));
}

/** Record text never uses an exponent: every digit stays, grouped. */
function recordText(value: number, guards: readonly number[]) {
  return keepingSides(value, guards, recordPlaces(Math.abs(value)), textAt => plainText(value, textAt));
}

/** Whether three-figure precision in this step shows the wrong side of a guard. */
function needsExtraDigits(value: number, guards: readonly number[]) {
  const base = readingPlaces(Math.abs(value));
  return guards.some(guard => (shownNumber(value, base) >= guard) !== (value >= guard));
}

/** Format one value with its unit family, returning the number and the display unit separately. */
export function formatReading(value: number, unit = "", options: FormatOptions = {}): Reading {
  if (!Number.isFinite(value)) return { value: "—", unit };
  const { compact = false, decimals, precision = "reading", keepSides = [] } = options;
  if (decimals !== undefined && Number.isFinite(decimals)) {
    const digits = Math.max(0, Math.min(MAX_DECIMALS, Math.floor(decimals)));
    return { value: fixedText(value, digits, compact), unit };
  }
  if (unit === "%") return { value: percentText(value, keepSides), unit };
  const { steps, index } = unitsFor(unit, compact);
  let candidate = precision === "record" ? index : chooseStep(steps, index, value);
  let scaled = inStep(value, steps, index, candidate);
  let guards = keepSides.map(guard => inStep(guard, steps, index, candidate));
  // A guard that needs extra digits in a scaled unit reads better as the authored unit: "999.5 ms", not "0.9995 s".
  if (precision === "reading" && candidate !== index && guards.length && needsExtraDigits(scaled, guards)) {
    candidate = index;
    scaled = value;
    guards = [...keepSides];
  }
  const step = steps[candidate];
  const text = precision === "record" ? recordText(scaled, guards) : readingText(scaled, guards);
  const prefix = scaled === 0 ? "" : step.prefix;
  return { value: `${text}${prefix}`, unit: candidate === index ? unit : step.unit };
}

/** Format one value as a single string, for text that has no separate unit element. */
export function formatMetric(value: number, unit = "", compact = false, decimals?: number): string {
  if (!Number.isFinite(value)) return "—";
  return joinReading(formatReading(value, unit, { compact, decimals }));
}

/** A record table or preview value: the older Auto precision and the authored unit, never rescaled, never exponent. */
export function formatRecordValue(value: number, unit = "", decimals?: number): string {
  if (!Number.isFinite(value)) return "—";
  return joinReading(formatReading(value, unit, { decimals, precision: "record" }));
}

/**
 * Values that must compare: one shared scale, chosen from the largest, with reading precision, so a column, a gauge
 * or a pair of extremes never mixes "1.03 s" with "640 ms". `number` formats one value of the scale without its unit;
 * `unit` is the shared display unit.
 */
export function sharedScale(values: readonly number[], unit = "", options: { compact?: boolean } = {}): { unit: string; number(value: number): string } {
  if (unit === "%") return { unit, number: value => (Number.isFinite(value) ? percentText(value, []) : "—") };
  const finite = values.filter(Number.isFinite);
  const { steps, index } = unitsFor(unit, options.compact ?? false);
  const largest = finite.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  const candidate = chooseStep(steps, index, largest);
  const step = steps[candidate];
  return {
    unit: candidate === index ? unit : step.unit,
    number: value => {
      if (!Number.isFinite(value)) return "—";
      const scaled = inStep(value, steps, index, candidate);
      return `${readingText(scaled, [])}${scaled === 0 ? "" : step.prefix}`;
    },
  };
}

/** `sharedScale` for a list: each value with the shared unit. */
export function formatSharedScale(values: readonly number[], unit = "", options: { compact?: boolean } = {}): string[] {
  const scale = sharedScale(values, unit, options);
  return values.map(value => (Number.isFinite(value) ? `${scale.number(value)}${unitSuffix(scale.unit)}` : "—"));
}

/**
 * A range such as "10 ms–100 ms". Both bounds share one scale, chosen from the larger bound, and each carries the
 * unit, so a range never mixes scales or reads its lower bound as unitless.
 */
export function formatRange(lower: number, upper: number, unit = "", options: FormatOptions = {}): string {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return "—";
  const { compact = false } = options;
  const { steps, index } = unitsFor(unit, compact);
  const candidate = chooseStep(steps, index, Math.max(Math.abs(lower), Math.abs(upper)));
  const step = steps[candidate];
  const unitText = candidate === index ? unit : step.unit;
  const text = (value: number) => {
    const scaled = inStep(value, steps, index, candidate);
    return `${readingText(scaled, [])}${scaled === 0 ? "" : step.prefix}${unitSuffix(unitText)}`;
  };
  return `${text(lower)}–${text(upper)}`;
}

/** Smallest number of fraction digits (up to 8) that writes every tick exactly. */
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
 * Digits for custom ticks, taken from their step and kept to three significant figures of the step, so a step of
 * 24.69 reads "24.7" and a step of 0.25 reads "0.25".
 */
function digitsFromStep(ticks: readonly number[]) {
  const sorted = [...ticks].sort((a, b) => a - b);
  let step = Infinity;
  for (let index = 1; index < sorted.length; index++) step = Math.min(step, sorted[index] - sorted[index - 1]);
  if (!Number.isFinite(step) || step <= 0) return digitsNeeded(ticks);
  const stepDigits = digitsNeeded([roundedMagnitude(step)]);
  return Math.min(stepDigits, Math.max(0, SIGNIFICANT_FIGURES - 1 - Math.floor(Math.log10(step) + 1e-12)));
}

/** Ticks that are zero within float noise of the largest tick become exactly zero, so none reads "-0.0". */
function cleanZeros(ticks: readonly number[]) {
  const largest = ticks.reduce((maximum, tick) => Math.max(maximum, Math.abs(tick)), 0);
  const tolerance = largest * 1e-9;
  return ticks.map(tick => (Math.abs(tick) <= tolerance ? 0 : tick));
}

/**
 * Nice bounds and ticks for an axis. The step (1, 2, 2.5 or 5 times a power of ten) is chosen so the number of ticks
 * is as close as possible to `count`, and the bounds are the outermost multiples of that step that contain the input.
 * The chart draws these ticks, so the labels and gridlines are the same values.
 */
export function niceAxis(domain: readonly [number, number], count = 5): { domain: [number, number]; ticks: number[] } {
  const [low, high] = domain;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low))
    return { domain: [low, high], ticks: Number.isFinite(low) && low === high ? [low] : [] };
  const target = Math.max(2, Math.floor(count));
  // Half the extent first, so an extent wider than the float range (±1e308) still has a finite step.
  const half = high / 2 - low / 2;
  if (!(half > 0) || !Number.isFinite(half)) return { domain: [low, high], ticks: [] };
  // Never overflows: half the extent is finite, and the step per tick is computed from it without doubling.
  const perStep = Number.isFinite(high - low) ? (high - low) / (target - 1) : (half / (target - 1)) * 2;
  const magnitude = Math.floor(Math.log10(perStep));
  if (!Number.isFinite(magnitude)) return { domain: [low, high], ticks: [] };
  const candidates: { step: number; first: number; last: number; ticks: number; width: number }[] = [];
  for (let exponent = magnitude - 1; exponent <= magnitude + 1; exponent++)
    for (const mantissa of NICE_MANTISSAS) {
      const step = mantissa * 10 ** exponent;
      if (!Number.isFinite(step) || step <= 0) continue;
      const first = Math.floor(low / step + 1e-9);
      const last = Math.ceil(high / step - 1e-9);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 1000) continue;
      if (!Number.isFinite(first * step) || !Number.isFinite(last * step)) continue;
      candidates.push({ step, first, last, ticks: last - first + 1, width: (last - first) * step });
    }
  // The tightest domain is the default: a 105 % axis is 0 to 150 %, not 0 to 200 %. Among candidates within 30 % of that
  // width, the one nearest the requested count wins; then the tighter, then the one with more ticks.
  // Only steps giving a sane tick count compete: a fine step can be as tight but has far too many ticks.
  if (!candidates.length) return { domain: [low, high], ticks: [] };
  const sane = candidates.filter(candidate => candidate.ticks <= target * 2 + 2);
  const pool = sane.length ? sane : candidates;
  const tightest = Math.min(...pool.map(candidate => candidate.width));
  const within = pool.filter(candidate => candidate.width <= tightest * 1.3);
  const best = within.reduce((chosen, candidate) => {
    const distance = Math.abs(candidate.ticks - target), chosenDistance = Math.abs(chosen.ticks - target);
    if (distance !== chosenDistance) return distance < chosenDistance ? candidate : chosen;
    if (Math.abs(candidate.width - chosen.width) > 1e-9 * chosen.width) return candidate.width < chosen.width ? candidate : chosen;
    return candidate.ticks > chosen.ticks ? candidate : chosen;
  });
  const { step, first, last } = best;
  const ticks: number[] = [];
  for (let k = first; k <= last; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { domain: [Number((first * step).toPrecision(12)), Number((last * step).toPrecision(12))], ticks };
}

/** Axis bounds rounded outwards to nice ticks. Used when guides, a symmetric axis or a record extent set the domain. */
export function niceDomain(domain: readonly [number, number], count = 5): [number, number] {
  const [low, high] = domain;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return [low, high];
  return niceAxis(domain, count).domain;
}

/** A symmetric domain around zero, with the extent rounded to a nice tick. */
export function symmetricDomain(low: number, high: number, count = 5): [number, number] {
  const extent = Math.max(Math.abs(low), Math.abs(high));
  return niceDomain([-extent, extent], count);
}

/**
 * The labels for one axis. The display unit is chosen first, from the domain (or the custom ticks), and the domain is
 * then rounded to nice ticks in that unit, so byte axes read 0.5 KiB steps rather than binary fractions. Every tick
 * shares a fraction-digit count taken from the tick step. Labels that still collide get more digits. Pass `ticks` to
 * label custom ticks (for example a record extent already rounded); their digits come from the step.
 */
export function axisScale(
  domain: readonly [number, number],
  unit: string,
  options: FormatOptions & { count?: number; ticks?: readonly number[] } = {},
): AxisScale {
  const { compact = false, decimals, count = 5 } = options;
  const finiteDomain = domain.every(Number.isFinite);
  const customTicks = options.ticks?.filter(Number.isFinite);
  if (decimals !== undefined && Number.isFinite(decimals)) {
    const axis = finiteDomain && !customTicks ? niceAxis(domain, count) : { domain: [domain[0], domain[1]] as [number, number], ticks: customTicks ?? [] };
    return {
      unit,
      domain: axis.domain,
      ticks: [...axis.ticks],
      label: (value, withUnit = true) => {
        const reading = formatReading(value, unit, { compact, decimals });
        return withUnit ? joinReading(reading) : reading.value;
      },
    };
  }
  const { steps, index } = unitsFor(unit, compact);
  const span = customTicks ? customTicks.reduce((maximum, tick) => Math.max(maximum, Math.abs(tick)), 0) : Math.max(...domain.map(Math.abs));
  const candidate = chooseStep(steps, index, Number.isFinite(span) ? span : 0);
  const step = steps[candidate];
  const toScaled = (value: number) => inStep(value, steps, index, candidate);
  const toBase = (value: number) => inStep(value, steps, candidate, index);
  const scaledDomain: [number, number] = finiteDomain ? [toScaled(domain[0]), toScaled(domain[1])] : [domain[0], domain[1]];
  let outDomain = scaledDomain;
  let scaledTicks: number[] = [];
  let digits = 0;
  if (customTicks) {
    scaledTicks = cleanZeros(customTicks.map(toScaled));
    digits = digitsFromStep(scaledTicks);
  } else if (finiteDomain) {
    const axis = niceAxis(scaledDomain, count);
    outDomain = axis.domain;
    scaledTicks = cleanZeros(axis.ticks);
    digits = digitsNeeded(scaledTicks);
  }
  const labelsFor = (places: number) => scaledTicks.map(value => fixedText(value, places));
  while (digits < MAX_DECIMALS && new Set(labelsFor(digits)).size < scaledTicks.length) digits++;
  const unitText = candidate === index ? unit : step.unit;
  return {
    unit: unitText,
    domain: [toBase(outDomain[0]), toBase(outDomain[1])],
    ticks: scaledTicks.map(toBase),
    label: (value, withUnit = true) => {
      let scaled = toScaled(value);
      if (Math.abs(scaled) < 0.5 * 10 ** -digits) scaled = 0;
      const text = scaled === 0 ? fixedText(0, digits) : `${fixedText(scaled, digits)}${step.prefix}`;
      return withUnit ? `${text}${unitSuffix(unitText)}` : text;
    },
  };
}

/**
 * The domain a value axis gets when nothing fixes it: the extent of the values, nice for `count` ticks. A flat
 * series is padded five per cent either side, so its labels describe a real span rather than [0, 1].
 */
export function autoAxisDomain(values: readonly number[], count: number, includeZero: boolean): [number, number] {
  let low = includeZero ? 0 : Infinity, high = includeZero ? 0 : -Infinity;
  for (const value of values)
    if (Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (low === high) {
    if (low === 0) return [0, 1];
    const pad = Math.abs(low) * 0.05;
    return niceDomain([low - pad, high + pad], count);
  }
  return niceDomain([low, high], count);
}
