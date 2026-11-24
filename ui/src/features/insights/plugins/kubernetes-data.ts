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

  const nodeKey = (entry: Entry) => (entry.labels.node ? entry.labels.node : null);
  const nodeValues = keyed(entries.filter(e => e.signal.endsWith("-allocatable") || e.signal === "node-ready"), nodeKey, issues);
  const podValues = keyed(entries.filter(e => e.signal === "cpu-request" || e.signal === "memory-request"), entry => {
    const namespace = entry.labels.namespace, pod = entry.labels.pod;
    return namespace && pod ? `${namespace}/${pod}` : null;
  }, issues);
  // Node labels for each pod come from the request series. The node label is empty for a pending pod.
  const pods = new Map<string, PlacementPod>();
  for (const entry of entries) {
    if (entry.signal !== "cpu-request" && entry.signal !== "memory-request") continue;
    const key = `${entry.labels.namespace ?? ""}/${entry.labels.pod ?? ""}`;
    if (!entry.labels.namespace || !entry.labels.pod) continue;
    const row = podValues.get(key);
    if (!pods.has(key)) pods.set(key, { key, namespace: entry.labels.namespace, pod: entry.labels.pod, node: entry.labels.node || null, cpuRequest: null, memoryRequest: null });
    const pod = pods.get(key)!;
    if (entry.labels.node) pod.node = entry.labels.node;
    if (entry.signal === "cpu-request") pod.cpuRequest = row?.get("cpu-request") ?? null;
    else pod.memoryRequest = row?.get("memory-request") ?? null;
  }

  const nodes = new Map<string, PlacementNode>();
  for (const [node, row] of nodeValues) {
    const ready = row.get("node-ready");
    nodes.set(node, {
      node,
      zone: entries.find(e => e.labels.node === node && e.labels.zone)?.labels.zone ?? null,
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
  const { entries, issues } = readEntries(result, "bars");
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

export interface ThrottleColumn {
  timestamp: number;
  start: number;
  end: number;
}
export interface ThrottleCellValue {
  timestamp: number;
  start: number;
  end: number;
  throttled: number | null;
  periods: number | null;
  /** Throttled over periods, in percent. Null for a missing or zero-period cell. */
  percent: number | null;
  /** The cell was observed but had no CFS periods. It is neutral, not zero. */
  neutral: boolean;
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

export function throttleCells(result: QueryResult, config: Config): { model: ThrottleModel; issues: WidgetInputIssue[] } {
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
  const columns: ThrottleColumn[] = sorted.map((timestamp, i) => ({ timestamp, start: i === 0 ? timestamp - spacing : sorted[i - 1], end: timestamp }));
  const rows: ThrottleRow[] = [...samples].map(([name, row]) => {
    const cells: ThrottleCellValue[] = columns.map(column => {
      const cell = row.get(column.timestamp) ?? { throttled: null, periods: null };
      if (cell.throttled !== null && cell.periods !== null && cell.throttled > cell.periods) {
        issues.push({ message: `Throttled periods exceed periods for ${name}.` });
      }
      const percent = cell.periods && cell.throttled !== null ? (cell.throttled / cell.periods) * 100 : null;
      return { ...column, throttled: cell.throttled, periods: cell.periods, percent, neutral: cell.periods === 0 };
    });
    const throttled = cells.reduce((total, c) => total + (c.throttled ?? 0), 0);
    const periods = cells.reduce((total, c) => total + (c.periods ?? 0), 0);
    return { name, cells, throttled, periods, percent: periods > 0 ? (throttled / periods) * 100 : null };
  });
  const ordered = byNullableDesc(rows, row => row.percent, row => row.name);
  const columnPercent = columns.map((_, i) => {
    let throttled = 0, periods = 0;
    for (const row of rows) {
      const cell = row.cells[i];
      if (cell.throttled === null || cell.periods === null) continue;
      throttled += cell.throttled;
      periods += cell.periods;
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
