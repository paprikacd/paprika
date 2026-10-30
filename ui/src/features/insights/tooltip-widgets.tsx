"use client";

import {
  Component,
  createContext,
  memo,
  useContext,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { lineY } from "@tanstack/charts/line";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { defineChart } from "@tanstack/charts/scene";
import type { TooltipView, QueryResult, Widget, DataKind } from "./schema";
import { WidgetVisualization } from "./charts";
import { GammaButton } from "./gamma/button";
import { EmbeddedWidgetProvider } from "./widget-presentation";
import { useTooltipQuery } from "./tooltip-query";
import { useTooltipWidgetData } from "./tooltip-widget-data";
import {
  boundHistoryPoints,
  formatMetricDetails,
  latestPoint,
  formatMetric,
  formatTimeTick,
  seriesName,
  type Point,
  type Series,
} from "./chart-data";
import { validTimestamp } from "./widget-context";
import styles from "./tooltip-widgets.module.css";

export const MAX_TOOLTIP_POINTS = 240;
export const MAX_TOOLTIP_SERIES = 12;
export const MAX_TOOLTIP_TRACES = 100;
export interface TooltipRendererContext {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly observation?: Readonly<Point>;
  /** One bounded, normalized series. Missing observations remain null gaps. */
  readonly points: readonly Readonly<Point>[];
  readonly unit: string;
  readonly color: string;
  readonly height: 120 | 160 | 200 | 320;
  readonly view: Readonly<Omit<TooltipView, "source">>;
  readonly result: QueryResult;
  readonly queried: boolean;
  readonly seriesOnly: boolean;
  readonly totalSeries: number;
  readonly totalTraces: number;
  readonly sampled: boolean;
  readonly showGrid: boolean;
  readonly showAxis: boolean;
  readonly summary: Readonly<{
    sampleCount: number;
    finiteCount: number;
    missingCount: number;
    start?: number;
    end?: number;
    min?: number;
    max?: number;
    latest?: Readonly<Point>;
  }>;
}
export interface TooltipRendererProps {
  context: TooltipRendererContext;
}
export interface TooltipRendererDefinition {
  id: string;
  label: string;
  render: ComponentType<TooltipRendererProps>;
}

const DEFAULT_TOOLTIP_COLOR = "var(--gamma-chart-1, #b65332)";
// Only host-owned chart tokens may pass through the renderer boundary. Keep
// arbitrary CSS out while preserving series identity across themed portals.
const chartTokenColor = /^var\(--gamma-chart-[1-8](?:,\s*#[0-9a-f]{6})?\)$/i;

/** Normalize once per active series. No provider, widget or query API is exposed. */
export function buildTooltipContext(
  series: Series,
  view: TooltipView,
  unit: string,
  color = DEFAULT_TOOLTIP_COLOR,
  result: QueryResult = { series: [series] },
  observation?: Point,
): TooltipRendererContext {
  const original = result.series?.[0] ?? {
    name: series.name,
    labels: {},
    points: [],
  };
  const bounded: QueryResult = {
    ...(result.records ? { records: { columns: result.records.columns.map(c => ({ ...c })), rows: result.records.rows.slice(0, 10).map(r => [...r]), truncated: result.records.truncated || result.records.rows.length > 10 } } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.series
      ? {
          series: result.series.slice(0, MAX_TOOLTIP_SERIES).map((entry) => ({
            name: entry.name,
            labels: { ...entry.labels },
            points: boundHistoryPoints(entry.points, MAX_TOOLTIP_POINTS),
          })),
        }
      : {}),
    ...(result.traces
      ? {
          traces: result.traces
            .slice(0, MAX_TOOLTIP_TRACES)
            .map((trace) => ({ ...trace })),
        }
      : {}),
  };
  const presentation = { ...view };
  delete presentation.source;
  if (presentation.config !== undefined)
    presentation.config = JSON.parse(JSON.stringify(presentation.config));
  freezeData(bounded);
  freezeData(presentation);
  let sampleCount = 0;
  let finiteCount = 0;
  let start = Infinity;
  let end = -Infinity;
  let min = Infinity;
  let max = -Infinity;
  let latest: Point | undefined;
  for (const point of original.points) {
    if (!validTimestamp(point.timestamp)) continue;
    sampleCount++;
    start = Math.min(start, point.timestamp);
    end = Math.max(end, point.timestamp);
    const value =
      typeof point.value === "number" && Number.isFinite(point.value)
        ? point.value
        : null;
    if (!latest || point.timestamp >= latest.timestamp)
      latest = { timestamp: point.timestamp, value };
    if (value === null) continue;
    finiteCount++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Object.freeze({
    name: seriesName(series, 0),
    // Record-backed observations can provide an exact value without a time.
    // Their missing timestamp is used only for binding validation; do not hand
    // an invalid timestamp to a trusted tooltip renderer as an observation.
    ...(observation && validTimestamp(observation.timestamp) ? { observation: Object.freeze({ ...observation }) } : {}),
    labels: Object.freeze({ ...series.labels }),
    points: bounded.series?.[0]?.points ?? Object.freeze([]),
    result: bounded,
    view: presentation,
    queried: view.source?.type === "query" || view.source?.type === "saved",
    seriesOnly: !view.source || view.source.type === "series",
    totalSeries: result.series?.length ?? 0,
    totalTraces: result.traces?.length ?? 0,
    sampled: (result.series ?? [])
      .slice(0, MAX_TOOLTIP_SERIES)
      .some(
        (entry, index) =>
          entry.points.length > (bounded.series?.[index]?.points.length ?? 0),
      ),
    unit: view.unit ?? unit,
    color: view.color ?? (/^#[0-9a-f]{6}$/i.test(color) || chartTokenColor.test(color) ? color : DEFAULT_TOOLTIP_COLOR),
    height: [120, 160, 200, 320].includes(view.height ?? 160)
      ? (view.height ?? 160)
      : 160,
    showGrid: view.showGrid !== false,
    showAxis: view.showAxis !== false,
    summary: Object.freeze({
      sampleCount,
      finiteCount,
      missingCount: sampleCount - finiteCount,
      ...(sampleCount ? { start, end } : {}),
      ...(finiteCount ? { min, max } : {}),
      ...(latest ? { latest: Object.freeze(latest) } : {}),
    }),
  });
}

function freezeData(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freezeData);
  Object.freeze(value);
}

function TimeSeriesRenderer(props: TooltipRendererProps) {
  return !props.context.seriesOnly ? (
    <EmbeddedRenderer {...props} />
  ) : (
    <MiniTimeSeries {...props} />
  );
}
const builtins: readonly TooltipRendererDefinition[] = Object.freeze(
  [
    { id: "timeseries", label: "Time series", render: TimeSeriesRenderer },
    { id: "bar", label: "Bar chart", render: EmbeddedRenderer },
    { id: "stat", label: "Single value", render: EmbeddedRenderer },
    { id: "table", label: "Metrics table", render: EmbeddedRenderer },
    { id: "traces", label: "Trace explorer", render: EmbeddedRenderer },
    { id: "heatmap", label: "Status heatmap", render: EmbeddedRenderer },
    { id: "plugin", label: "Installed plugin", render: EmbeddedRenderer },
  ].map((definition) => Object.freeze(definition)),
);
const registered = new Map<string, TooltipRendererDefinition>();
const listeners = new Set<() => void>();
let snapshot = builtins;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getTooltipRenderers = () => snapshot;
export const getTooltipRenderer = (id: string) =>
  snapshot.find((definition) => definition.id === id);
const publish = () => {
  snapshot = Object.freeze([...builtins, ...registered.values()]);
  listeners.forEach((listener) => listener());
};

/** Trusted host code only; documents select a known view, never load executable code. */
export function registerTooltipRenderer(
  definition: TooltipRendererDefinition,
): () => void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(definition.id))
    throw new Error("Tooltip renderer IDs must be valid identifiers");
  if (getTooltipRenderer(definition.id))
    throw new Error(
      `Tooltip renderer “${definition.id}” is already registered`,
    );
  if (!definition.label.trim())
    throw new Error("Tooltip renderers need a label");
  if (
    typeof definition.render !== "function" &&
    (typeof definition.render !== "object" || !definition.render)
  )
    throw new Error("Tooltip renderer needs a React component");
  const stored = Object.freeze({ ...definition });
  registered.set(stored.id, stored);
  publish();
  return () => {
    if (registered.get(stored.id) === stored) {
      registered.delete(stored.id);
      publish();
    }
  };
}

const TooltipDepth = createContext(0);
function Unavailable() {
  return (
    <p role="status" className={styles.empty}>
      Tooltip visualization unavailable. Observation details are still shown.
    </p>
  );
}
class TooltipBoundary extends Component<
  { children: ReactNode; revision: unknown },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(
    previous: Readonly<{ children: ReactNode; revision: unknown }>,
  ) {
    if (this.state.failed && previous.revision !== this.props.revision)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <Unavailable /> : this.props.children;
  }
}

export const TooltipSubWidget = memo(function TooltipSubWidget({
  view,
  series: inputSeries,
  seriesIndex = 0,
  point,
  unit,
  color,
}: {
  view: TooltipView;
  series: Series;
  seriesIndex?: number;
  point?: Point;
  unit: string;
  color?: string;
}) {
  const series = useMemo(
    () =>
      inputSeries.name
        ? inputSeries
        : { ...inputSeries, name: seriesName(inputSeries, seriesIndex) },
    [inputSeries, seriesIndex],
  );
  const depth = useContext(TooltipDepth);
  const parentData = useTooltipWidgetData();
  const definitions = useSyncExternalStore(
    subscribe,
    getTooltipRenderers,
    getTooltipRenderers,
  );
  const definition = definitions.find((entry) => entry.id === view.type);
  const kind: DataKind = view.type === "plugin" ? view.dataKind ?? "metrics" : view.type === "traces" ? "traces" : "metrics";
  const query = useTooltipQuery(
    view.source,
    series,
    kind,
    depth === 0 && !!definition,
    point,
  );
  const currentResult = useMemo(
    () =>
      view.source?.type === "query" || view.source?.type === "saved"
        ? query.data
        : view.source?.type === "widget"
          ? parentData?.kind === kind
            ? parentData.result
            : undefined
          : { series: [series] },
    [view.source?.type, query.data, series, parentData, kind],
  );
  const context = useMemo(
    () =>
      buildTooltipContext(
        series,
        view,
        unit,
        color,
        currentResult ?? {},
        point,
      ),
    [series, view, unit, color, currentResult, point],
  );
  const revision = useMemo(
    () => ({ context, definition }),
    [context, definition],
  );
  if (depth > 0 || !definition) return <Unavailable />;
  const Renderer = definition.render;
  const error =
    query.error ??
    (view.source?.type === "widget" && (!parentData || parentData.kind !== kind)
      ? "The existing widget data is unavailable or incompatible with this visualization."
      : kind !== "metrics" && (!view.source || view.source.type === "series")
        ? "Trace and record tooltips require a configured query."
        : null);
  return (
    <section
      className={styles.widget}
      data-tooltip-widget={view.type}
      aria-label={
        view.title ??
        `${context.name} ${context.seriesOnly ? "history" : "details"}`
      }
      aria-busy={query.loading}
    >
      {view.title && <strong className={styles.title}>{view.title}</strong>}
      {query.loading ? (
        <p className={styles.empty} role="status">
          Loading tooltip data…
        </p>
      ) : error ? (
        <div>
          <p className={styles.error} role="alert">
            {error}
          </p>
          {query.canRetry && (
            <GammaButton size="sm" onClick={query.refresh}>
              Retry tooltip query
            </GammaButton>
          )}
        </div>
      ) : (
        <>
          <TooltipDepth.Provider value={depth + 1}>
            <TooltipBoundary revision={revision}>
              <Renderer context={context} />
            </TooltipBoundary>
          </TooltipDepth.Provider>
          {context.sampled &&
            (!context.seriesOnly || view.type !== "timeseries") && (
              <p className={styles.note} role="status">
                History is downsampled to at most {MAX_TOOLTIP_POINTS} samples
                per series; latest observations, gaps and extrema are retained.
              </p>
            )}
          {context.totalSeries > MAX_TOOLTIP_SERIES && (
            <p className={styles.note} role="status">
              Showing {MAX_TOOLTIP_SERIES} of {context.totalSeries} series in
              this tooltip. Narrow the query to see others.
            </p>
          )}
          {context.totalTraces > MAX_TOOLTIP_TRACES && (
            <p className={styles.note} role="status">
              Showing {MAX_TOOLTIP_TRACES} of {context.totalTraces} traces in
              this tooltip. Narrow the query to see others.
            </p>
          )}
        </>
      )}
    </section>
  );
});

function EmbeddedRenderer({ context }: TooltipRendererProps) {
  const view = context.view;
  const descriptionId = useId();
  const description = useMemo(
    () =>
      (context.result.series ?? [])
        .map((entry, index) => {
          const last = entry.points.at(-1);
          const latestValid = latestPoint(entry);
          const labels = Object.entries(entry.labels)
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ");
          const latest = last
            ? `${last.value === null ? "No data" : formatMetricDetails(last.value, context.unit, view.decimals)} at ${new Date(last.timestamp).toISOString()}`
            : "No observations";
          const valid =
            view.type === "bar" && latestValid
              ? ` Latest valid sample used by bar: ${formatMetricDetails(latestValid.value, context.unit, view.decimals)} at ${new Date(latestValid.timestamp).toISOString()}.`
              : "";
          return `${seriesName(entry, index)}${labels ? ` (${labels})` : ""}. Latest sample: ${latest}.${valid}`;
        })
        .join(" "),
    [context.result, context.unit, view.type, view.decimals],
  );
  const widget: Widget = {
    id: "tooltip-view",
    title: view.title ?? `${context.name} details`,
    type: view.type,
    providerId: "tooltip-data",
    query: "tooltip-data",
    unit: context.unit,
    color: context.color,
    layout: { x: 0, y: 0, w: 12, h: 4 },
    options: {
      showTooltip: false,
      showLegend: view.showLegend,
      showGrid: context.showGrid,
      decimals: view.decimals,
      showSparkline: view.showSparkline,
    },
    ...(view.type === "plugin"
      ? {
          pluginId: view.pluginId,
          dataKind: view.dataKind,
          config: view.config,
        }
      : {}),
  };
  return (
    <div className={styles.embedded} style={{ height: context.height }}>
      {(view.type === "timeseries" || view.type === "bar") && (
        <p className={styles.srOnly} id={descriptionId}>
          {description}
        </p>
      )}
      <EmbeddedWidgetProvider
        showAxis={context.showAxis}
        descriptionId={
          view.type === "timeseries" || view.type === "bar"
            ? descriptionId
            : undefined
        }
      >
        <WidgetVisualization widget={widget} result={context.result} />
      </EmbeddedWidgetProvider>
    </div>
  );
}

function useMiniWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const next = Math.floor(element.getBoundingClientRect().width);
      if (next > 0)
        setWidth((previous) => (previous === next ? previous : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return { ref, width };
}

function MiniTimeSeries({ context }: TooltipRendererProps) {
  const descriptionId = useId();
  const associateDescription = useCallback(
    ({ svg }: { svg: SVGSVGElement }) => {
      const description = svg.querySelector("desc");
      if (description) {
        description.id = descriptionId;
        svg.setAttribute("aria-describedby", descriptionId);
      }
    },
    [descriptionId],
  );
  const { ref, width } = useMiniWidth();
  const { points, summary, height, showAxis, showGrid, unit, color, name } =
    context;
  const span = (summary.end ?? 0) - (summary.start ?? 0);
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          lineY(points, {
            x: "timestamp",
            y: "value",
            stroke: color,
            strokeWidth: 1.8,
            points: points.some(
              (point, index) =>
                point.value !== null &&
                (index === 0 || points[index - 1].value === null) &&
                (index === points.length - 1 ||
                  points[index + 1].value === null),
            ),
          }),
        ],
        scales: {
          x: {
            scale:
              summary.start !== undefined &&
              summary.end !== undefined &&
              summary.start !== summary.end
                ? scaleLinear().domain([summary.start, summary.end])
                : scaleLinear,
            nice: false,
            axis: showAxis
              ? {
                  line: false,
                  ticks: {
                    count: Math.max(
                      2,
                      Math.min(4, Math.floor((width - 52) / 85)),
                    ),
                    line: false,
                    format: (value: number) => formatTimeTick(value, span),
                  },
                  tickLabels: {
                    fontSize: 10,
                    opacity: 1,
                    thin: { minGap: 10, priority: "ends" },
                  },
                }
              : false,
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: showGrid
              ? {
                  stroke: "var(--gamma-border,#dfe4db)",
                  strokeDasharray: "3 4",
                }
              : false,
            axis: showAxis
              ? {
                  line: false,
                  ticks: {
                    count: height === 120 ? 2 : 3,
                    line: false,
                    format: (value: number) =>
                      formatMetric(value, unit, true, context.view.decimals),
                  },
                  tickLabels: {
                    fontSize: 10,
                    opacity: 1,
                    thin: { minGap: 10, priority: "ends" },
                  },
                }
              : false,
          },
        },
        margin: showAxis
          ? { top: 8, right: 12, bottom: 26, left: 48 }
          : { top: 8, right: 8, bottom: 8, left: 8 },
        theme: {
          foreground: "var(--gamma-ink,#27332e)",
          muted: "var(--gamma-muted,#626e65)",
          grid: "var(--gamma-border,#dfe4db)",
          background: "transparent",
        },
        focus: false,
        tooltip: false,
        svgAnimation: false,
        clip: true,
      }),
    [
      points,
      summary.start,
      summary.end,
      height,
      showAxis,
      showGrid,
      unit,
      color,
      width,
      span,
      context.view.decimals,
    ],
  );
  const missing = summary.missingCount
    ? `${summary.missingCount} missing ${summary.missingCount === 1 ? "sample" : "samples"}.`
    : "No missing samples.";
  const description = summary.finiteCount
    ? `${summary.finiteCount} finite observations. Minimum ${formatMetricDetails(summary.min!, unit, context.view.decimals)}. Maximum ${formatMetricDetails(summary.max!, unit, context.view.decimals)}. ${missing}`
    : "No finite observations in this time range.";
  return (
    <>
      <div className={styles.heading}>
        <span>Signal history</span>
        <span>
          {summary.sampleCount}{" "}
          {summary.sampleCount === 1 ? "sample" : "samples"}
        </span>
      </div>
      <div ref={ref} className={styles.plot} style={{ height }}>
        {summary.finiteCount ? (
          <Chart
            definition={definition}
            width={width}
            height={height}
            style={{ width: "100%", maxWidth: "100%" }}
            tabIndex={-1}
            ariaLabel={`${name} time series`}
            ariaDescription={description}
            onRender={associateDescription}
          />
        ) : (
          <p className={styles.empty}>
            No finite observations in this time range.
          </p>
        )}
      </div>
      {summary.finiteCount > 0 && (
        <dl className={styles.summary}>
          <div>
            <dt>Min</dt>
            <dd data-history-min={String(summary.min)}>
              {formatMetricDetails(summary.min!, unit, context.view.decimals)}
            </dd>
          </div>
          <div>
            <dt>Max</dt>
            <dd data-history-max={String(summary.max)}>
              {formatMetricDetails(summary.max!, unit, context.view.decimals)}
            </dd>
          </div>
        </dl>
      )}
      {context.view.showLegend === true && (
        <div className={styles.legend}>
          <i style={{ background: color }} />
          <span>{name}</span>
        </div>
      )}
      <p className={styles.note}>
        {missing}
        {summary.sampleCount > points.length
          ? ` ${points.length} plotted samples; visual downsampling preserves gaps and extrema.`
          : ""}
      </p>
      {summary.start !== undefined && summary.end !== undefined && (
        <p className={styles.range}>
          <time dateTime={new Date(summary.start).toISOString()}>
            {new Date(summary.start).toISOString()}
          </time>
          <span aria-hidden="true">—</span>
          <time dateTime={new Date(summary.end).toISOString()}>
            {new Date(summary.end).toISOString()}
          </time>
        </p>
      )}
    </>
  );
}
