// SLO evaluation for the slo-summary widget: validate the authored objective, compile the PromQL it runs, pick the step,
// and evaluate the returned windows. These are pure functions. The Go port is internal/insights/slo.go. Both run the shared
// cases in docs/design/insights/conformance/slo.json, so they cannot silently diverge.
//
// The result is an evaluation of the author's objective, not a health verdict. A negative budget is returned as is.
import type { QueryResult } from "./schema";

/** The built-in plugin id of the SLO summary widget. */
export const sloSummaryPluginId = "slo-summary";
export const SLO_PERIODS = ["1d", "7d", "28d", "30d"] as const;
export type SloPeriod = (typeof SLO_PERIODS)[number];
export type SloBurnAlerts = "multiwindow" | "page" | "none";
export type SloSeverity = "critical" | "warning";
export type SloState = "meeting" | "at_risk" | "breaching" | "unknown";
/** The overall state of an evaluation: a group's state, or partial when the result cannot prove meeting. */
export type SloOverallState = SloState | "partial";
export type SloReason = "budget_exhausted" | "fast_burn" | "slow_burn" | "no_traffic" | "no_data" | "incomplete";
export type SloErrorCode =
  | "invalid_config"
  | "unknown_key"
  | "invalid_objective"
  | "invalid_period"
  | "invalid_selector"
  | "good_bad_exclusive"
  | "invalid_burn_alerts"
  | "invalid_group_by"
  | "invalid_max_rows"
  | "query_too_long";

/** The authored objective. `bad` or `good` is set, never both. Defaults apply when a field is undefined. */
export type SloConfig = {
  objective: number;
  period: SloPeriod;
  total: string;
  bad?: string;
  good?: string;
  burnAlerts?: SloBurnAlerts;
  groupBy?: string;
  maxRows?: number;
};

/** The authored default: a 30 day availability objective on the conventional request counter. It validates as saved. */
export const SLO_DEFAULT_CONFIG: SloConfig = {
  objective: 99.9,
  period: "30d",
  total: "http_requests_total",
  bad: 'http_requests_total{code=~"5.."}',
  burnAlerts: "multiwindow",
};

export type SloBurn = {
  long: string;
  short: string;
  factor: number;
  severity: SloSeverity;
  longBurn: number | null;
  shortBurn: number | null;
  firing: boolean;
};

export type SloGroup = {
  labels: Record<string, string>;
  state: SloState;
  reasons: SloReason[];
  availability: number | null;
  errorRatio: number | null;
  budgetRemaining: number | null;
  total: number | null;
  bad: number | null;
  allowed: number | null;
  burn: SloBurn[];
};

export type SloEvaluation = {
  state: SloOverallState;
  reasons: SloReason[];
  counts: Record<SloState, number>;
  groups: SloGroup[];
  groupsOmitted: number;
};

export class SloConfigError extends Error {
  readonly code: SloErrorCode;

  constructor(code: SloErrorCode) {
    super(code);
    this.name = "SloConfigError";
    this.code = code;
  }
}

const DEFAULT_BURN_ALERTS: SloBurnAlerts = "multiwindow";
export const DEFAULT_MAX_ROWS = 6;
const MAX_ROWS_LIMIT = 12;
/** The provider returns at most this many series (providers.go maxSeries). A result over it is truncated. */
const PROVIDER_SERIES_LIMIT = 100;
const MAX_QUERY_LENGTH = 8192;
const MIN_OBJECTIVE = 50;
const MAX_OBJECTIVE = 99.9999;
const CONFIG_KEYS = ["objective", "period", "total", "bad", "good", "burnAlerts", "groupBy", "maxRows"] as const;
const SLO_RESERVED_LABELS = ["slo_window", "slo_part"];
const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A metric name, then an optional brace block of matchers. Each `{{name}}` placeholder is replaced by a quoted value before
// matching, so it is valid only in a matcher value position. Matchers take the form label op "value".
const SELECTOR = /^[A-Za-z_:][A-Za-z0-9_:]*(\{ *([A-Za-z_][A-Za-z0-9_]* *(=|!=|=~|!~) *"(?:[^"\\]|\\.)*" *(, *[A-Za-z_][A-Za-z0-9_]* *(=|!=|=~|!~) *"(?:[^"\\]|\\.)*" *)*,? *)?\})?$/;
const PLACEHOLDER = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g;

/** Window lengths in seconds. Burn windows are the only ones a compiled query asks for besides the period. */
const WINDOW_SECONDS: Record<string, number> = { "5m": 300, "30m": 1800, "1h": 3600, "2h": 7200, "6h": 21600, "1d": 86400, "3d": 259200 };
const PERIOD_SECONDS: Record<SloPeriod, number> = { "1d": 86400, "7d": 604800, "28d": 2419200, "30d": 2592000 };

/**
 * The SRE-workbook multiwindow pairs. `spent` is the share of the period's budget that the pair alerts on. The factor a pair
 * must reach is spent * period / long, so it scales to the period (14.4, 6, 3 and 1 for a 30 day period).
 */
const BURN_PAIRS: readonly { long: string; short: string; spent: number; severity: SloSeverity; page: boolean }[] = [
  { long: "1h", short: "5m", spent: 0.02, severity: "critical", page: true },
  { long: "6h", short: "30m", spent: 0.05, severity: "critical", page: true },
  { long: "1d", short: "2h", spent: 0.1, severity: "warning", page: false },
  { long: "3d", short: "6h", spent: 0.1, severity: "warning", page: false },
];

/** Groups order evaluated states worst first, then meeting, then unknown groups last. */
const STATE_RANK: Record<SloState, number> = { breaching: 0, at_risk: 1, meeting: 2, unknown: 3 };
const REASON_ORDER: SloReason[] = ["budget_exhausted", "fast_burn", "slow_burn", "no_traffic", "no_data", "incomplete"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A selector is a metric name with optional matchers. Placeholders stand in for quoted values, as they expand later. */
export function isSloSelector(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return SELECTOR.test(value.replace(PLACEHOLDER, '"x"'));
}

/** The label names an objective may group by. The SLO labels are reserved for the compiled query. */
export function isSloGroupLabel(value: string): boolean {
  return LABEL_NAME.test(value) && !SLO_RESERVED_LABELS.includes(value);
}

/** Whether an objective is a finite percent in range with at most four decimal places. */
export function isSloObjective(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_OBJECTIVE && value <= MAX_OBJECTIVE &&
    Math.abs(value * 10000 - Math.round(value * 10000)) <= 1e-6;
}

/**
 * Validates an authored SLO config. Returns the first error code, in the same order as the Go port, or undefined when valid.
 * Unknown keys, a non-finite or out-of-range objective, a selector with a function, range or offset, and a missing or
 * doubled bad/good are all rejected.
 */
export function validateSloConfig(config: unknown): SloErrorCode | undefined {
  if (!isRecord(config)) return "invalid_config";
  if (Object.keys(config).some((key) => !(CONFIG_KEYS as readonly string[]).includes(key))) return "unknown_key";

  const objective = config.objective;
  if (!isSloObjective(objective)) return "invalid_objective";
  if (typeof config.period !== "string" || !(SLO_PERIODS as readonly string[]).includes(config.period)) return "invalid_period";
  if (!isSloSelector(config.total)) return "invalid_selector";

  const hasBad = "bad" in config;
  const hasGood = "good" in config;
  if (hasBad === hasGood) return "good_bad_exclusive";
  if (!isSloSelector(hasBad ? config.bad : config.good)) return "invalid_selector";

  if ("burnAlerts" in config && !(config.burnAlerts === "multiwindow" || config.burnAlerts === "page" || config.burnAlerts === "none")) {
    return "invalid_burn_alerts";
  }
  if ("groupBy" in config && (typeof config.groupBy !== "string" || !isSloGroupLabel(config.groupBy))) {
    return "invalid_group_by";
  }
  if ("maxRows" in config && (typeof config.maxRows !== "number" || !Number.isInteger(config.maxRows) ||
    config.maxRows < 1 || config.maxRows > sloMaxRowsLimit(config as SloConfig))) {
    return "invalid_max_rows";
  }
  return undefined;
}

/**
 * The most groups a config may list: each group runs two series per window, and the provider returns 100 series at most, so a
 * larger maxRows could never be met without truncation. The multiwindow preset allows 6 groups, page 10 and none 12.
 */
export function sloMaxRowsLimit(config: SloConfig): number {
  return Math.min(MAX_ROWS_LIMIT, Math.floor(PROVIDER_SERIES_LIMIT / (2 * windowsOf(config).length)));
}

function burnAlertsOf(config: SloConfig): SloBurnAlerts {
  return config.burnAlerts ?? DEFAULT_BURN_ALERTS;
}

/** The pairs that apply to this config: the preset's pairs, minus any whose long window is not shorter than the period. */
function keptPairs(config: SloConfig) {
  const alerts = burnAlertsOf(config);
  if (alerts === "none") return [];
  const period = PERIOD_SECONDS[config.period];
  return BURN_PAIRS
    .filter((pair) => alerts === "multiwindow" || pair.page)
    .filter((pair) => WINDOW_SECONDS[pair.long] < period)
    .map((pair) => ({ ...pair, factor: (pair.spent * period) / WINDOW_SECONDS[pair.long] }));
}

/** The windows a query asks for: each kept pair's windows in ascending order, then the period window last. */
function windowsOf(config: SloConfig): string[] {
  const burn = new Set<string>();
  for (const pair of keptPairs(config)) {
    burn.add(pair.long);
    burn.add(pair.short);
  }
  return [...burn].sort((a, b) => WINDOW_SECONDS[a] - WINDOW_SECONDS[b]).concat(config.period);
}

/**
 * The PromQL the widget runs. Each window gives a total and a bad series, grouped by `groupBy`, labelled with `slo_window`
 * and `slo_part`. A bad series that is absent becomes zero for groups with traffic. A `good` selector gives bad as
 * clamp_min(total - good, 0). Placeholders pass through unchanged, because variables expand after compilation.
 * Throws SloConfigError("query_too_long") when the text exceeds 8192 characters before expansion.
 */
export function compileSloQuery(config: SloConfig): string {
  const groupBy = config.groupBy;
  const aggregate = (inner: string) => (groupBy ? `sum by (${groupBy})(${inner})` : `sum(${inner})`);
  const relabel = (expression: string, part: "total" | "bad", window: string) =>
    `label_replace(label_replace(${expression}, "slo_part", "${part}", "", ""), "slo_window", "${window}", "", "")`;

  const parts: string[] = [];
  for (const window of windowsOf(config)) {
    const total = aggregate(`increase(${config.total}[${window}])`);
    parts.push(relabel(total, "total", window));
    const bad = config.bad !== undefined
      ? `(${aggregate(`increase(${config.bad}[${window}])`)} or (0 * ${total}))`
      : `clamp_min(${total} - (${aggregate(`increase(${config.good}[${window}])`)} or (0 * ${total})), 0)`;
    parts.push(relabel(bad, "bad", window));
  }
  const query = parts.join(" or ");
  if (query.length > MAX_QUERY_LENGTH) throw new SloConfigError("query_too_long");
  return query;
}

/** The query step in seconds. It spans the range, so the query returns the start and end points only. */
export function sloStep(start: number, end: number): number {
  return Math.max(60, end - start);
}

/**
 * The evaluation timestamp: the newest timestamp any series reports, which is the range end the windows were evaluated at.
 * Only a sample at this timestamp is a current reading. A window with no sample there is absent, never its older start point.
 */
export function evaluationTimestamp(result: QueryResult): number | undefined {
  let newest: number | undefined;
  for (const series of result.series ?? []) {
    for (const point of series.points) {
      if (newest === undefined || point.timestamp > newest) newest = point.timestamp;
    }
  }
  return newest;
}

/** The finite sample at the evaluation timestamp. A missing or non-finite sample is not a reading. */
function valueAt(points: { timestamp: number; value: number | null }[], at: number): number | undefined {
  for (const point of points) {
    if (point.timestamp === at && typeof point.value === "number" && Number.isFinite(point.value)) return point.value;
  }
  return undefined;
}

/** A stable key for a label set: sorted name and value pairs, each followed by NUL, as the Go port builds it. */
function labelsKey(labels: Record<string, string>): string {
  return Object.keys(labels).sort().map((name) => `${name}\u0000${labels[name]}\u0000`).join("");
}

type GroupReadings ={ labels: Record<string, string>; values: Map<string, number> };

/** Groups the result's series by their labels other than the SLO labels, keeping each window's reading at the evaluation timestamp. */
function readGroups(result: QueryResult, windows: readonly string[]): Map<string, GroupReadings> {
  const groups = new Map<string, GroupReadings>();
  const at = evaluationTimestamp(result);
  if (at === undefined) return groups;
  for (const series of result.series ?? []) {
    const window = series.labels.slo_window;
    const part = series.labels.slo_part;
    if (window === undefined || !windows.includes(window) || (part !== "total" && part !== "bad")) continue;
    const labels: Record<string, string> = {};
    for (const key of Object.keys(series.labels).sort()) {
      if (!SLO_RESERVED_LABELS.includes(key)) labels[key] = series.labels[key];
    }
    const key = labelsKey(labels);
    let group = groups.get(key);
    if (group === undefined) {
      group = { labels, values: new Map() };
      groups.set(key, group);
    }
    const slot = `${window}|${part}`;
    const value = valueAt(series.points, at);
    if (!group.values.has(slot) && value !== undefined) group.values.set(slot, value);
  }
  return groups;
}

const unknownGroup = (labels: Record<string, string>, reason: SloReason, total: number | null, bad: number | null, burn: SloBurn[]): SloGroup => ({
  labels, state: "unknown", reasons: [reason], availability: null, errorRatio: null, budgetRemaining: null, total, bad, allowed: null, burn,
});

/** True when a group has a total and a bad reading for every window it was evaluated over. */
function groupComplete(values: Map<string, number>, windows: readonly string[]): boolean {
  return windows.every((window) => values.has(`${window}|total`) && values.has(`${window}|bad`));
}

/**
 * The overall state of an evaluation. It is the worst evaluated group's state, where evaluated means not unknown. When no
 * evaluated group is worse than meeting, but some group is unknown or a truncated grouped result may have dropped whole groups,
 * the overall is partial: it never reads meeting. A truncated ungrouped result has one group, exact when its readings arrived.
 * With no groups the state is unknown with no_data, and a truncated result adds incomplete. Reasons come from the groups that set the state.
 */
function overallOf(groups: SloGroup[], truncated: boolean, grouped: boolean): { state: SloOverallState; reasons: SloReason[] } {
  if (groups.length === 0) return { state: "unknown", reasons: truncated ? ["no_data", "incomplete"] : ["no_data"] };
  const hidden = truncated && grouped;
  let worst: SloState | undefined;
  for (const group of groups) {
    if (group.state === "unknown") continue;
    if (worst === undefined || STATE_RANK[group.state] < STATE_RANK[worst]) worst = group.state;
  }
  let state: SloOverallState;
  let source: SloGroup[];
  if (worst === undefined) {
    state = "unknown";
    source = groups;
  } else if (worst !== "meeting") {
    state = worst;
    source = groups.filter((group) => group.state === worst);
  } else if (hidden || groups.some((group) => group.state === "unknown")) {
    state = "partial";
    source = groups.filter((group) => group.state === "unknown");
  } else {
    state = "meeting";
    source = [];
  }
  // A truncated result can hide whole groups, so incomplete is always reported with it.
  const present = new Set<SloReason>(truncated ? ["incomplete"] : []);
  for (const group of source) for (const reason of group.reasons) present.add(reason);
  return { state, reasons: REASON_ORDER.filter((reason) => present.has(reason)) };
}

/**
 * Evaluates the windows of a result against the objective. Per group, the period's total and bad readings give the budget.
 * A burn pair fires when both its long and short burn reach its factor. The state is breaching when the budget is spent or a
 * critical pair fires, at risk when a warning pair fires, and meeting otherwise. A missing or zero period total is unknown,
 * because it is no traffic or no data, not zero errors. A truncated result can drop series, so a group missing any window reading
 * is incomplete and unknown; a group whose readings all arrived is exact. A truncated result always adds incomplete to the overall reasons.
 * Groups are ordered worst state first, then by budget, and listed up to maxRows.
 */
export function evaluateSlo(config: SloConfig, result: QueryResult): SloEvaluation {
  const windows = windowsOf(config);
  const pairs = keptPairs(config);
  const allowance = 1 - config.objective / 100;
  const truncated = result.truncated === true;

  const groups: SloGroup[] = [];
  for (const { labels, values } of readGroups(result, windows).values()) {
    const burn: SloBurn[] = pairs.map((pair) => ({
      long: pair.long, short: pair.short, factor: pair.factor, severity: pair.severity, longBurn: null, shortBurn: null, firing: false,
    }));
    const total = values.get(`${config.period}|total`);
    const bad = values.get(`${config.period}|bad`);
    // A truncated result can drop some of this group's series, so a group missing any window reading is incomplete.
    if (truncated && !groupComplete(values, windows)) {
      groups.push(unknownGroup(labels, "incomplete", total ?? null, bad ?? null, burn));
      continue;
    }
    if (total === undefined) {
      groups.push(unknownGroup(labels, "no_data", null, bad ?? null, burn));
      continue;
    }
    if (total <= 0) {
      groups.push(unknownGroup(labels, "no_traffic", total, bad ?? null, burn));
      continue;
    }
    if (bad === undefined) {
      groups.push(unknownGroup(labels, "no_data", total, null, burn));
      continue;
    }

    const errorRatio = bad / total;
    const allowed = total * allowance;
    const budgetRemaining = 100 * (1 - bad / allowed);
    const burnOf = (window: string, part: "total" | "bad") => values.get(`${window}|${part}`);
    const burnRate = (window: string): number | null => {
      const windowTotal = burnOf(window, "total");
      const windowBad = burnOf(window, "bad");
      return windowTotal === undefined || windowTotal <= 0 || windowBad === undefined ? null : (windowBad / windowTotal) / allowance;
    };
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index];
      const longBurn = burnRate(pair.long);
      const shortBurn = burnRate(pair.short);
      burn[index] = {
        ...burn[index],
        longBurn,
        shortBurn,
        firing: longBurn !== null && shortBurn !== null && longBurn >= pair.factor && shortBurn >= pair.factor,
      };
    }

    const reasons: SloReason[] = [];
    if (budgetRemaining <= 0) reasons.push("budget_exhausted");
    if (burn.some((entry) => entry.severity === "critical" && entry.firing)) reasons.push("fast_burn");
    if (burn.some((entry) => entry.severity === "warning" && entry.firing)) reasons.push("slow_burn");

    let state: SloState = "meeting";
    if (reasons.includes("budget_exhausted") || reasons.includes("fast_burn")) state = "breaching";
    else if (reasons.includes("slow_burn")) state = "at_risk";
    groups.push({
      labels,
      state,
      reasons,
      availability: 100 * (1 - errorRatio),
      errorRatio,
      budgetRemaining,
      total,
      bad,
      allowed,
      burn,
    });
  }

  groups.sort((a, b) => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank !== 0) return rank;
    const budgetA = a.budgetRemaining ?? Number.POSITIVE_INFINITY;
    const budgetB = b.budgetRemaining ?? Number.POSITIVE_INFINITY;
    if (budgetA !== budgetB) return budgetA - budgetB;
    const keyA = labelsKey(a.labels);
    const keyB = labelsKey(b.labels);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const counts: Record<SloState, number> = { meeting: 0, at_risk: 0, breaching: 0, unknown: 0 };
  for (const group of groups) counts[group.state]++;
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  const listed = groups.slice(0, maxRows);

  const overall = overallOf(groups, truncated, config.groupBy !== undefined);
  return { state: overall.state, reasons: overall.reasons, counts, groups: listed, groupsOmitted: groups.length - listed.length };
}
