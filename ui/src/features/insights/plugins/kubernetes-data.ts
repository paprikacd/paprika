import { z } from "zod";
import type { QueryResult, Widget } from "../schema";
import type { WidgetInputIssue } from "../widget-registry";
import { validTimestamp } from "../widget-context";
import { KUBERNETES_SIGNALS, isKubernetesSignal, type KubernetesFamily, type KubernetesSignal } from "./kubernetes-queries";

/** Pure data adapters for the Kubernetes widgets. They never throw on bad input: every problem becomes an issue. */

type Series = NonNullable<QueryResult["series"]>[number];
type Config = Widget["config"];

const labelName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use a Prometheus label name.");
const boolean = z.boolean();

export const placementConfigSchema = z.strictObject({
  resource: z.enum(["cpu", "memory"]).optional(),
  pressure: z.number().min(0.5).max(1).optional(),
  showPods: boolean.optional(),
  maxNodes: z.number().int().min(1).max(64).optional(),
});
export const resourceBarsConfigSchema = z.strictObject({
  groupLabel: labelName.optional(),
  maxGroups: z.number().int().min(1).max(16).optional(),
  showLimits: boolean.optional(),
  showValues: boolean.optional(),
});
export const throttleConfigSchema = z.strictObject({
  groupLabel: labelName.optional(),
  rows: z.number().int().min(6).max(24).optional(),
  ceiling: z.number().min(1).max(100).optional(),
});
export const resourceTrendConfigSchema = z.strictObject({
  showNetwork: boolean.optional(),
  showRequested: boolean.optional(),
  fill: boolean.optional(),
});

const DOCS = "See docs/design/insights/kubernetes-widgets.md.";

interface Entry {
  signal: KubernetesSignal;
  labels: Record<string, string>;
  series: Series;
}

/** The numeric value of a point, or null for a missing or invalid one. Negative and non-finite values are issues, not data. */
function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The newest valid sample. A null sample stays null: it is unavailable, never zero. */
export function latestValue(series: Series): number | null {
  let best: Series["points"][number] | undefined;
  for (const point of series.points) if (validTimestamp(point.timestamp) && (!best || point.timestamp >= best.timestamp)) best = point;
  return numberOf(best?.value);
}

/** The newest sample time in a series, whatever its value, or null when it has no valid sample. */
function lastTimestamp(series: Series): number | null {
  let latest: number | null = null;
  for (const point of series.points) if (validTimestamp(point.timestamp) && (latest === null || point.timestamp > latest)) latest = point.timestamp;
  return latest;
}

/**
 * The series that describe the present. Prometheus ends a series when its object goes away, so a pod deleted or
 * rescheduled during the range has an earlier last sample than the rest of the result. Placement and bars show the
 * current state, so a series whose last sample is more than one step before the newest sample is history and is left out.
 */
function currentOnly(entries: readonly Entry[]): Entry[] {
  const ends = entries.map(entry => lastTimestamp(entry.series));
  let latest: number | null = null;
  const times = new Set<number>();
  entries.forEach((entry, index) => {
    const end = ends[index];
    if (end !== null && (latest === null || end > latest)) latest = end;
    for (const point of entry.series.points) if (validTimestamp(point.timestamp)) times.add(point.timestamp);
  });
  if (latest === null) return [...entries];
  const floor = latest - medianSpacing([...times].sort((a, b) => a - b));
  return entries.filter((_, index) => { const end = ends[index]; return end !== null && end >= floor; });
}

function readEntries(result: QueryResult, family: KubernetesFamily) {
  const issues: WidgetInputIssue[] = [];
  const entries: Entry[] = [];
  for (const series of result.series ?? []) {
    const signal = series.labels?.signal;
    if (!signal) {
      issues.push({ message: `Each series needs a signal label, such as cpu-request. ${DOCS}` });
      continue;
    }
    if (!isKubernetesSignal(signal) || !(KUBERNETES_SIGNALS[signal].families as readonly string[]).includes(family)) {
      issues.push({ message: `Signal "${signal}" is not used by this widget.` });
      continue;
    }
    if (series.points.some(point => point.value !== null && numberOf(point.value) === null)) {
      issues.push({ message: `Signal ${signal} has a negative or non-finite value.` });
    }
    entries.push({ signal, labels: series.labels, series });
  }
  return { entries, issues };
}

/** One value per signal and identity. A second series for the same identity is an error, not a silent overwrite. */
function keyed(entries: readonly Entry[], identityOf: (entry: Entry) => string | null, issues: WidgetInputIssue[]) {
  const values = new Map<string, Map<KubernetesSignal, number | null>>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (identity === null) continue;
    const token = `${entry.signal}\u0000${identity}`;
    if (seen.has(token)) {
      issues.push({ message: `Duplicate ${entry.signal} series for ${identity}.` });
      continue;
    }
    seen.add(token);
    const row = values.get(identity) ?? new Map<KubernetesSignal, number | null>();
    row.set(entry.signal, latestValue(entry.series));
    values.set(identity, row);
  }
  return values;
}

const ratio = (used: number | null, requested: number | null) => (used !== null && requested !== null && requested > 0 ? used / requested : null);

function byNullableDesc<T>(items: T[], score: (item: T) => number | null, name: (item: T) => string) {
  return items.sort((a, b) => {
    const left = score(a), right = score(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) return right - left;
    return name(a).localeCompare(name(b));
  });
}

export interface PlacementPod {
  key: string;
  namespace: string;
  pod: string;
  node: string | null;
  cpuRequest: number | null;
  memoryRequest: number | null;
}
export interface PlacementNode {
  node: string;
  zone: string | null;
  ready: boolean | null;
  cpuAllocatable: number | null;
  memoryAllocatable: number | null;
  cpuRequested: number | null;
  memoryRequested: number | null;
  /** Requests over allocatable for the configured resource. Null when either side is unavailable. */
  pressure: number | null;
  pods: PlacementPod[];
}
export interface PlacementModel {
  resource: "cpu" | "memory";
  nodes: PlacementNode[];
  /** Nodes left out by the maxNodes cap, counted in the footer. */
  hiddenNodes: number;
  totalNodes: number;
  /** Pods with no node in the returned capacity, or with no node label at all. */
  pending: PlacementPod[];
  outside: PlacementPod[];
  pressureThreshold: number;
}

export function placementModel(result: QueryResult, config: Config): { model: PlacementModel; issues: WidgetInputIssue[] } {
  const parsed = placementConfigSchema.parse(config ?? {});
  const resource = parsed.resource ?? "cpu";
  const pressureThreshold = parsed.pressure ?? 0.85;
  const { entries, issues } = readEntries(result, "placement");

  const current = currentOnly(entries);
  const nodeKey = (entry: Entry) => (entry.labels.node ? entry.labels.node : null);
  const nodeValues = keyed(current.filter(e => e.signal.endsWith("-allocatable") || e.signal === "node-ready"), nodeKey, issues);
  // A pod is named by its namespace and pod labels. The namespace is optional: the namespace-scoped default query leaves
  // it out so that Prometheus sorts each node's capacity next to its pods (see kubernetes-queries.ts). A pod that was
  // pending and then scheduled has one request series per node label, and the newest one says where it is now. Two
  // series for the same pod and node label are a duplicate.
  const podKey = (entry: Entry) => (entry.labels.pod ? (entry.labels.namespace ? `${entry.labels.namespace}/${entry.labels.pod}` : entry.labels.pod) : null);
  const chosen = new Map<string, { key: string; entry: Entry }>();
  for (const entry of current) {
    if (entry.signal !== "cpu-request" && entry.signal !== "memory-request") continue;
    const key = podKey(entry);
    if (key === null) continue;
    const token = `${entry.signal}\u0000${key}`;
    const previous = chosen.get(token)?.entry;
    if (!previous) { chosen.set(token, { key, entry }); continue; }
    if ((previous.labels.node ?? "") === (entry.labels.node ?? "")) {
      issues.push({ message: `Duplicate ${entry.signal} series for ${key}.` });
      continue;
    }
    const newer = (lastTimestamp(entry.series) ?? -Infinity) - (lastTimestamp(previous.series) ?? -Infinity);
    if (newer > 0 || (newer === 0 && entry.labels.node && !previous.labels.node)) chosen.set(token, { key, entry });
  }
  // A pod with no request series for a resource declares no request, so it counts as zero, as the scheduler counts it.
  // A request series whose newest sample is missing stays null, and the node's sum is then unavailable.
  const pods = new Map<string, PlacementPod>();
  for (const { key, entry } of chosen.values()) {
    const pod = pods.get(key) ?? { key, namespace: entry.labels.namespace ?? "", pod: entry.labels.pod, node: null, cpuRequest: 0, memoryRequest: 0 };
    pods.set(key, pod);
    if (entry.labels.node) pod.node = entry.labels.node;
    if (entry.signal === "cpu-request") pod.cpuRequest = latestValue(entry.series);
    else pod.memoryRequest = latestValue(entry.series);
  }

  const nodes = new Map<string, PlacementNode>();
  for (const [node, row] of nodeValues) {
    const ready = row.get("node-ready");
    nodes.set(node, {
      node,
      zone: current.find(e => e.labels.node === node && e.labels.zone)?.labels.zone ?? null,
      ready: ready === undefined || ready === null ? null : ready === 1,
      cpuAllocatable: row.get("cpu-allocatable") ?? null,
      memoryAllocatable: row.get("memory-allocatable") ?? null,
      cpuRequested: null,
      memoryRequested: null,
      pressure: null,
      pods: [],
    });
  }
  const pending: PlacementPod[] = [], outside: PlacementPod[] = [];
  for (const pod of pods.values()) {
    if (!pod.node) { pending.push(pod); continue; }
    const node = nodes.get(pod.node);
    if (!node) { outside.push(pod); continue; }
    node.pods.push(pod);
  }
  for (const node of nodes.values()) {
    const sum = (key: "cpuRequest" | "memoryRequest") => node.pods.every(p => p[key] !== null) ? node.pods.reduce((total, p) => total + (p[key] ?? 0), 0) : null;
    node.cpuRequested = sum("cpuRequest");
    node.memoryRequested = sum("memoryRequest");
    const allocatable = resource === "cpu" ? node.cpuAllocatable : node.memoryAllocatable;
    const requested = resource === "cpu" ? node.cpuRequested : node.memoryRequested;
    node.pressure = ratio(requested, allocatable);
  }
  const all = byNullableDesc([...nodes.values()], node => node.pressure, node => node.node);
  const shown = all.slice(0, parsed.maxNodes ?? 24);
  return {
    model: {
      resource,
      nodes: shown,
      hiddenNodes: all.length - shown.length,
      totalNodes: all.length,
      pending: pending.sort((a, b) => a.key.localeCompare(b.key)),
      outside: outside.sort((a, b) => a.key.localeCompare(b.key)),
      pressureThreshold,
    },
    issues,
  };
}

export interface ResourceGroup {
  name: string;
  cpuUsage: number | null;
  cpuRequest: number | null;
  cpuLimit: number | null;
  memoryUsage: number | null;
  memoryRequest: number | null;
  memoryLimit: number | null;
}
export interface ResourceGroupsModel {
  groups: ResourceGroup[];
  totalGroups: number;
  hiddenGroups: number;
  groupLabel: string;
}

export function resourceGroups(result: QueryResult, config: Config): { model: ResourceGroupsModel; issues: WidgetInputIssue[] } {
  const parsed = resourceBarsConfigSchema.parse(config ?? {});
  const groupLabel = parsed.groupLabel ?? "pod";
  const read = readEntries(result, "bars");
  const issues = read.issues;
  const entries = currentOnly(read.entries);
  for (const entry of entries) if (!entry.labels[groupLabel]) issues.push({ message: `Series ${entry.signal} has no ${groupLabel} label.` });
  const values = keyed(entries.filter(e => e.labels[groupLabel]), entry => entry.labels[groupLabel] || null, issues);
  const groups: ResourceGroup[] = [...values].map(([name, row]) => ({
    name,
    cpuUsage: row.get("cpu-usage") ?? null,
    cpuRequest: row.get("cpu-request") ?? null,
    cpuLimit: row.get("cpu-limit") ?? null,
    memoryUsage: row.get("memory-usage") ?? null,
    memoryRequest: row.get("memory-request") ?? null,
    memoryLimit: row.get("memory-limit") ?? null,
  }));
  // Busiest first: the largest measured share of its request, on either resource.
  const busy = (group: ResourceGroup) => {
    const scores = [ratio(group.cpuUsage, group.cpuRequest), ratio(group.memoryUsage, group.memoryRequest)].filter((v): v is number => v !== null);
    return scores.length ? Math.max(...scores) : null;
  };
  const ordered = byNullableDesc(groups, busy, group => group.name);
  const maxGroups = parsed.maxGroups ?? 8;
  const shown = ordered.slice(0, maxGroups);
  return { model: { groups: shown, totalGroups: ordered.length, hiddenGroups: ordered.length - shown.length, groupLabel }, issues };
}

/** The most columns the throttle matrix draws. Longer results group consecutive samples into one column. */
export const MAX_THROTTLE_COLUMNS = 36;

export interface ThrottleColumn {
  timestamp: number;
  start: number;
  end: number;
  /** The samples grouped into this column. */
  samples: number;
}
export interface ThrottleCellValue extends ThrottleColumn {
  /** Mean throttled periods per sample, over the samples where both counts are known. */
  throttled: number | null;
  /** Mean periods per sample. */
  periods: number | null;
  /** Throttled over periods, in percent. Null for a missing or zero-period cell. */
  percent: number | null;
  /** The cell was observed but had no CFS periods. It is neutral, not zero. */
  neutral: boolean;
  /** Samples with both counts known, and their sums, for the row and column summaries. */
  paired: number;
  sumThrottled: number;
  sumPeriods: number;
}
export interface ThrottleRow {
  name: string;
  cells: ThrottleCellValue[];
  throttled: number;
  periods: number;
  percent: number | null;
}
export interface ThrottleModel {
  rows: ThrottleRow[];
  columns: ThrottleColumn[];
  totalRows: number;
  groupLabel: string;
  /** Column summaries: throttled over periods across every row. */
  columnPercent: (number | null)[];
  ceiling: number;
  rowsPerPage: number;
}

/** Median spacing between samples, used for the first cell's start when there is no earlier sample. */
function medianSpacing(times: number[]) {
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

/** `maxColumns` is how many time columns fit the tile; the renderer measures it, and it never exceeds MAX_THROTTLE_COLUMNS. */
export function throttleCells(result: QueryResult, config: Config, maxColumns = MAX_THROTTLE_COLUMNS): { model: ThrottleModel; issues: WidgetInputIssue[] } {
  const parsed = throttleConfigSchema.parse(config ?? {});
  const groupLabel = parsed.groupLabel ?? "pod";
  const { entries, issues } = readEntries(result, "throttle");
  const samples = new Map<string, Map<number, { throttled: number | null; periods: number | null }>>();
  const times = new Set<number>();
  for (const entry of entries) {
    const name = entry.labels[groupLabel];
    if (!name) { issues.push({ message: `Series ${entry.signal} has no ${groupLabel} label.` }); continue; }
    const row = samples.get(name) ?? new Map();
    samples.set(name, row);
    for (const point of entry.series.points) {
      if (!validTimestamp(point.timestamp)) continue;
      times.add(point.timestamp);
      const cell = row.get(point.timestamp) ?? { throttled: null, periods: null };
      const value = numberOf(point.value);
      const field = entry.signal === "throttled" ? "throttled" : "periods";
      // A second series for the same pod, signal and sample is ambiguous, so it is reported rather than overwritten.
      if (cell[field] !== null && cell[field] !== value) issues.push({ message: `Duplicate ${entry.signal} sample for ${name}.` });
      cell[field] = value;
      row.set(point.timestamp, cell);
    }
  }
  const sorted = [...times].sort((a, b) => a - b);
  const spacing = medianSpacing(sorted);
  // A range query returns about 300 samples, more than a tile can draw or a keyboard can step through. Consecutive
  // samples are grouped into at most MAX_THROTTLE_COLUMNS columns of equal sample count.
  const limit = Math.max(1, Math.min(MAX_THROTTLE_COLUMNS, Math.floor(maxColumns)));
  const size = Math.max(1, Math.ceil(sorted.length / limit));
  const buckets: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) buckets.push(sorted.slice(i, i + size));
  const columns: ThrottleColumn[] = buckets.map((bucket, i) => ({
    timestamp: bucket[bucket.length - 1],
    start: i === 0 ? bucket[0] - spacing : buckets[i - 1][buckets[i - 1].length - 1],
    end: bucket[bucket.length - 1],
    samples: bucket.length,
  }));
  const rows: ThrottleRow[] = [...samples].map(([name, row]) => {
    let exceeded = false;
    // Totals only count samples where both counts are known, so a sample with a missing period count never inflates the ratio.
    let throttled = 0, periods = 0;
    const cells: ThrottleCellValue[] = columns.map((column, i) => {
      let sumThrottled = 0, sumPeriods = 0, paired = 0, knownPeriods = 0, periodsOnly = 0;
      for (const timestamp of buckets[i]) {
        const cell = row.get(timestamp);
        if (!cell) continue;
        if (cell.throttled !== null && cell.periods !== null) {
          if (cell.throttled > cell.periods) exceeded = true;
          sumThrottled += cell.throttled;
          sumPeriods += cell.periods;
          paired++;
        } else if (cell.periods !== null) {
          periodsOnly += cell.periods;
          knownPeriods++;
        }
      }
      throttled += sumThrottled;
      periods += sumPeriods;
      // A cell shows the mean count per sample: the samples are overlapping five-minute windows, so their sum is not a count.
      const cellThrottled = paired ? sumThrottled / paired : null;
      const cellPeriods = paired ? sumPeriods / paired : knownPeriods ? periodsOnly / knownPeriods : null;
      const percent = paired && sumPeriods > 0 ? (sumThrottled / sumPeriods) * 100 : null;
      return { ...column, throttled: cellThrottled, periods: cellPeriods, percent, neutral: paired > 0 && sumPeriods === 0, paired, sumThrottled, sumPeriods };
    });
    if (exceeded) issues.push({ message: `Throttled periods exceed periods for ${name}.` });
    return { name, cells, throttled, periods, percent: periods > 0 ? (throttled / periods) * 100 : null };
  });
  const ordered = byNullableDesc(rows, row => row.percent, row => row.name);
  const columnPercent = columns.map((_, i) => {
    let throttled = 0, periods = 0;
    for (const row of rows) {
      throttled += row.cells[i].sumThrottled;
      periods += row.cells[i].sumPeriods;
    }
    return periods > 0 ? (throttled / periods) * 100 : null;
  });
  return {
    model: {
      rows: ordered,
      columns,
      totalRows: ordered.length,
      groupLabel,
      columnPercent,
      ceiling: parsed.ceiling ?? 50,
      rowsPerPage: parsed.rows ?? 12,
    },
    issues,
  };
}

export interface TrendPoint {
  timestamp: number;
  value: number | null;
}
export interface ResourceTrendModel {
  lines: Partial<Record<KubernetesSignal, TrendPoint[]>>;
  timestamps: number[];
}

export function resourceStrips(result: QueryResult, config: Config): { model: ResourceTrendModel; issues: WidgetInputIssue[] } {
  resourceTrendConfigSchema.parse(config ?? {});
  const { entries, issues } = readEntries(result, "trend");
  const lines: Partial<Record<KubernetesSignal, TrendPoint[]>> = {};
  const counts = new Map<KubernetesSignal, number>();
  for (const entry of entries) {
    counts.set(entry.signal, (counts.get(entry.signal) ?? 0) + 1);
    if ((counts.get(entry.signal) ?? 0) > 1) {
      issues.push({ message: `More than one series for ${entry.signal}; each strip needs one.` });
      continue;
    }
    lines[entry.signal] = entry.series.points
      .filter(point => validTimestamp(point.timestamp))
      .map(point => ({ timestamp: point.timestamp, value: numberOf(point.value) }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }
  const timestamps = [...new Set(Object.values(lines).flatMap(line => (line ?? []).map(point => point.timestamp)))].sort((a, b) => a - b);
  return { model: { lines, timestamps }, issues };
}
