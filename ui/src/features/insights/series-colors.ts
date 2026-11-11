import { z } from "zod";
import { SERIES_ROLE_SLOT, SERIES_ROLES, SERIES_SLOTS, seriesRole, seriesSlot, type SeriesRole } from "./series-palette";

const seriesRule = z.strictObject({
  label: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100),
  value: z.string().min(1).max(256),
  /** A six-digit hex colour, or a semantic role from series-palette.ts. Exactly one is required. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color").optional(),
  role: z.enum(SERIES_ROLES).optional(),
}).superRefine((rule, context) => {
  if (rule.color === undefined && rule.role === undefined) context.addIssue({ code: "custom", message: "Name a hex color or a series role" });
  else if (rule.color !== undefined && rule.role !== undefined) context.addIssue({ code: "custom", message: "Use a hex color or a series role, not both" });
});

/** Exact metric labels, not array positions, identify a semantic series. */
export const seriesColorRulesSchema = z.array(seriesRule).max(24).superRefine((rules, context) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    const key = JSON.stringify([rule.label, rule.value]);
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "Each label and value may only have one color" });
    seen.add(key);
  });
});

export type SeriesColorRule = z.infer<typeof seriesColorRulesSchema>[number];

/**
 * How a widget assigns colours. "name" (the default, and what documents without the option get) keys each series to
 * its identity. "index" keeps the older order-based slots, so a series' colour follows its position in the result.
 */
export const SERIES_COLOR_MODES = ["name", "index"] as const;
export type SeriesColorMode = (typeof SERIES_COLOR_MODES)[number];
export const DEFAULT_SERIES_COLOR_MODE: SeriesColorMode = "name";

/** The first rule whose exact label and value match. */
export function matchingSeriesRule(labels: Readonly<Record<string, string>>, rules: readonly SeriesColorRule[] | undefined): SeriesColorRule | undefined {
  return rules?.find(entry => labels[entry.label] === entry.value);
}

/** The first rule whose exact label and value match sets the colour; a rule names a hex colour or a role. */
export function resolveSeriesColor(labels: Readonly<Record<string, string>>, rules: readonly SeriesColorRule[] | undefined, fallback: string): string {
  const rule = matchingSeriesRule(labels, rules);
  if (!rule) return fallback;
  return rule.color ?? (rule.role ? seriesRole(rule.role) : fallback);
}

/**
 * Well-known labels that name a role without an authored rule. Only these keys are recognised:
 * - status, status_code, http_status, http_status_code or response_code: a three-digit HTTP code, or a 2xx, 4xx or 5xx
 *   class, maps to success, client-error or server-error. 1xx and 3xx codes have no role.
 * - quantile (0.5, 0.95, 0.99, or p50, p95, p99) or percentile (50, 95, 99, or p50, p95, p99) map to p50, p95 and p99.
 * Histogram bucket bounds (le) are not quantiles and are never read here. Series names are never parsed.
 */
export const WELL_KNOWN_STATUS_LABELS = ["status", "status_code", "http_status", "http_status_code", "response_code"] as const;
/** Quantile labels; the value names the percentile, as 0.5 or p50 for quantile, and 50 or p50 for percentile. */
export const WELL_KNOWN_PERCENTILE_LABELS = ["quantile", "percentile"] as const;
const STATUS_CLASS_ROLES: Readonly<Record<string, SeriesRole>> = { "2": "success", "4": "client-error", "5": "server-error" };
const QUANTILE_ROLES = new Map<number, SeriesRole>([[0.5, "p50"], [0.95, "p95"], [0.99, "p99"]]);
const PERCENTILE_ROLES = new Map<number, SeriesRole>([[50, "p50"], [95, "p95"], [99, "p99"]]);
const PERCENTILE_NAME = /^p(50|95|99)$/i;
const percentileName = (value: string): SeriesRole | undefined => {
  const match = PERCENTILE_NAME.exec(value);
  return match ? (`p${match[1]}` as SeriesRole) : undefined;
};

function statusClassRole(value: string | undefined): SeriesRole | undefined {
  const match = /^([1-5])(?:\d{2}|xx)$/i.exec(value ?? "");
  return match ? STATUS_CLASS_ROLES[match[1]] : undefined;
}

export function wellKnownSeriesRole(labels: Readonly<Record<string, string>>): SeriesRole | undefined {
  for (const key of WELL_KNOWN_STATUS_LABELS) {
    const role = statusClassRole(labels[key]);
    if (role) return role;
  }
  const tables = { quantile: QUANTILE_ROLES, percentile: PERCENTILE_ROLES } as const;
  for (const key of WELL_KNOWN_PERCENTILE_LABELS) {
    const value = labels[key];
    if (value === undefined) continue;
    const role = tables[key].get(Number(value)) ?? percentileName(value);
    if (role) return role;
  }
  return undefined;
}

/**
 * The identity a series keeps across widgets and refreshes: its name, or its labels when it has none. It is the name
 * series-display.ts shows in full, never a shortened label. Labels are sorted so their order cannot change it.
 */
export function seriesIdentity(subject: SeriesColorSubject): string {
  if (subject.name) return subject.name;
  return Object.keys(subject.labels ?? {}).sort().map(key => `${key}=${subject.labels![key]}`).join(", ");
}

/** FNV-1a, 32 bit, over the UTF-8 bytes of the text. Deterministic across engines; the palette slot is the low three bits. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface SeriesColorSubject {
  name?: string;
  labels?: Readonly<Record<string, string>>;
}

export interface SeriesColorInput {
  mode?: SeriesColorMode;
  rules?: readonly SeriesColorRule[];
  /** The widget's own colour. It applies to the first series in identity order, unless a rule or a well-known label names one. */
  widgetColor?: string;
}

/** A drawn colour. `slot` is the zero-based palette slot when the colour is a shared slot or role, so the editor can show its hex. */
export interface SeriesColorChoice {
  color: string;
  slot?: number;
}

function ruleChoice(rule: SeriesColorRule): SeriesColorChoice {
  if (rule.color !== undefined) return { color: rule.color };
  const role = rule.role!;
  return { color: seriesRole(role), slot: SERIES_ROLE_SLOT[role] - 1 };
}

function roleChoice(role: SeriesRole): SeriesColorChoice {
  return { color: seriesRole(role), slot: SERIES_ROLE_SLOT[role] - 1 };
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One colour per series, in the order of `subjects`. Name mode is independent of that order: series are visited in
 * identity order and a hashed series steps to the next free slot when its home slot is taken, so no two series in
 * one widget share a slot while slots remain. Precedence: an authored rule, then a well-known label role, then the
 * widget colour, then the hashed slot. Index mode keeps the older order-based slots.
 */
/** Subjects in identity order, ties broken by their labels and then their position. */
function identityOrder(subjects: readonly SeriesColorSubject[]) {
  return subjects
    .map((subject, index) => ({ index, identity: seriesIdentity(subject), labels: JSON.stringify(Object.entries(subject.labels ?? {}).sort(([a], [b]) => compareText(a, b))) }))
    .sort((a, b) => compareText(a.identity, b.identity) || compareText(a.labels, b.labels) || a.index - b.index);
}

/**
 * The series a widget's own colour applies to: the first position in index mode, otherwise the first series in
 * identity order. It is -1 when there are no series. The palette swatch in the editor shows this series' colour.
 */
export function widgetColorSeriesIndex(subjects: readonly SeriesColorSubject[], mode: SeriesColorMode = DEFAULT_SERIES_COLOR_MODE): number {
  if (!subjects.length) return -1;
  return mode === "index" ? 0 : identityOrder(subjects)[0].index;
}

export function assignSeriesColors(subjects: readonly SeriesColorSubject[], input: SeriesColorInput = {}): SeriesColorChoice[] {
  const rules = input.rules ?? [];
  const widgetColor = input.widgetColor;
  if ((input.mode ?? DEFAULT_SERIES_COLOR_MODE) === "index") {
    return subjects.map((subject, index) => {
      const rule = matchingSeriesRule(subject.labels ?? {}, rules);
      if (rule) return ruleChoice(rule);
      if (index === 0 && widgetColor) return { color: widgetColor };
      return { color: seriesSlot(index), slot: index % SERIES_SLOTS };
    });
  }
  const order = identityOrder(subjects);
  const choices: (SeriesColorChoice | undefined)[] = new Array(subjects.length);
  const taken = new Set<number>();
  // Authored rules and well-known labels come first. Roles reserve their slot so hashed series keep off it.
  for (const { index } of order) {
    const labels = subjects[index].labels ?? {};
    const rule = matchingSeriesRule(labels, rules);
    if (rule) {
      choices[index] = ruleChoice(rule);
      if (rule.role) taken.add(SERIES_ROLE_SLOT[rule.role] - 1);
      continue;
    }
    const role = wellKnownSeriesRole(labels);
    if (role) {
      choices[index] = roleChoice(role);
      taken.add(SERIES_ROLE_SLOT[role] - 1);
    }
  }
  // The widget colour goes to the first series in identity order, when nothing above names that series.
  if (widgetColor && order.length && choices[order[0].index] === undefined) choices[order[0].index] = { color: widgetColor };
  for (const { index, identity } of order) {
    if (choices[index]) continue;
    const home = fnv1a32(identity) % SERIES_SLOTS;
    let slot = home;
    for (let step = 0; step < SERIES_SLOTS && taken.has(slot); step++) slot = (slot + 1) % SERIES_SLOTS;
    // Every slot is taken: repeat the home slot rather than the next one, so the repeat is still this series' own.
    if (taken.has(slot)) slot = home;
    taken.add(slot);
    choices[index] = { color: seriesSlot(slot), slot };
  }
  return choices as SeriesColorChoice[];
}

/** The fields of a widget that decide its series colours. */
export interface SeriesColorWidget {
  color?: string;
  options?: { seriesColors?: readonly SeriesColorRule[]; seriesColorMode?: SeriesColorMode };
}

/**
 * The colour of every series in a result, in result order. Renderers call this with the whole result, never a
 * zoomed, filtered or truncated slice, so hiding or zooming a series cannot recolour the others.
 */
/** `rules` replaces the widget's options.seriesColors; rich metrics passes the rules from its plugin configuration. */
export function widgetSeriesColors(series: readonly SeriesColorSubject[], widget: SeriesColorWidget, rules?: readonly SeriesColorRule[]): SeriesColorChoice[] {
  return assignSeriesColors(series, { mode: widget.options?.seriesColorMode, rules: rules ?? widget.options?.seriesColors, widgetColor: widget.color });
}
