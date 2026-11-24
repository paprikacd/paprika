"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { DrilldownContext } from "../drilldown";
import { EmptyState } from "../chart-renderers";
import { formatMetricDetails } from "../chart-data";
import { densityPalette } from "../density-palette";
import { seriesSlot } from "../series-palette";
import { statusToken } from "../status";
import { niceAxis, sharedScale } from "../units";
import { truncationNote } from "../truncation";
import type { WidgetRendererProps } from "../widget-registry";
import { placementConfigSchema, placementModel, resourceBarsConfigSchema, resourceGroups, resourceStrips, resourceTrendConfigSchema, throttleCells, throttleConfigSchema } from "./kubernetes-data";

/**
 * Renderers for the Kubernetes widgets. They draw with inline styles that read the design tokens, so they add no CSS
 * module rules to the Insights first view. Every number goes through the shared formatters and honours `decimals`.
 * Interaction is native: each mark is a button (or a labelled image when embedded) with a title, so no tooltip owner is needed.
 */

const RESOURCE_UNIT = { cpu: "cores", memory: "B" } as const;
const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, var(--gamma-chart-hatch) 0 2px, transparent 2px 6px)" };

interface MarkProps {
  interactive: boolean;
  label: string;
  context: DrilldownContext;
  onActivate?: (context: DrilldownContext) => void;
  onContextChange?: (context: DrilldownContext) => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A mark that reports its context on activation. Embedded copies are static images with the same label. */
function Mark({ interactive, label, context, onActivate, onContextChange, className, style, children }: MarkProps) {
  if (!interactive) return <span role="img" aria-label={label} title={label} className={className} style={style}>{children}</span>;
  return <button type="button" aria-label={label} title={label} className={className} style={style}
    onFocus={() => onContextChange?.(context)} onClick={() => (onActivate ?? onContextChange)?.(context)}>{children}</button>;
}

const text = (value: number | null, unit: string, decimals?: number) => (value === null ? "No data" : formatMetricDetails(value, unit, decimals));

export function KubernetesPlacement({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = placementConfigSchema.parse(widget.config ?? {});
  const { model } = placementModel(result, config);
  const interactive = !embedded;
  if (!model.nodes.length && !model.pending.length && !model.outside.length) return <EmptyState />;
  const unit = RESOURCE_UNIT[model.resource];
  const decimals = widget.options?.decimals;
  const note = truncationNote(result);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs" data-kubernetes="placement">
      <ul className="flex flex-col gap-3" aria-label={`${widget.title} nodes`}>
        {model.nodes.map(node => {
          const allocatable = model.resource === "cpu" ? node.cpuAllocatable : node.memoryAllocatable;
          const pressure = node.pressure;
          const tone = pressure === null ? "var(--gamma-muted)" : pressure > 1 ? statusToken("critical") : pressure >= model.pressureThreshold ? statusToken("warning") : "var(--gamma-ink)";
          const pods = [...node.pods].sort((a, b) => (b[model.resource === "cpu" ? "cpuRequest" : "memoryRequest"] ?? 0) - (a[model.resource === "cpu" ? "cpuRequest" : "memoryRequest"] ?? 0));
          return (
            <li key={node.node} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-[var(--gamma-ink)]">{node.node}{node.zone ? ` · ${node.zone}` : ""}{node.ready === false ? " · Not ready" : ""}</span>
                <span style={{ color: tone }}>{pressure === null ? "No data" : `${formatMetricDetails(pressure * 100, "%", decimals)} requested`}</span>
              </div>
              <div role="img" aria-label={`${node.node} ${model.resource} requests ${text(pressure === null ? null : pressure * 100, "%", decimals)} of allocatable`}
                className="relative flex h-3 w-full overflow-hidden rounded-sm" style={{ background: "var(--gamma-chart-empty)" }}>
                {pods.map((pod, index) => {
                  const request = model.resource === "cpu" ? pod.cpuRequest : pod.memoryRequest;
                  if (!allocatable || request === null) return null;
                  const width = Math.min(100, (request / allocatable) * 100);
                  return <Mark key={pod.key} interactive={interactive} label={`${pod.pod}: ${text(request, unit, decimals)}`}
                    context={{ series: pod.pod, labels: { node: node.node, namespace: pod.namespace, pod: pod.pod } }}
                    onActivate={onActivate} onContextChange={onContextChange} className="block h-full" style={{ width: `${width}%`, background: seriesSlot(index) }}>{null}</Mark>;
                })}
              </div>
              {model.resource === "cpu" && node.cpuRequested !== null && allocatable !== null && <span className="text-[var(--gamma-muted)]">{text(node.cpuRequested, unit, decimals)} of {text(allocatable, unit, decimals)}</span>}
              {model.resource === "memory" && node.memoryRequested !== null && allocatable !== null && <span className="text-[var(--gamma-muted)]">{text(node.memoryRequested, unit, decimals)} of {text(allocatable, unit, decimals)}</span>}
              {config.showPods !== false && node.pods.length > 0 && <span className="truncate text-[var(--gamma-muted)]">{node.pods.map(pod => pod.pod).join(", ")}</span>}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--gamma-muted)]">
        {model.hiddenNodes > 0 && <span>Showing {model.nodes.length} of {model.totalNodes} nodes</span>}
        <span>{model.pending.length} pending {model.pending.length === 1 ? "pod" : "pods"}</span>
        {model.outside.length > 0 && <span>{model.outside.length} outside returned nodes</span>}
        {note && <span>{note}</span>}
      </div>
    </div>
  );
}

export function KubernetesResourceBars({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = resourceBarsConfigSchema.parse(widget.config ?? {});
  const { model } = resourceGroups(result, config);
  const interactive = !embedded;
  if (!model.groups.length) return <EmptyState />;
  const decimals = widget.options?.decimals;
  const showLimits = config.showLimits !== false, showValues = config.showValues !== false;
  const maxOf = (pick: (g: (typeof model.groups)[number]) => (number | null)[]) => Math.max(1, ...model.groups.flatMap(pick).filter((v): v is number => v !== null));
  const scale = {
    cpu: maxOf(g => [g.cpuUsage, g.cpuRequest, g.cpuLimit]),
    memory: maxOf(g => [g.memoryUsage, g.memoryRequest, g.memoryLimit]),
  };
  const cell = (name: string, group: string, usage: number | null, request: number | null, limit: number | null, max: number, unit: string, colour: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[var(--gamma-muted)]">{name}</span>
      <div className="relative h-3 w-full rounded-sm" style={{ background: "var(--gamma-chart-empty)" }}>
        {usage === null
          ? <div className="absolute inset-0 rounded-sm" style={HATCH} role="img" aria-label={`${group} ${name} usage: No data`} title={`${group} ${name} usage: No data`} />
          : <Mark interactive={interactive} label={`${group} ${name} usage ${text(usage, unit, decimals)}`} context={{ series: group, labels: { [model.groupLabel]: group } }}
              onActivate={onActivate} onContextChange={onContextChange} className="absolute inset-y-0 left-0 block rounded-sm" style={{ width: `${(usage / max) * 100}%`, background: colour }}>{null}</Mark>}
        {request !== null && <span aria-hidden className="absolute inset-y-0 w-px" style={{ left: `${(request / max) * 100}%`, background: "var(--gamma-ink)" }} title={`Request ${text(request, unit, decimals)}`} />}
        {showLimits && limit !== null && <span aria-hidden className="absolute inset-y-0 w-0 border-l border-dashed" style={{ left: `${(limit / max) * 100}%`, borderColor: "var(--gamma-muted)" }} title={`Limit sum ${text(limit, unit, decimals)}. Only containers that declare a limit are summed.`} />}
      </div>
      {showValues && <span className="truncate text-[var(--gamma-muted)]">{text(usage, unit, decimals)} of {text(request, unit, decimals)}</span>}
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs" data-kubernetes="bars">
      <div className="flex flex-col gap-3">
        {model.groups.map(group => (
          <div key={group.name} className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
            <span className="truncate font-medium text-[var(--gamma-ink)]" title={group.name}>{group.name}</span>
            {cell("CPU", group.name, group.cpuUsage, group.cpuRequest, group.cpuLimit, scale.cpu, "cores", seriesSlot(0))}
            {cell("Memory", group.name, group.memoryUsage, group.memoryRequest, group.memoryLimit, scale.memory, "B", seriesSlot(1))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 text-[var(--gamma-muted)]">
        {model.hiddenGroups > 0 && <span>Showing {model.groups.length} of {model.totalGroups}</span>}
        {truncationNote(result) && <span>{truncationNote(result)}</span>}
      </div>
    </div>
  );
}

export function KubernetesThrottleMatrix({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = throttleConfigSchema.parse(widget.config ?? {});
  const { model } = throttleCells(result, config);
  const [page, setPage] = useState(0);
  const interactive = !embedded;
  if (!model.rows.length) return <EmptyState />;
  const decimals = widget.options?.decimals;
  const pages = Math.max(1, Math.ceil(model.totalRows / model.rowsPerPage));
  const current = Math.min(page, pages - 1);
  const rows = model.rows.slice(current * model.rowsPerPage, (current + 1) * model.rowsPerPage);
  const colour = (percent: number | null, neutral: boolean, throttled: number | null): CSSProperties => {
    if (throttled === null) return HATCH;
    if (neutral || percent === null) return { background: "var(--gamma-chart-empty)" };
    const index = Math.min(densityPalette.length - 1, Math.round(Math.max(0, Math.min(1, percent / model.ceiling)) * (densityPalette.length - 1)));
    return { background: densityPalette[index] };
  };
  const columns = `repeat(${model.columns.length}, minmax(6px, 1fr))`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 text-xs" data-kubernetes="throttle">
      <div className="grid gap-px" style={{ gridTemplateColumns: `minmax(0,7rem) ${columns} 4.5rem` }}>
        <span className="text-[var(--gamma-muted)]">{model.groupLabel}</span>
        <span className="text-right text-[var(--gamma-muted)]">Total</span>
        {rows.map(row => (
          <div key={row.name} className="contents">
            <span className="truncate pr-2 text-[var(--gamma-ink)]" title={row.name}>{row.name}</span>
            {row.cells.map(c => {
              const label = `${row.name} at ${new Date(c.timestamp).toISOString()}: ${c.throttled === null ? "No data" : c.neutral ? "No CFS periods" : text(c.percent, "%", decimals)}`;
              return <Mark key={c.timestamp} interactive={interactive} label={label} context={{ series: row.name, labels: { [model.groupLabel]: row.name } }}
                onActivate={onActivate} onContextChange={onContextChange} className="block h-4 min-w-0" style={colour(c.percent, c.neutral, c.throttled)}>{null}</Mark>;
            })}
            <span className="text-right tabular-nums">{text(row.percent, "%", decimals)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--gamma-muted)]">
        <span>Colour ceiling {text(model.ceiling, "%", decimals)} · hatched: no data · grey: no CFS periods</span>
        {pages > 1 && <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous rows" disabled={current === 0} onClick={() => setPage(current - 1)} className="disabled:opacity-40">Previous rows</button>
          <span>{current + 1} / {pages}</span>
          <button type="button" aria-label="Next rows" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="disabled:opacity-40">Next rows</button>
        </div>}
      </div>
    </div>
  );
}

const STRIP_HEIGHT = 72;
const STRIP_WIDTH = 600;

export function KubernetesResourceTrend({ widget, result }: WidgetRendererProps) {
  const config = resourceTrendConfigSchema.parse(widget.config ?? {});
  const { model } = resourceStrips(result, config);
  if (!model.timestamps.length) return <EmptyState />;
  const decimals = widget.options?.decimals;
  const t0 = model.timestamps[0], t1 = model.timestamps[model.timestamps.length - 1];
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * STRIP_WIDTH : 0);
  const strips = [
    { id: "cpu", title: "CPU", unit: "cores", lines: [["cpu-usage", seriesSlot(0), true], ["cpu-request", "var(--gamma-muted)", false]] as const },
    { id: "memory", title: "Memory", unit: "B", lines: [["memory-usage", seriesSlot(1), true], ["memory-request", "var(--gamma-muted)", false]] as const },
    ...(config.showNetwork !== false ? [{ id: "network", title: "Network", unit: "B/s", lines: [["network-rx", seriesSlot(2), false], ["network-tx", seriesSlot(3), false]] as const }] : []),
  ].filter(strip => strip.id !== "network" || strip.lines.some(([signal]) => model.lines[signal]));
  const showRequested = config.showRequested !== false, fill = config.fill !== false;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-xs" data-kubernetes="trend">
      {strips.map(strip => {
        const values = strip.lines.flatMap(([signal]) => (model.lines[signal] ?? []).map(p => p.value ?? 0));
        const axis = niceAxis([0, Math.max(1, ...values)], 3);
        const scale = sharedScale(values, strip.unit, { decimals, axis: axis.ticks });
        const y = (value: number) => STRIP_HEIGHT - (value / axis.domain[1]) * STRIP_HEIGHT;
        const path = (points: { timestamp: number; value: number | null }[]) => {
          let d = "", open = false;
          for (const point of points) {
            if (point.value === null) { open = false; continue; }
            d += `${open ? "L" : "M"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)} `;
            open = true;
          }
          return d.trim();
        };
        const latest = (signal: string) => { const points = model.lines[signal as keyof typeof model.lines] ?? []; for (let i = points.length - 1; i >= 0; i--) if (points[i].value !== null) return points[i].value; return null; };
        return (
          <div key={strip.id} className="flex flex-col gap-1" data-trend-strip={strip.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-[var(--gamma-ink)]">{strip.title}</span>
              <span className="flex flex-wrap gap-x-3 text-[var(--gamma-muted)]">
                {strip.lines.map(([signal]) => <span key={signal}>{signal.replace(/^[a-z]+-/, "")} {text(latest(signal), strip.unit, decimals)}</span>)}
              </span>
            </div>
            <svg viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`} width="100%" height={STRIP_HEIGHT} preserveAspectRatio="none" role="img" aria-label={`${strip.title} over time`} className="overflow-visible">
              <line x1={0} x2={STRIP_WIDTH} y1={STRIP_HEIGHT} y2={STRIP_HEIGHT} stroke="var(--gamma-chart-grid)" />
              {strip.lines.filter(([, , measured]) => measured || showRequested).map(([signal, colour, measured]) => {
                const points = model.lines[signal] ?? [];
                const d = path(points);
                if (!d) return null;
                const dashed = !measured;
                return <g key={signal}>
                  {measured && fill && <path d={`${d} L${x(points[points.length - 1]?.timestamp ?? t0).toFixed(1)} ${STRIP_HEIGHT} L${x(points[0]?.timestamp ?? t0).toFixed(1)} ${STRIP_HEIGHT} Z`} fill={colour} fillOpacity={0.18} />}
                  <path d={d} fill="none" stroke={colour} strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
                </g>;
              })}
            </svg>
            <span className="sr-only">{strip.title} ticks: {axis.ticks.map(tick => scale.number(tick)).join(", ")}</span>
          </div>
        );
      })}
    </div>
  );
}
