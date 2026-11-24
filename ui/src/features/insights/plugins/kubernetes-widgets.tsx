"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { DrilldownContext } from "../drilldown";
import { EmptyState } from "../chart-renderers";
import { formatMetricDetails } from "../chart-data";
import { densityPalette } from "../density-palette";
import { seriesSlot } from "../series-palette";
import { niceAxis, sharedScale } from "../units";
import { truncationNote } from "../truncation";
import type { WidgetRendererProps } from "../widget-registry";
import { resourceBarsConfigSchema, resourceGroups, resourceStrips, resourceTrendConfigSchema, throttleCells, throttleConfigSchema, type ThrottleColumn } from "./kubernetes-data";
import { sampleTime, text, useObservations, useRoving, type Observation, type Observed, type RovingProps } from "./kubernetes-observations";

/**
 * Renderers for the Kubernetes bars, throttle and trend widgets. They draw with inline styles that read the design
 * tokens, so they add no CSS module rules to the Insights first view. Every number goes through the shared formatters
 * and honours `decimals`. Hover, focus and click open the shared observation tooltip. Embedded copies are static images.
 * The placement treemap lives in kubernetes-placement.tsx.
 */

const HATCH: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, var(--gamma-chart-hatch) 0 2px, transparent 2px 6px)" };

interface MarkProps {
  interactive: boolean;
  label: string;
  context: DrilldownContext;
  observed?: Observed;
  onActivate?: (context: DrilldownContext) => void;
  onContextChange?: (context: DrilldownContext) => void;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /** The widget's single tab stop and arrow-key movement. A native button needs no `activate`. */
  keys?: RovingProps;
}

/** A mark that reports its context on activation and opens its observation. Embedded copies are static images. */
function Mark({ interactive, label, context, observed, onActivate, onContextChange, className, style, children, keys }: MarkProps) {
  if (!interactive) return <span role="img" aria-label={label} className={className} style={style}>{children}</span>;
  const trigger = observed?.trigger;
  return <button type="button" aria-label={label} data-observation={observed?.index} className={className} style={style}
    tabIndex={keys?.tabIndex} data-roving={keys?.["data-roving"]} onKeyDown={keys?.onKeyDown}
    onPointerEnter={trigger?.onPointerEnter} onPointerLeave={trigger?.onPointerLeave}
    onFocus={event => { keys?.onFocus(); onContextChange?.(context); trigger?.onFocus(event); }} onBlur={trigger?.onBlur}
    onClick={event => { (onActivate ?? onContextChange)?.(context); trigger?.onClick(event); }}>{children}</button>;
}

export function KubernetesResourceBars({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = resourceBarsConfigSchema.parse(widget.config ?? {});
  const { model } = resourceGroups(result, config);
  const interactive = !embedded;
  const decimals = widget.options?.decimals;
  const showLimits = config.showLimits !== false, showValues = config.showValues !== false;
  const at = sampleTime(result.series);
  const observations: Observation[] = model.groups.flatMap(group => {
    const cells: [string, number | null, number | null, number | null, string][] = [
      ["CPU", group.cpuUsage, group.cpuRequest, group.cpuLimit, "cores"],
      ["Memory", group.memoryUsage, group.memoryRequest, group.memoryLimit, "B"],
    ];
    return cells.flatMap(([name, usage, request, limit, unit]): Observation[] => {
      if (usage === null) return [];
      const labels = { [model.groupLabel]: group.name };
      return [{
        key: `${group.name}|${name}`, subject: `${group.name} ${name}`, unit, description: `${name} usage`,
        series: { name: group.name, labels, points: [{ timestamp: at, value: usage }] }, point: { timestamp: at, value: usage },
        detail: <span>Request {text(request, unit, decimals)} · Limit sum {text(limit, unit, decimals)}. Only containers that declare a limit are summed.</span>,
        context: { series: group.name, labels },
      }];
    });
  });
  const { root, observe, popover } = useObservations(observations, widget, interactive && widget.options?.showTooltip !== false);
  const roving = useRoving(root, observations.length);
  if (!model.groups.length) return <EmptyState />;
  // Each resource scales to its largest value, so 50 millicores against 100 requested fills half the track. One is the
  // fallback only when nothing is positive.
  const maxOf = (pick: (g: (typeof model.groups)[number]) => (number | null)[]) => {
    const largest = Math.max(0, ...model.groups.flatMap(pick).filter((v): v is number => v !== null));
    return largest > 0 ? largest : 1;
  };
  const markKeys = (key: string) => { const index = observe(key)?.index; return index === undefined ? undefined : roving(index); };
  const scale = {
    cpu: maxOf(g => [g.cpuUsage, g.cpuRequest, g.cpuLimit]),
    memory: maxOf(g => [g.memoryUsage, g.memoryRequest, g.memoryLimit]),
  };
  const cell = (name: string, group: string, usage: number | null, request: number | null, limit: number | null, max: number, unit: string, colour: string) => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[var(--gamma-muted)]">{name}</span>
      <div className="relative h-3 w-full rounded-sm" style={{ background: "var(--gamma-chart-empty)" }}>
        {usage === null
          ? <div className="absolute inset-0 rounded-sm" style={HATCH} role="img" aria-label={`${group} ${name} usage: No data`} />
          : <Mark interactive={interactive} label={`${group} ${name} usage ${text(usage, unit, decimals)}`} context={{ series: group, labels: { [model.groupLabel]: group } }}
              observed={observe(`${group}|${name}`)} keys={markKeys(`${group}|${name}`)} onActivate={onActivate} onContextChange={onContextChange}
              className="absolute inset-y-0 left-0 block rounded-sm" style={{ width: `${(usage / max) * 100}%`, background: colour }}>{null}</Mark>}
        {request !== null && <span aria-hidden className="absolute inset-y-0 w-px" style={{ left: `${(request / max) * 100}%`, background: "var(--gamma-ink)" }} />}
        {showLimits && limit !== null && <span aria-hidden className="absolute inset-y-0 w-0 border-l border-dashed" style={{ left: `${(limit / max) * 100}%`, borderColor: "var(--gamma-muted)" }} />}
      </div>
      {showValues && <span className="truncate text-[var(--gamma-muted)]">{text(usage, unit, decimals)} of {text(request, unit, decimals)}</span>}
    </div>
  );
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col gap-3 text-xs" data-kubernetes="bars">
      <div className="flex flex-col gap-3">
        {model.groups.map(group => (
          <div key={group.name} className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
            <span className="truncate font-medium text-[var(--gamma-ink)]">{group.name}</span>
            {cell("CPU", group.name, group.cpuUsage, group.cpuRequest, group.cpuLimit, scale.cpu, "cores", seriesSlot(0))}
            {cell("Memory", group.name, group.memoryUsage, group.memoryRequest, group.memoryLimit, scale.memory, "B", seriesSlot(1))}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 text-[var(--gamma-muted)]">
        {model.hiddenGroups > 0 && <span>Showing {model.groups.length} of {model.totalGroups}</span>}
        {truncationNote(result) && <span>{truncationNote(result)}</span>}
      </div>
      {popover}
    </div>
  );
}

export function KubernetesThrottleMatrix({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = throttleConfigSchema.parse(widget.config ?? {});
  const { model } = throttleCells(result, config);
  const [page, setPage] = useState(0);
  const interactive = !embedded;
  const decimals = widget.options?.decimals;
  const pages = Math.max(1, Math.ceil(model.totalRows / model.rowsPerPage));
  const current = Math.min(page, pages - 1);
  const rows = model.rows.slice(current * model.rowsPerPage, (current + 1) * model.rowsPerPage);
  const when = (c: ThrottleColumn) => (c.samples > 1 ? `${new Date(c.start).toISOString()} to ${new Date(c.end).toISOString()}` : new Date(c.timestamp).toISOString());
  const observations: Observation[] = rows.flatMap(row => row.cells.map((c): Observation => {
    const labels = { [model.groupLabel]: row.name };
    const reading = c.throttled === null ? "No data" : c.neutral ? "No CFS periods" : text(c.percent, "%", decimals);
    const counts = c.throttled !== null && !c.neutral && c.periods !== null
      ? ` · ${formatMetricDetails(c.throttled, "periods", decimals)} throttled of ${formatMetricDetails(c.periods, "periods", decimals)}${c.samples > 1 ? `, mean of ${c.paired} samples` : ""}`
      : "";
    return {
      key: `${row.name}|${c.timestamp}`, subject: row.name, unit: "%", description: c.samples > 1 ? when(c) : `Observed at ${when(c)}`,
      series: { name: row.name, labels, points: [{ timestamp: c.timestamp, value: c.percent }] }, point: { timestamp: c.timestamp, value: c.percent },
      detail: <span>{reading}{counts}</span>,
      context: { series: row.name, labels, value: c.percent },
    };
  }));
  const { root, observe, popover } = useObservations(observations, widget, interactive && widget.options?.showTooltip !== false);
  // Cells are a grid: left and right move in time, up and down move between rows on this page.
  const roving = useRoving(root, observations.length, model.columns.length);
  if (!model.rows.length) return <EmptyState />;
  const colour = (percent: number | null, neutral: boolean, throttled: number | null): CSSProperties => {
    if (throttled === null) return HATCH;
    if (neutral || percent === null) return { background: "var(--gamma-chart-empty)" };
    const index = Math.min(densityPalette.length - 1, Math.round(Math.max(0, Math.min(1, percent / model.ceiling)) * (densityPalette.length - 1)));
    return { background: densityPalette[index] };
  };
  const columns = `repeat(${model.columns.length}, minmax(3px, 1fr))`;
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col gap-2 text-xs" data-kubernetes="throttle">
      <div className="grid gap-px" style={{ gridTemplateColumns: `minmax(0,7rem) ${columns} 4.5rem` }}>
        {/* The group heading spans the label and time columns, so Total sits over the totals column. */}
        <span className="text-[var(--gamma-muted)]" style={{ gridColumn: `1 / span ${model.columns.length + 1}` }}>{model.groupLabel}</span>
        <span className="text-right text-[var(--gamma-muted)]">Total</span>
        {rows.map(row => (
          <div key={row.name} className="contents">
            <span className="truncate pr-2 text-[var(--gamma-ink)]">{row.name}</span>
            {row.cells.map(c => {
              const label = `${row.name} at ${when(c)}: ${c.throttled === null ? "No data" : c.neutral ? "No CFS periods" : text(c.percent, "%", decimals)}`;
              const observed = observe(`${row.name}|${c.timestamp}`);
              return <Mark key={c.timestamp} interactive={interactive} label={label} context={{ series: row.name, labels: { [model.groupLabel]: row.name } }}
                observed={observed} keys={observed ? roving(observed.index) : undefined} onActivate={onActivate} onContextChange={onContextChange}
                className="block h-4 min-w-0" style={colour(c.percent, c.neutral, c.throttled)}>{null}</Mark>;
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
      {popover}
    </div>
  );
}

const STRIP_HEIGHT = 72;
const STRIP_WIDTH = 600;

export function KubernetesResourceTrend({ widget, result, embedded }: WidgetRendererProps) {
  const config = resourceTrendConfigSchema.parse(widget.config ?? {});
  const { model } = resourceStrips(result, config);
  const interactive = !embedded;
  const decimals = widget.options?.decimals;
  const t0 = model.timestamps[0] ?? 0, t1 = model.timestamps[model.timestamps.length - 1] ?? 0;
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * STRIP_WIDTH : 0);
  const strips = [
    { id: "cpu", title: "CPU", unit: "cores", lines: [["cpu-usage", seriesSlot(0), true], ["cpu-request", "var(--gamma-muted)", false]] as const },
    { id: "memory", title: "Memory", unit: "B", lines: [["memory-usage", seriesSlot(1), true], ["memory-request", "var(--gamma-muted)", false]] as const },
    ...(config.showNetwork !== false ? [{ id: "network", title: "Network", unit: "B/s", lines: [["network-rx", seriesSlot(2), false], ["network-tx", seriesSlot(3), false]] as const }] : []),
  ].filter(strip => strip.id !== "network" || strip.lines.some(([signal]) => model.lines[signal]));
  const byTime = new Map(Object.entries(model.lines).map(([signal, points]) => [signal, new Map((points ?? []).map(point => [point.timestamp, point.value]))]));
  const valueAt = (signal: string, timestamp: number) => byTime.get(signal)?.get(timestamp) ?? null;
  // One observation per strip and sample time: the hover column over each strip reads every line at that time.
  const observations: Observation[] = strips.flatMap(strip => model.timestamps.map((timestamp): Observation => {
    const labels = { strip: strip.id };
    const measured = strip.lines.find(([, , isMeasured]) => isMeasured)?.[0];
    const headline = measured ? valueAt(measured, timestamp) : null;
    return {
      key: `${strip.id}|${timestamp}`, subject: strip.title, unit: strip.unit, description: `Observed at ${new Date(timestamp).toISOString()}`,
      series: { name: strip.title, labels, points: [{ timestamp, value: headline }] }, point: { timestamp, value: headline },
      detail: <span className="flex flex-col">{strip.lines.map(([signal]) => <span key={signal}>{signal.replace(/^[a-z]+-/, "")} {text(valueAt(signal, timestamp), strip.unit, decimals)}</span>)}</span>,
      context: { series: strip.title, labels, value: headline },
    };
  }));
  const { root, observe, popover } = useObservations(observations, widget, interactive && widget.options?.showTooltip !== false);
  // Columns are a grid: left and right move in time, up and down move between strips at the same time.
  const roving = useRoving(root, observations.length, model.timestamps.length);
  if (!model.timestamps.length) return <EmptyState />;
  const showRequested = config.showRequested !== false, fill = config.fill !== false;
  const spacing = model.timestamps.length > 1 ? STRIP_WIDTH / (model.timestamps.length - 1) : STRIP_WIDTH;
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col gap-3 text-xs" data-kubernetes="trend">
      {strips.map(strip => {
        const values = strip.lines.flatMap(([signal]) => (model.lines[signal] ?? []).map(p => p.value ?? 0));
        const axis = niceAxis([0, Math.max(1, ...values)], 3);
        const scale = sharedScale(values, strip.unit, { decimals, axis: axis.ticks });
        const y = (value: number) => STRIP_HEIGHT - (value / axis.domain[1]) * STRIP_HEIGHT;
        // Runs of consecutive samples. A missing sample ends a run, so neither the line nor the fill crosses a gap.
        const runs = (points: { timestamp: number; value: number | null }[]) => {
          const out: { timestamp: number; value: number }[][] = [];
          let open: { timestamp: number; value: number }[] | null = null;
          for (const point of points) {
            if (point.value === null) { open = null; continue; }
            if (!open) { open = []; out.push(open); }
            open.push({ timestamp: point.timestamp, value: point.value });
          }
          return out;
        };
        const line = (run: { timestamp: number; value: number }[]) => run.map((point, i) => `${i ? "L" : "M"}${x(point.timestamp).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
        const area = (run: { timestamp: number; value: number }[]) =>
          `${line(run)} L${x(run[run.length - 1].timestamp).toFixed(1)} ${STRIP_HEIGHT} L${x(run[0].timestamp).toFixed(1)} ${STRIP_HEIGHT} Z`;
        const latest = (signal: string) => { const points = model.lines[signal as keyof typeof model.lines] ?? []; for (let i = points.length - 1; i >= 0; i--) if (points[i].value !== null) return points[i].value; return null; };
        return (
          <div key={strip.id} className="flex flex-col gap-1" data-trend-strip={strip.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-[var(--gamma-ink)]">{strip.title}</span>
              <span className="flex flex-wrap gap-x-3 text-[var(--gamma-muted)]">
                {strip.lines.map(([signal]) => <span key={signal}>{signal.replace(/^[a-z]+-/, "")} {text(latest(signal), strip.unit, decimals)}</span>)}
              </span>
            </div>
            <svg viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`} width="100%" height={STRIP_HEIGHT} preserveAspectRatio="none" role={interactive ? "group" : "img"} aria-label={`${strip.title} over time`} className="overflow-visible">
              <line x1={0} x2={STRIP_WIDTH} y1={STRIP_HEIGHT} y2={STRIP_HEIGHT} stroke="var(--gamma-chart-grid)" />
              {strip.lines.filter(([, , measured]) => measured || showRequested).map(([signal, colour, measured]) => {
                const segments = runs(model.lines[signal] ?? []);
                if (!segments.length) return null;
                const dashed = !measured;
                return <g key={signal}>
                  {measured && fill && segments.map(run => <path key={`fill-${run[0].timestamp}`} d={area(run)} fill={colour} fillOpacity={0.18} />)}
                  <path d={segments.map(line).join(" ")} fill="none" stroke={colour} strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />
                </g>;
              })}
              {interactive && model.timestamps.map(timestamp => {
                const observed = observe(`${strip.id}|${timestamp}`);
                if (!observed) return null;
                const trigger = observed.trigger;
                const keys = roving(observed.index, event => trigger?.onClick(event));
                const reading = strip.lines.map(([signal]) => `${signal.replace(/^[a-z]+-/, "")} ${text(valueAt(signal, timestamp), strip.unit, decimals)}`).join(", ");
                return <rect key={timestamp} x={x(timestamp) - spacing / 2} y={0} width={spacing} height={STRIP_HEIGHT} fill="transparent"
                  role="button" aria-label={`${strip.title} at ${new Date(timestamp).toISOString()}: ${reading}`}
                  data-observation={observed.index} tabIndex={keys.tabIndex} data-roving={keys["data-roving"]} onKeyDown={keys.onKeyDown}
                  onFocus={event => { keys.onFocus(); trigger?.onFocus(event); }} onBlur={trigger?.onBlur} onClick={trigger?.onClick}
                  onPointerEnter={trigger?.onPointerEnter} onPointerLeave={trigger?.onPointerLeave} />;
              })}
            </svg>
            <span className="sr-only">{strip.title} ticks: {axis.ticks.map(tick => scale.number(tick)).join(", ")}</span>
          </div>
        );
      })}
      {popover}
    </div>
  );
}
