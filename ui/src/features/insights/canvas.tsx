import { supportsDashboardSelection } from "./selection-support";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import ReactGridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Compactor,
  type Layout,
} from "react-grid-layout";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Grip, MoreHorizontal, Network, PieChart, Settings2, Shield, Target } from "lucide-react";
import { WidgetVisualization } from "./charts";
import { sourceWaitMessage, useSourceStatus } from "./source-status";
import { getWidgetDefinition, useWidgetDefinitions } from "./widget-registry";
import { WidgetDrilldownProvider } from "./widget-drilldown";
import { useWidgetQuery, type QueryRetention, type RetainedQuery } from "./query";
import { ChartEntranceContext, type ChartEntranceSlot } from "./chart-entrance";
import { TooltipQueryProvider } from "./tooltip-query";
import { ChartCursorProvider } from "./chart-cursor";
import { DashboardWindowProvider } from "./dashboard-window";
import { DashboardTimeZoneProvider, useDashboardTimeZone } from "./dashboard-time-zone";
import { fullDateTimeOptions, latestPoint } from "./chart-data";
import { priorWindowQuery, refineWindowQuery, statComparison, type ObservationWindow, type StatComparison } from "./time-window";
import { StatComparisonContext, type StatComparisonState } from "./stat-comparison";
import { truncationOf } from "./truncation";
import { TraceFetcherProvider } from "./trace-waterfall";
import { AnnotationEventsProvider, useRecordedEvents, type AnnotationEventsRetention, type RetainedAnnotationEvents } from "./annotation-events";
import type {
  Dashboard,
  Drilldown,
  Provider,
  QueryRequest,
  QueryResult,
  Widget,
} from "./schema";
import type { DrilldownContext, VariableValues } from "./drilldown";
import { AppliedFilterProvider, appliedFilterFor, type SelectionScope } from "./selection-state";
import {
  contextKey,
  drilldownContextReason,
  selectionContextReason,
  widgetContexts,
} from "./widget-context";
import { dashboardRange } from "./time-range";
import { DEFAULT_TARGET_POINTS, queryStep } from "./query-step";
import { useStaggeredWindow } from "./refresh-stagger";
import { prefetchSupported, useIdlePrefetch } from "./idle-prefetch";
import type { QueryDiagnosticStore } from "./query-diagnostics";
import { widgetTextColor } from "./appearance";
import { canvasLayout, canvasMode, denseCanvasLayout, intrinsicStat, tileFootprint, type CanvasMode, type TileFootprint } from "./responsive-layout";
import {
  dragSettle,
  gridPlacement,
  LAYOUT_KEYSHORTCUTS,
  layoutMoveForKey,
  layoutResizeForKey,
  moveLayout,
  resizeLayout,
  savedLayout,
  type LayoutEdit,
  type LayoutMove,
} from "./layout-edit";
import styles from "./insights.module.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { GammaButton } from "./gamma/button";
import { useSavedQueryLibrary } from "./saved-query-context";
import { GammaSelect } from "./gamma/select";
import { GammaActionMenu, type GammaActionMenuItem } from "./gamma/action-menu";
import contextStyles from "./widget-context.module.css";
import recordStyles from "./plugins/records.module.css";
import { queryConnectionKey, queryFields, type QueryFieldSnapshot } from "./query-connections";
import { AttentionStoreProvider, SampleAsOfProvider, settledRequestEnd, useAttentionPublisher, useSampleAsOf } from "./attention-store";
import { AttentionStrip, type AutoRefresh } from "./attention-strip";
import { isAttentionLevel, widgetAttention, WidgetAttentionContext, type AttentionFailure } from "./widget-attention";
import { statusToken, thresholdPaint } from "./status";
import { ariaKeyshortcutsFor } from "./shortcuts";

const STAT_ICONS = {
  "arrow-down": ArrowDown,
  "arrow-up": ArrowUp,
  shield: Shield,
  network: Network,
  activity: Activity,
  target: Target,
  pie: PieChart,
} as const;

type Fetcher = (
  query: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryResult>;

/** The scheduler's receipts, when the fetcher reports them. Idle prefetch reads them to see whether the scheduler is busy. */
function fetcherDiagnostics(fetcher: Fetcher): QueryDiagnosticStore | undefined {
  return (fetcher as { diagnostics?: QueryDiagnosticStore }).diagnostics;
}
/** The selected widget's latest result, reported with the fetcher it came from. */
export interface WidgetResultSnapshot {
  widgetId: string;
  fetcher: Fetcher;
  result?: QueryResult;
}
/**
 * What a canvas keeps for one widget between remounts: the last outcome it showed and whether its draw-in has played.
 * It lives with the canvas, so it ends with the page session and never reaches another user's session.
 */
interface WidgetMemory { retained?: RetainedQuery; priorRetained?: RetainedQuery; annotation?: RetainedAnnotationEvents; entered: boolean }
/** The query and draw-in records for one widget, backed by that widget's entry in the canvas memory. */
function memoryFor(memory: Map<string, WidgetMemory>, key: string): { retention: QueryRetention; priorRetention: QueryRetention; annotationRetention: AnnotationEventsRetention; entrance: ChartEntranceSlot } {
  return {
    retention: {
      read: () => memory.get(key)?.retained,
      write: (retained) => { memory.set(key, { ...memory.get(key), retained, entered: memory.get(key)?.entered ?? false }); },
    },
    priorRetention: {
      read: () => memory.get(key)?.priorRetained,
      write: (priorRetained) => { memory.set(key, { ...memory.get(key), priorRetained, entered: memory.get(key)?.entered ?? false }); },
    },
    annotationRetention: {
      read: () => memory.get(key)?.annotation,
      write: (annotation) => { memory.set(key, { ...memory.get(key), annotation, entered: memory.get(key)?.entered ?? false }); },
    },
    entrance: {
      entered: () => memory.get(key)?.entered ?? false,
      markEntered: () => { memory.set(key, { ...memory.get(key), entered: true }); },
    },
  };
}
function sameFields(previous: object, next: object) {
  const entries = Object.entries(previous);
  return entries.length === Object.keys(next).length && entries.every(([key, value]) => Object.is(value, Reflect.get(next, key)));
}
/** The time of the sample a stat displays: the latest valid point of the first series that has one. */
function displayedSampleAt(result: QueryResult | undefined): number | undefined {
  for (const series of result?.series ?? []) {
    const point = latestPoint(series);
    if (point) return point.timestamp;
  }
  return undefined;
}
/** The change a stat pairs from its displayed result and its earlier window, with the failure that stopped the earlier window. */
interface PairedChange { outcome?: StatComparison; error?: string }

/**
 * A stat that compares with an earlier window fetches that window as soon as the stat has a displayed sample, so a refresh
 * or a new range runs both requests at once. The window is the same bounded query the time-series lens asks for, so the chip
 * and the lens's previous-period row agree on one range. Other widgets render no scope and run no extra query.
 *
 * The change is paired only from settled results for the same range. While the displayed result reloads, the last pair
 * stays, since it matches the reading still on screen. Once the displayed result has settled, a change waits for its own
 * earlier window: that gap is the only time the chip shows its loading slot.
 */
function StatComparisonScope({ widget, compare, fetcher, start, end, minStepSeconds, enabled, debounceMs, retention, primary, primarySettled, children }: {
  widget: Widget;
  compare: NonNullable<NonNullable<Widget["options"]>["compare"]>;
  fetcher: Fetcher;
  start: number;
  end: number;
  /** The provider's finest step; the earlier window keeps the primary query's step rule. */
  minStepSeconds?: number;
  /** Whether the tile may query at all. */
  enabled: boolean;
  debounceMs: number;
  retention: QueryRetention;
  /** The result on screen: the last one while a refresh or a new range loads, undefined when there is none or it failed. */
  primary?: QueryResult;
  /** Whether `primary` answers the request just asked for. */
  primarySettled: boolean;
  children: ReactNode;
}) {
  const rangeMs = useMemo(() => ({ start: start * 1000, end: end * 1000 }), [start, end]);
  const earlier = priorWindowQuery(rangeMs, compare.window, minStepSeconds);
  const earlierReady = !("unavailable" in earlier);
  // Nothing to compare with until the displayed result has a sample, so an empty stat asks for no earlier window (Go agrees).
  const hasSample = !!primary?.series?.some(entry => latestPoint(entry));
  const earlierNeeded = earlierReady && hasSample;
  const earlierQuery = useWidgetQuery(widget, {
    fetcher,
    start: earlierReady ? earlier.start : start,
    end: earlierReady ? earlier.end : end,
    step: earlierReady ? earlier.step : queryStep(end - start, DEFAULT_TARGET_POINTS, minStepSeconds),
    enabled: enabled && earlierNeeded && !!primary,
    debounceMs,
    retention,
  });
  const fresh = useMemo<PairedChange | undefined>(() => {
    if (!primary || !primarySettled) return undefined;
    if (!earlierNeeded) return { outcome: statComparison(primary.series ?? [], [], rangeMs, compare.window) };
    // Only a settled earlier result for this range is paired. While a new range loads, the hook still holds the previous
    // window's result, and pairing it with this range's bounds would show a change that belongs to another window.
    if (!earlierQuery.settled) return undefined;
    if (!earlierQuery.data) return { error: earlierQuery.error ?? undefined };
    const kind = truncationOf(earlierQuery.data);
    return { outcome: statComparison(primary.series ?? [], earlierQuery.data.series ?? [], rangeMs, compare.window, kind !== "none" && kind !== "limit") };
  }, [compare.window, earlierNeeded, earlierQuery.data, earlierQuery.error, earlierQuery.settled, primary, primarySettled, rangeMs]);
  // The last pair is kept while the displayed result reloads, and dropped with it when the stat has no result. It lives in state
  // and is updated while rendering, the React pattern for deriving state from a prop, so the render never reads a ref.
  // Each held pair remembers the reading it was computed from, so a reload shows it only beside that same reading.
  const [held, setHeld] = useState<{ pair: PairedChange; primary: QueryResult } | undefined>(undefined);
  if (!primary) {
    if (held) setHeld(undefined);
  } else if (fresh && (fresh !== held?.pair || primary !== held.primary)) setHeld({ pair: fresh, primary });
  // A settled result shows only its own pair, so a pending change is a loading slot. A reloading result keeps the last pair,
  // but only while the reading on screen is the one that pair was computed from; a newer reading waits for its own pair.
  const shown = primary && !primarySettled ? (held?.primary === primary ? held.pair : undefined) : fresh;
  const state = useMemo<StatComparisonState>(() => ({
    window: compare.window,
    good: compare.good,
    span: rangeMs.end - rangeMs.start,
    unit: widget.unit,
    decimals: widget.options?.decimals,
    outcome: shown?.outcome,
    error: shown?.outcome ? undefined : shown?.error,
  }), [compare.good, compare.window, rangeMs, shown, widget.options?.decimals, widget.unit]);
  return <StatComparisonContext.Provider value={state}>{children}</StatComparisonContext.Provider>;
}

// The layout edit a key or menu step asks for, or undefined when the key is not a step. Shared by the step and its blocked check.
function layoutStepEdit(widgets: readonly Widget[], layout: Layout, draggable: boolean, id: string, key: string, resize: boolean):
  { resizing?: readonly [number, number]; direction?: LayoutMove; edit: LayoutEdit } | undefined {
  const resizing = resize ? layoutResizeForKey(key) : undefined;
  const direction = resize ? undefined : layoutMoveForKey(key);
  if (!resizing && !direction) return undefined;
  const base = draggable ? layout : savedLayout(widgets);
  const edit = resizing ? resizeLayout(base, id, resizing[0], resizing[1]) : moveLayout(base, id, direction!);
  return { resizing, direction, edit };
}

const Tile = memo(function Tile({
  widget,
  active,
  provider,
  fetcher,
  boardStart,
  boardEnd,
  refreshStaggerMs = 0,
  prefetch = false,
  editing,
  draggable,
  naturalHeight = false,
  referenceCompact = false,
  focused = false,
  selected,
  onSelect,
  onDrilldown,
  onSelection,
  onQueryFields,
  onQueryResult,
  onTimeRange,
  onNudge,
  onStep,
  stepBlocked,
  onDuplicate,
  onRemove,
  duplicateBlocked,
  memory,
  memoryKey,
  selectionScope,
}: {
  widget: Widget;
  active: boolean;
  provider?: Provider;
  fetcher: Fetcher;
  /** The board's window. A tick may reach the tile a moment later, so the tile staggers its adoption by refreshStaggerMs. */
  boardStart: number;
  boardEnd: number;
  refreshStaggerMs?: number;
  /** The scheduler is idle enough to warm this tile before it is in view. */
  prefetch?: boolean;
  editing: boolean;
  draggable: boolean;
  naturalHeight?: boolean;
  referenceCompact?: boolean;
  focused?: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onDrilldown?: (link: Drilldown, context: DrilldownContext) => void;
  onSelection?: (widget: Widget, context: DrilldownContext) => void;
  onQueryFields?: (snapshot: QueryFieldSnapshot) => void;
  onQueryResult?: (snapshot: WidgetResultSnapshot) => void;
  onTimeRange?: (window: ObservationWindow) => void;
  /** Alt+Arrow moves and Alt+Shift+Arrow resizes the widget from the keyboard. Present only on the editable wide canvas. */
  onNudge?: (id: string, key: string, resize: boolean) => void;
  /** The tile's actions menu runs the same steps as the keys, at every width. Present only in edit mode outside focus. */
  onStep?: (id: string, key: string, resize: boolean) => void;
  /** Why a step would change nothing right now, read when the menu opens. Blocked steps show disabled with this reason. */
  stepBlocked?: (id: string, key: string, resize: boolean) => string | undefined;
  onDuplicate?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Why Duplicate is unavailable, such as a dashboard at its widget limit. */
  duplicateBlocked?: string;
  memory: Map<string, WidgetMemory>;
  memoryKey: string;
  /** The variable values a selection is compared against, so a mark can show that it is the applied filter. */
  selectionScope?: SelectionScope;
}) {
  const { start, end } = useStaggeredWindow(widget.id, boardStart, boardEnd, refreshStaggerMs);
  const recordCellStyles = widget.config?.cellStyles;
  const compactRecordDescription = referenceCompact && widget.type === "plugin" && widget.pluginId === "record-table" &&
    Array.isArray(recordCellStyles) && ["sparkline", "bar-segments", "status-badge"].every(display =>
      recordCellStyles.some(style => typeof style === "object" && style !== null && "display" in style && style.display === display));
  const element = useRef<HTMLDivElement>(null);
  const library = useSavedQueryLibrary();
  const savedQueryLoading = !!widget.queryRef && !!library.loading;
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        // A responsive layout can queue both the old and new tile position in
        // one callback. The final observation owns whether queries should run.
        const entry = entries.at(-1);
        if (entry) setVisible(entry.isIntersecting);
      },
      {
        // A tile starts loading one viewport before it scrolls into view, so a scroll rarely waits on a query.
        rootMargin: "100% 0px",
      },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  // A focused editor stays engaged while its author scrolls down to query controls.
  const engaged = visible || focused;
  // A prefetching tile queries once, before it is in view. Once it has an answer it waits for the viewport again.
  const [prefetchedOnce, setPrefetchedOnce] = useState(false);
  const prefetching = prefetch && !engaged && !prefetchedOnce;
  const memoryOf = useMemo(() => memoryFor(memory, memoryKey), [memory, memoryKey]);
  // A tile whose source is not in the loaded list waits while the list is pending or
  // unavailable. A loaded source queries even when the shared catalog failed, so local
  // tiles keep working beside the banner.
  const sourceStatus = useSourceStatus();
  const waitingOn = sourceStatus !== "ready" && !provider ? sourceStatus : null;
  const awaitingSources = waitingOn !== null;
  // A shared tile stays busy while the shared catalog reloads, even though it still queries.
  const busyOnSources = waitingOn === "pending" || (sourceStatus === "pending" && provider?.source === "observability");
  const { data, loading, error, errorCode, refresh, settled } = useWidgetQuery(widget, {
    fetcher,
    start,
    end,
    step: queryStep(end - start, DEFAULT_TARGET_POINTS, provider?.minStepSeconds),
    enabled: active && (engaged || prefetching) && !savedQueryLoading && !awaitingSources && (!!widget.queryRef || !!provider),
    debounceMs: editing && selected ? 350 : 0,
    retention: memoryOf.retention,
  });
  if (prefetching && settled && !prefetchedOnce) setPrefetchedOnce(true);
  // A paused, never-queried tile has no result yet; it is not an empty query
  // response. Keep that distinction through the observer-to-effect handoff.
  const canQuery = !!widget.queryRef || (!!provider && !!widget.providerId && !!widget.query.trim());
  const awaitingFirstResult = active && canQuery && !data && !error;
  const annotationData = useRecordedEvents(widget.annotationSource, fetcher, widget.providerId, start, end, active && engaged && !library.loading && !library.error, memoryOf.annotationRetention);
  const annotationState = widget.annotationSource && library.error ? { events: [], error: library.error } : annotationData;
  const fetchTrace = useCallback((traceId: string, signal: AbortSignal) => fetcher({
    providerId: widget.providerId, query: widget.query, kind: "traces", start, end,
    step: queryStep(end - start, DEFAULT_TARGET_POINTS, provider?.minStepSeconds), traceId,
    ...(widget.queryRef ? { queryRef: widget.queryRef } : {}),
  }, signal), [fetcher, widget.providerId, widget.query, widget.queryRef, provider?.minStepSeconds, start, end]);
  const previous = useCallback((window: ObservationWindow, signal: AbortSignal) => {
    const range = priorWindowQuery(window, "previous", provider?.minStepSeconds);
    if ("unavailable" in range)
      return Promise.reject(new Error("Choose a window from one second up to 31 days with an available previous period."));
    return fetcher({ providerId: widget.providerId, query: widget.query, kind: "metrics",
      start: range.start, end: range.end, step: range.step, ...(widget.queryRef ? { queryRef: widget.queryRef } : {}) }, signal);
  }, [fetcher, widget.providerId, widget.query, widget.queryRef, provider?.minStepSeconds]);
  // A chart-local zoom re-queries at its own policy step. Only the chart that zoomed holds the result.
  // A zoom whose own step is no finer than the dashboard's planned step gains nothing from a re-query, so it sends none and resolves
  // with no series, which leaves the dashboard samples on screen.
  const plannedStep = queryStep(end - start, DEFAULT_TARGET_POINTS, provider?.minStepSeconds);
  const refine = useCallback((window: ObservationWindow, signal: AbortSignal) => {
    const range = refineWindowQuery(window, provider?.minStepSeconds);
    if (range.step >= plannedStep) return Promise.resolve({ series: [] });
    return fetcher({ providerId: widget.providerId, query: widget.query, kind: "metrics",
      start: range.start, end: range.end, step: range.step, ...(widget.queryRef ? { queryRef: widget.queryRef } : {}) }, signal);
  }, [fetcher, widget.providerId, widget.query, widget.queryRef, provider?.minStepSeconds, plannedStep]);
  // A provider that ignores its step would return the same samples for a finer window, so only one that publishes its minimum step can refine a zoom.
  const refinable = provider?.minStepSeconds !== undefined;
  const windowActions = useMemo(() => ({ apply: editing ? undefined : onTimeRange, previous, refine: refinable ? refine : undefined, minStepSeconds: provider?.minStepSeconds, rangeEnd: end * 1000 }), [editing, onTimeRange, previous, refine, refinable, provider?.minStepSeconds, end]);
  const compare = widget.type === "stat" ? widget.options?.compare : undefined;
  const connectionKey = queryConnectionKey(widget, { start, end });
  useEffect(() => {
    if (selected && onQueryFields) onQueryFields({ widgetId: widget.id, key: connectionKey, fetcher, fields: data && !error ? queryFields(data) : undefined });
  }, [selected, onQueryFields, widget.id, connectionKey, fetcher, data, error]);
  useEffect(() => {
    if (selected && onQueryResult) onQueryResult({ widgetId: widget.id, fetcher, result: data && !error ? data : undefined });
  }, [selected, onQueryResult, widget.id, fetcher, data, error]);
  const contextScope = JSON.stringify([
    widget.providerId,
    widget.query,
    widget.queryRef,
    widget.type,
    widget.pluginId,
    widget.dataKind,
    widget.type === "plugin" ? widget.config : undefined,
    widget.type === "plugin" ? widget.options : undefined,
  ]);
  const [selection, setSelection] = useState<{
    scope: string;
    context: DrilldownContext;
    result?: QueryResult;
  } | null>(null);
  if (selection && selection.scope !== contextScope) setSelection(null);
  const contexts = useMemo(
    () => widgetContexts(widget, error || !provider ? undefined : data),
    [widget, data, error, provider],
  );
  const currentSelection = selection?.scope === contextScope ? selection : null;
  const selectedContext =
    currentSelection &&
    contexts.find(
      (context) => contextKey(context) === contextKey(currentSelection.context),
    );
  // Only the plugin knows whether its visible value is raw, derived or missing.
  // Its explicit observation is valid for this exact result/config, never a
  // raw-series replacement after refresh or an automatic single-series guess.
  const context =
    widget.type === "plugin"
      ? !error && provider && currentSelection?.result === data
        ? (currentSelection?.context ?? {})
        : {}
      : (widget.type === "timeseries" && currentSelection?.result === data && selectedContext && currentSelection.context.timestamp !== undefined
        ? currentSelection.context
        : (selectedContext ?? (contexts.length === 1 ? contexts[0] : {})));
  // The error a tile shows: a failed query, or a provider the dashboard does not configure.
  const visibleError = savedQueryLoading ? null : error ?? (!provider && !widget.queryRef && sourceStatus === "ready"
    ? `Provider “${widget.providerId}” is not configured.`
    : null);
  // One verdict per tile: the renderer reads it through WidgetAttentionContext, and the dashboard publishes it for an attention strip.
  // The source outcome decides the verdict's failure: a source that cannot load or a provider that is not configured is
  // final, so the tile reports it rather than pending. A failed read has no band, so a retained breach is not reported.
  const sourceFailure: Exclude<AttentionFailure, "none"> | undefined = !savedQueryLoading && (waitingOn === "unavailable" || waitingOn === "signin") ? "provider"
    : !savedQueryLoading && !provider && !widget.queryRef && sourceStatus === "ready" ? "planning"
    : !savedQueryLoading && error ? "provider" : undefined;
  // The retained record holds the settle time and the range end of the request that produced the shown result. It is read
  // on each render: a settle writes the record and then re-renders the tile, and a remount restores the same record. A
  // tile that was not re-queried keeps its own range end, so a refresh of the dashboard does not age its data.
  const retained = memoryOf.retention.read();
  const completedAt = retained?.request?.settledAt;
  const resultRangeEnd = settledRequestEnd(retained?.request?.key) ?? end;
  const attention = useMemo(
    () => widgetAttention(widget, { result: savedQueryLoading ? undefined : data, failure: sourceFailure, rangeEnd: resultRangeEnd * 1000 }),
    [widget, savedQueryLoading, data, sourceFailure, resultRangeEnd],
  );
  // The strip counts the same facts query_dashboard does. An unmounted tile keeps its last facts, released not dropped.
  const attentionPublisher = useAttentionPublisher();
  const facts = attention.facts;
  const sampleAt = widget.type === "stat" ? displayedSampleAt(savedQueryLoading ? undefined : data) : undefined;
  useEffect(() => {
    attentionPublisher.publish({ widgetId: widget.id, title: widget.title, facts, completedAt, sampleAt });
  }, [attentionPublisher, widget.id, widget.title, facts, completedAt, sampleAt]);
  useEffect(() => () => attentionPublisher.release(widget.id), [attentionPublisher, widget.id]);
  // A stat whose sample is the dashboard's newest drops its repeated time; the strip states it once. The editor's preview has
  // no strip, so it keeps its own caption.
  const newestSample = useSampleAsOf();
  const sharesSample = !focused && sampleAt !== undefined && newestSample !== undefined && Math.floor(sampleAt / 60_000) === Math.floor(newestSample / 60_000);
  const attentionMark = isAttentionLevel(attention.state) ? (thresholdPaint(attention.band) ?? statusToken(attention.state)) : undefined;
  const textColor = widgetTextColor(widget.options);
  const StatIcon = widget.type === "stat" && widget.options?.statIcon ? STAT_ICONS[widget.options.statIcon] : undefined;
  const links = widget.drilldowns ?? [];
  const timeZone = useDashboardTimeZone();
  const sampleTimeFormat = useMemo(() => new Intl.DateTimeFormat("en", { ...fullDateTimeOptions, timeZone }), [timeZone]);
  const needsContext = links.some((link) =>
    link.bindings?.some((binding) => binding.source !== "constant"),
  );
  const showSeriesPicker =
    !!onDrilldown &&
    needsContext &&
    contexts.length > 1 &&
    !["heatmap", "table", "traces", "plugin"].includes(widget.type);
  // Only a widget with selectionBindings whose renderer activates on a deliberate click or keyboard press can change
  // dashboard filters. Other renderers report focus, hover and series picks as drilldown context only.
  const selectionEnabled = supportsDashboardSelection(widget) &&
    !!widget.selectionBindings?.length && !!onSelection && !editing;
  // Built-in renderers report a deliberate activation through onActivate. The allowlisted plugins still
  // activate through onContextChange, so their wiring is unchanged until they migrate.
  const activatesThroughOnActivate = widget.type !== "plugin";
  // Focus, hover and series picks set only the drilldown link context.
  const selectContextOnly = useCallback(
    (next: DrilldownContext) => setSelection({ scope: contextScope, context: next, result: data }),
    [contextScope, data],
  );
  const activateContext = useCallback(
    (next: DrilldownContext) => {
      selectContextOnly(next);
      if (selectionEnabled) onSelection?.(widget, next);
    },
    [selectContextOnly, widget, onSelection, selectionEnabled],
  );
  const contextHandler = activatesThroughOnActivate ? selectContextOnly : activateContext;
  // A selection can re-render its own source and unmount the element it activated (a table that filters by the row it
  // shows drops that row). The pending target waits for the new variables to settle: if it is then gone, focus would
  // fall to the page, so the tile takes focus and says so. A target that stays keeps its focus untouched.
  const pendingFocus = useRef<{ target: Element; scope: SelectionScope | undefined } | null>(null);
  const [refocused, setRefocused] = useState(false);
  // The tile's tab stop while it holds a fallback focus; restored when focus leaves the tile itself.
  const fallbackTabIndex = useRef<{ value: string | null } | null>(null);
  const activateFromTile = useCallback((next: DrilldownContext) => {
    // A context the bindings cannot read (a row without the bound label) sets only the drilldown context: it must not
    // fail the whole selection with an error.
    if (selectionContextReason(widget.selectionBindings, next)) {
      selectContextOnly(next);
      return;
    }
    const active = document.activeElement;
    // Re-activating the applied mark changes no variables, so nothing re-renders and there is nothing to wait for.
    const alreadyApplied = appliedFilterFor(selectionScope, widget.selectionBindings)(next);
    pendingFocus.current = !alreadyApplied && active && element.current?.contains(active) ? { target: active, scope: selectionScope } : null;
    setRefocused(false);
    activateContext(next);
  }, [activateContext, selectContextOnly, selectionScope, widget.selectionBindings]);
  // Focus that moves to another control ends the wait: the user has taken focus elsewhere, so it must not come back.
  const releaseFocusTarget = useCallback((event: FocusEvent<HTMLElement>) => {
    const tile = event.currentTarget;
    // The fallback tab stop ends with the fallback focus, so a later click on blank tile area does not focus the tile.
    if (event.target === tile && fallbackTabIndex.current) {
      if (fallbackTabIndex.current.value === null) tile.removeAttribute("tabindex");
      else tile.setAttribute("tabindex", fallbackTabIndex.current.value);
      fallbackTabIndex.current = null;
    }
    const next = event.relatedTarget;
    if (next instanceof Node && !tile.contains(next)) pendingFocus.current = null;
  }, []);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (!pending.target.isConnected) {
      pendingFocus.current = null;
      const tile = element.current;
      // Only a lost focus moves to the tile. If the user moved focus to another control while the selection loaded,
      // including another control in this tile, their focus stays where it is.
      const active = document.activeElement;
      const focusLost = !active || active === document.body;
      if (!tile || !(focusLost || active === tile)) return;
      fallbackTabIndex.current = { value: tile.getAttribute("tabindex") };
      tile.tabIndex = -1;
      tile.focus();
      setRefocused(true);
      return;
    }
    if (pending.scope !== selectionScope && !loading) pendingFocus.current = null;
  // A row leaves only when its data or the variables change, so those are the only commits that can move it.
  }, [data, loading, selectionScope]);
  // A stable callback keeps the memoised visualization from re-rendering on every tile render in edit mode.
  const editQuery = useCallback(() => onSelect(widget.id), [onSelect, widget.id]);
  // Opening the actions menu re-renders the tile, so blocked steps are read from the layout as it is then.
  const [, setMenuOpens] = useState(0);
  // Capture runs before the focused control's own arrow handling (a sparkline or a selector), so Alt+Arrow
  // edits the layout whichever control in the tile has focus. Plain arrows and text fields keep their keys.
  const keyMenuAt = useRef<number | null>(null);
  const cancelKeyContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const opened = keyMenuAt.current;
    keyMenuAt.current = null;
    if (opened !== null && event.timeStamp - opened < 1000) event.preventDefault();
  };
  const layoutKey = (event: KeyboardEvent<HTMLElement>) => {
    // The context-menu key and Shift+F10 open the tile's actions menu, as a right-click would. Only the tile itself
    // handles them, so a menu or text field inside the tile keeps its own keys.
    if (onNudge && editing && !focused && event.target === event.currentTarget && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
      const trigger = event.currentTarget.querySelector<HTMLElement>("[data-widget-actions]");
      if (trigger) {
        event.preventDefault();
        // Windows sends the native contextmenu event after the keydown, so that event is cancelled too.
        keyMenuAt.current = event.timeStamp;
        trigger.click();
      }
      return;
    }
    if (!onNudge || !event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (!(event.shiftKey ? layoutResizeForKey(event.key) : layoutMoveForKey(event.key))) return;
    // The actions menu is portalled but its keys still bubble through the React tree; they belong to the menu.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    event.stopPropagation();
    onNudge(widget.id, event.key, event.shiftKey);
  };
  // The visualization is built once and placed inside the stat's comparison scope when it compares.
  const isApplied = useMemo(() => appliedFilterFor(selectionScope, widget.selectionBindings), [selectionScope, widget.selectionBindings]);
  const visualization = (
    <AppliedFilterProvider value={isApplied}><WidgetVisualization
      widget={widget}
      naturalHeight={naturalHeight}
      result={savedQueryLoading ? undefined : data}
      loading={savedQueryLoading || loading || (engaged && awaitingFirstResult)}
      deferred={!savedQueryLoading && !engaged && awaitingFirstResult}
      sourceState={!savedQueryLoading && waitingOn ? { status: waitingOn, label: waitingOn === "pending" ? "Waiting for data sources…" : sourceWaitMessage(waitingOn) } : undefined}
      error={visibleError}
      errorCode={error ? errorCode ?? undefined : undefined}
      providerName={provider?.name}
      onEditQuery={editing ? editQuery : undefined}
      onRetry={error && active && engaged && !savedQueryLoading ? refresh : undefined}
      onContextChange={
        (onDrilldown && needsContext) || selectionEnabled ? contextHandler : undefined
      }
      onActivate={activatesThroughOnActivate && selectionEnabled ? activateFromTile : undefined}
    /></AppliedFilterProvider>
  );
  // The actions menu runs the same steps as the keys. Wide-only moves and sizes are left out below wide, where a saved-grid
  // Left or Wider changes nothing on screen. Blocked steps are announced when chosen, as the keys announce them.
  const stepItem = (id: string, label: string, group: string, key: string, resize: boolean): GammaActionMenuItem => {
    const blocked = stepBlocked?.(widget.id, key, resize);
    return { id, label, group, description: blocked, disabled: !!blocked, onSelect: () => onStep?.(widget.id, key, resize) };
  };
  const actionItems: GammaActionMenuItem[] = [
    { id: "edit", label: "Edit chart", onSelect: editQuery },
    ...(onDuplicate ? [{
      id: "duplicate",
      label: "Duplicate",
      description: duplicateBlocked ?? "Copy this chart next to it",
      disabled: !!duplicateBlocked,
      onSelect: () => onDuplicate(widget.id),
    }] : []),
    ...(onStep ? [
      stepItem("move-up", "Move up", "Arrange", "ArrowUp", false),
      stepItem("move-down", "Move down", "Arrange", "ArrowDown", false),
      ...(draggable ? [
        stepItem("move-left", "Move left", "Arrange", "ArrowLeft", false),
        stepItem("move-right", "Move right", "Arrange", "ArrowRight", false),
      ] : []),
      stepItem("taller", "Taller", "Size", "ArrowDown", true),
      stepItem("shorter", "Shorter", "Size", "ArrowUp", true),
      ...(draggable ? [
        stepItem("wider", "Wider", "Size", "ArrowRight", true),
        stepItem("narrower", "Narrower", "Size", "ArrowLeft", true),
      ] : []),
    ] : []),
    ...(onRemove ? [{ id: "remove", label: "Remove", danger: true, onSelect: () => onRemove(widget.id) }] : []),
  ];
  return (
    <article
      ref={element}
      tabIndex={onNudge ? 0 : undefined}
      aria-keyshortcuts={onNudge ? `${LAYOUT_KEYSHORTCUTS} Delete Backspace ${ariaKeyshortcutsFor("duplicate")}` : undefined}
      onKeyDownCapture={onNudge ? layoutKey : undefined}
      onContextMenu={onNudge ? cancelKeyContextMenu : undefined}
      onBlur={releaseFocusTarget}
      className={`${styles.tile} ${selected && !focused ? styles.selectedTile : ""}`}
      data-intrinsic-stat={naturalHeight || undefined}
      data-widget-id={widget.id}
      data-widget-type={widget.type}
      data-widget-sparkline={widget.type === "stat" && widget.options?.showSparkline || undefined}
      data-sparkline-placement={widget.type === "stat" ? widget.options?.sparklinePlacement : undefined}
      data-stat-icon={StatIcon ? "true" : undefined}
      data-attention={attention.state}
      data-shared-sample={sharesSample || undefined}
      data-compact-stat={widget.type === "stat" && widget.layout.h === 1 ? "true" : undefined}
      aria-label={widget.title}
      style={
        {
          background: widget.options?.background,
          color: textColor,
          "--widget-text": textColor,
          "--stat-icon-color": widget.color,
          "--attention-mark": attentionMark,
        } as CSSProperties
      }
    >
      {StatIcon && <span className={styles.statIcon} aria-hidden="true"><StatIcon size={18} /></span>}
      {refocused && <span className={styles.srOnly} role="status">Dashboard filtered. Focus moved to {widget.title}.</span>}
      <div className={styles.tileHeader}>
        {draggable && (
          <span
            className={`insights-drag-handle ${styles.dragHandle}`}
            title="Drag to move widget. Alt+Arrow keys move it; Alt+Shift+Arrow keys resize it."
            aria-hidden="true"
          >
            <Grip size={14} />
          </span>
        )}
        <div className={`${styles.tileTitle}${compactRecordDescription ? ` ${recordStyles.compactRecordTitle}` : ""}`}>
          <h3 style={{ color: textColor }} title={editing && widget.type === "stat" ? widget.title : undefined}>{widget.title}</h3>
          {widget.description && (compactRecordDescription ? (
            <details className={recordStyles.compactRecordDescription}>
              <summary aria-label={`Details for ${widget.title}`}>Details</summary>
              <span style={{ color: textColor }}>{widget.description}</span>
            </details>
          ) : <p style={{ color: textColor }}>{widget.description}</p>)}
        </div>
        {!!links.length && onDrilldown && (
          <GammaActionMenu
            label={`Open related dashboard from ${widget.title}`}
            iconOnly={false}
            trigger={<>Explore <ArrowUpRight size={14} aria-hidden="true" /></>}
            items={links.map((link) => {
              const reason = drilldownContextReason(link, context);
              return {
                id: link.id,
                label: link.title,
                description:
                  reason ??
                  `${link.carryTimeRange === false ? "Destination time range" : "Current time range"}${context.series ? ` · From ${context.series}` : ""}`,
                disabled: !!reason,
                onSelect: () => onDrilldown(link, context),
              };
            })}
          />
        )}
        {editing && !focused && (
          <GammaButton
            iconOnly
            size="sm"
            variant="quiet"
            className={`${styles.iconButton} ${styles.editChip}`}
            aria-label={`Edit ${widget.title}`}
            aria-keyshortcuts={ariaKeyshortcutsFor("duplicate")}
            data-widget-edit={widget.id}
            onClick={() => onSelect(widget.id)}
          >
            <Settings2 size={15} />
          </GammaButton>
        )}
        {editing && !focused && (
          // The menu is a separate control from the drag grip, so a click on the grip never opens it. On a narrow tile the
          // stylesheet hides the Edit chip and this trigger takes its place.
          <GammaActionMenu
            label={`Actions for ${widget.title}`}
            iconOnly
            className={`${styles.iconButton} ${styles.actionsChip}`}
            triggerProps={{ "data-widget-actions": widget.id, "aria-keyshortcuts": ariaKeyshortcutsFor("duplicate") }}
            trigger={<MoreHorizontal size={15} aria-hidden="true" />}
            items={actionItems}
            onOpen={() => setMenuOpens((count) => count + 1)}
          />
        )}
      </div>
      {showSeriesPicker ? (
        <div className={contextStyles.picker}>
          <span>Series</span>
          <GammaSelect
            aria-label={`Series for ${widget.title}`}
            size="sm"
            value={context.series === undefined ? "" : contextKey(context)}
            placeholder="Choose a series for links"
            searchable={contexts.length > 10}
            options={contexts.map((entry, index) => ({
              value: contextKey(entry),
              label: entry.series ?? `Series ${index + 1}`,
              description: Object.entries(entry.labels ?? {})
                .map(([key, value]) => `${key}=${value}`)
                .join(" · "),
            }))}
            onValueChange={(key) => {
              const next = contexts.find((entry) => contextKey(entry) === key);
              if (next) selectContextOnly(next);
            }}
          />
        </div>
      ) : (
        !!onDrilldown &&
        needsContext &&
        (contexts.length > 1 || widget.type === "plugin") && (
          <div className={contextStyles.selection} role="status">
            {context.series
              ? `Selected: ${context.series}`
              : "Select a signal to open related dashboards"}
          </div>
        )
      )}
      {widget.type === "timeseries" && context.timestamp !== undefined && <div className={contextStyles.sampleSelection} role="status">
        Links use selected sample at <time dateTime={new Date(context.timestamp).toISOString()}>{sampleTimeFormat.format(new Date(context.timestamp))}</time>
      </div>}
      {/* A tile waiting on its source is busy even when it still shows an earlier result. */}
      <div className={styles.visualization} aria-busy={busyOnSources || undefined} data-widget-state={waitingOn ? (waitingOn === "pending" ? "waiting-for-sources" : "source-unavailable") : undefined}>
        {active && (
          <AnnotationEventsProvider state={annotationState}><DashboardWindowProvider value={windowActions}><TraceFetcherProvider fetchTrace={fetchTrace}><WidgetDrilldownProvider open={onDrilldown}><ChartEntranceContext.Provider value={memoryOf.entrance}><WidgetAttentionContext.Provider value={attention}>{compare ? (
            <StatComparisonScope
              widget={widget}
              compare={compare}
              fetcher={fetcher}
              start={start}
              end={end}
              minStepSeconds={provider?.minStepSeconds}
              enabled={active && engaged && !savedQueryLoading && !awaitingSources && (!!widget.queryRef || !!provider) && !error}
              debounceMs={editing && selected ? 350 : 0}
              retention={memoryOf.priorRetention}
              primary={savedQueryLoading || error ? undefined : data}
              primarySettled={!!settled}
            >
              {visualization}
            </StatComparisonScope>
          ) : visualization}</WidgetAttentionContext.Provider></ChartEntranceContext.Provider></WidgetDrilldownProvider></TraceFetcherProvider></DashboardWindowProvider></AnnotationEventsProvider>
        )}
      </div>
    </article>
  );
}, (previous, next) => {
  // Grid position belongs to the outer layout, not the chart. A drop can move
  // several dense maps without changing any of their observations or styling.
  // Dimensions, all other document fields and callbacks still invalidate.
  const { widget: before, ...beforeProps } = previous;
  const { widget: after, ...afterProps } = next;
  if (!sameFields(beforeProps, afterProps)) return false;
  if (before === after) return true;
  const { layout: beforeLayout, ...beforeContent } = before;
  const { layout: afterLayout, ...afterContent } = after;
  return sameFields(beforeContent, afterContent) && beforeLayout.w === afterLayout.w && beforeLayout.h === afterLayout.h;
});

/**
 * The pixel box the focused tile takes on the dashboard: `dashboard` in the standard grid, `compact` in the dense view.
 * Absent until the canvas has been measured with the dashboard on screen.
 */
export type PreviewFootprints = { dashboard?: TileFootprint; compact?: TileFootprint };

// The grab handle's axis (s, e, w or se) drives the resize cursor. Falls back to the corner.
function resizeAxis(event: Event): string {
  const handle = event.target instanceof Element ? event.target.closest(".react-resizable-handle") : null;
  const axis = [...(handle?.classList ?? [])].find(name => name.startsWith("react-resizable-handle-"));
  return axis ? axis.slice("react-resizable-handle-".length) : "se";
}

/** The sizing minimum of each widget's definition, keyed by widget id. Unlisted plugins count too. */
export function minimumHeightsOf(widgets: readonly Widget[]): Map<string, number> {
  return new Map(widgets.map(widget => {
    const sizing = getWidgetDefinition(widget)?.sizing;
    return [widget.id, sizing?.minHeightFor ? sizing.minHeightFor(widget.config) : sizing?.minHeight ?? 0];
  }));
}

export function DashboardCanvas({
  dashboard,
  active = true,
  providers,
  fetcher,
  tooltipFetcher = fetcher,
  end,
  refreshStaggerMs = 0,
  editing,
  dense = false,
  referenceCompact = false,
  selected,
  onSelect,
  onLayout,
  onDrilldown,
  onSelection,
  onQueryFields,
  onQueryResult,
  onTimeRange,
  onModeChange,
  onDuplicate,
  onRemove,
  duplicateBlocked,
  focus,
  variables,
  sidePanelOpen = false,
}: {
  dashboard: Dashboard;
  active?: boolean;
  providers: Provider[];
  fetcher: Fetcher;
  tooltipFetcher?: Fetcher;
  end: number;
  /** Spreads automatic refresh across the tiles. Zero adopts the new window at once, as a manual refresh does. */
  refreshStaggerMs?: number;
  editing: boolean;
  dense?: boolean;
  referenceCompact?: boolean;
  selected?: string;
  onSelect: (id: string) => void;
  onLayout: (layout: Layout) => void;
  onDrilldown?: (link: Drilldown, context: DrilldownContext) => void;
  onSelection?: (widget: Widget, context: DrilldownContext) => void;
  onQueryFields?: (snapshot: QueryFieldSnapshot) => void;
  onQueryResult?: (snapshot: WidgetResultSnapshot) => void;
  onTimeRange?: (window: ObservationWindow) => void;
  onModeChange?: (mode: CanvasMode) => void;
  /** Edit-mode tile actions. Each is offered only when the host passes it, and the menu shows it only in edit mode. */
  onDuplicate?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Why Duplicate is unavailable, shown as the menu item's description. */
  duplicateBlocked?: string;
  /** Compose the editor around the same tile/query owner used on the dashboard. */
  focus?: { widget: Widget; render: (preview: ReactNode, footprints?: PreviewFootprints) => ReactNode };
  /** The dashboard's current variable values. A mark whose selection already holds them shows as the applied filter. */
  variables?: VariableValues;
  /** A builder side panel beside the canvas narrows it, so its width is not the dashboard grid's. */
  sidePanelOpen?: boolean;
}) {
  // Keyed on the id and variables, not the dashboard object: a layout edit must not re-render every tile.
  const selectionScope = useMemo<SelectionScope>(
    () => ({ dashboard: { id: dashboard.id, variables: dashboard.variables }, variables: variables ?? {} }),
    [dashboard.id, dashboard.variables, variables],
  );
  const library = useSavedQueryLibrary();
  // Per canvas, keyed by dashboard and widget id. A tile that remounts (a breakpoint swap, a return to the view) reads
  // its last outcome and draw-in record from here, so it neither shows a placeholder nor replays the draw-in.
  const [memory] = useState(() => new Map<string, WidgetMemory>());
  useEffect(() => {
    // Forget widgets that were removed from this dashboard. Other dashboards keep theirs for a return visit.
    const live = new Set(dashboard.widgets.map((widget) => `${dashboard.id}:${widget.id}`));
    for (const key of memory.keys()) if (key.startsWith(`${dashboard.id}:`) && !live.has(key)) memory.delete(key);
  }, [dashboard.id, dashboard.widgets, memory]);
  const { width, containerRef, mounted } = useContainerWidth({
    initialWidth: 1100,
  });
  // The hysteresis needs the mode already on screen. Until the first real measurement there is none, and a hidden canvas
  // (Explore hides the workspace, so it measures 0) must not overwrite the mode it had.
  const [shownMode, setShownMode] = useState<CanvasMode>();
  const measured = mounted && width > 0;
  const mode = measured || shownMode === undefined ? canvasMode(width, shownMode) : shownMode;
  if (measured && mode !== shownMode) setShownMode(mode);
  // Focus mode lays the canvas out inside the workbench, and a side panel narrows it, so neither width says anything
  // about the dashboard grid. The last measurement taken with the full grid on screen is kept for the preview's footprint.
  const [unfocusedGrid, setUnfocusedGrid] = useState<{ width: number; mode: CanvasMode }>();
  // Adjusted while rendering, as the shown mode is, so the next render already has it.
  if (!focus && !sidePanelOpen && measured && (unfocusedGrid?.width !== width || unfocusedGrid.mode !== mode)) setUnfocusedGrid({ width, mode });
  useEffect(() => { if (mounted) onModeChange?.(mode); }, [mode, mounted, onModeChange]);
  const draggable = editing && mode === "wide" && !focus;
  // Subscribing re-renders the canvas when the registry changes. The heights themselves come from every registered
  // definition, listed or not: an unlisted plugin still sizes its saved widgets.
  const definitions = useWidgetDefinitions();
  // definitions is a deliberate dependency: the heights read the registry, so a registry change must recompute them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const minimumHeights = useMemo(() => minimumHeightsOf(dashboard.widgets), [dashboard.widgets, definitions]);
  const layout = useMemo(
    () => dense && !editing ? denseCanvasLayout(dashboard.widgets, mode, width, referenceCompact, minimumHeights) : canvasLayout(dashboard.widgets, mode, width, minimumHeights),
    [dashboard.widgets, mode, width, dense, editing, referenceCompact, minimumHeights],
  );
  // React-grid-layout settles a drag through this compactor, both for the live preview and on drop. The saved
  // positions are read after commit, so a drag always settles against the layout that was on screen when it began.
  const settledBase = useRef(layout);
  useLayoutEffect(() => { settledBase.current = layout; }, [layout]);
  const draggedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const canvas = containerRef.current;
    return () => {
      draggedId.current = undefined;
      canvas?.removeAttribute("data-layout-interacting");
      canvas?.removeAttribute("data-layout-resizing");
      canvas?.removeAttribute("data-layout-resize");
    };
  }, [containerRef, dashboard.id, draggable]);
  const compactor = useMemo<Compactor>(() => ({
    type: "vertical",
    allowOverlap: false,
    compact: (items, cols) => draggedId.current === undefined
      ? verticalCompactor.compact(items, cols)
      : dragSettle(settledBase.current, items, draggedId.current),
  }), []);
  // Keyboard edits are document edits like drags: each one goes through onLayout, so it is one undo step.
  const [announcement, setAnnouncement] = useState("");
  // Host callbacks capture current routes/documents. Keep their tile-facing
  // identity stable so dropping one chart does not redraw every loaded chart,
  // while every interaction still reads the most recently committed state.
  const interaction = useRef({ widgets: dashboard.widgets, layout, onLayout, onDrilldown, onSelection, onTimeRange, onDuplicate, onRemove, draggable });
  useLayoutEffect(() => {
    interaction.current = { widgets: dashboard.widgets, layout, onLayout, onDrilldown, onSelection, onTimeRange, onDuplicate, onRemove, draggable };
  });
  const openRelated = useCallback((link: Drilldown, context: DrilldownContext) => interaction.current.onDrilldown?.(link, context), []);
  const selectObservation = useCallback((widget: Widget, context: DrilldownContext) => interaction.current.onSelection?.(widget, context), []);
  const selectTime = useCallback((window: ObservationWindow) => interaction.current.onTimeRange?.(window), []);
  const duplicateWidget = useCallback((id: string) => interaction.current.onDuplicate?.(id), []);
  const removeWidget = useCallback((id: string) => interaction.current.onRemove?.(id), []);
  // Keys and the tile's actions menu share this step. Below wide the step edits the saved grid, not the reflowed projection
  // on screen (a compact projection changes widths), and the announcement names the place in saved reading order.
  const stepBlocked = useCallback((id: string, key: string, resize: boolean) => {
    const { widgets, layout, draggable } = interaction.current;
    const attempt = layoutStepEdit(widgets, layout, draggable, id, key, resize);
    return attempt && "blocked" in attempt.edit ? attempt.edit.blocked : undefined;
  }, []);
  const step = useCallback((id: string, key: string, resize: boolean) => {
    const { widgets, onLayout, draggable } = interaction.current;
    const widget = widgets.find((item) => item.id === id);
    const attempt = widget ? layoutStepEdit(widgets, interaction.current.layout, draggable, id, key, resize) : undefined;
    if (!widget || !attempt) return;
    const { resizing, direction, edit } = attempt;
    if ("blocked" in edit) {
      setAnnouncement(`${widget.title}: ${edit.blocked}.`);
      return;
    }
    onLayout(edit.layout);
    const placed = edit.layout.find((item) => item.i === id)!;
    if (resizing) {
      const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
      setAnnouncement(`Resized ${widget.title} to ${count(placed.w, "column")} by ${count(placed.h, "row")}.`);
      return;
    }
    if (!draggable) {
      const order = [...edit.layout].sort((a, b) => a.y - b.y || a.x - b.x || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
      const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
      setAnnouncement(`Moved ${widget.title} ${direction}: ${ordinal(order.findIndex((item) => item.i === id) + 1)} of ${order.length}.`);
      return;
    }
    const partner = edit.partner ? widgets.find((item) => item.id === edit.partner)?.title : undefined;
    // The partner is one of the passed widgets, so the rest are the others that moved with it.
    const others = (edit.passed?.length ?? 1) - 1;
    const more = others > 0 ? ` and ${others} other ${others === 1 ? "widget" : "widgets"}` : "";
    const beside = partner ? `, ${direction === "down" ? "below" : "above"} ${partner}${more}` : "";
    setAnnouncement(`Moved ${widget.title} ${direction}${beside}: ${gridPlacement(placed)}.`);
  }, []);
  // Moving an existing DOM subtree with insertBefore detaches thousands of
  // chart descendants and can lose focus. Keep the session's initial reading
  // order while the wide grid positions edits; reflow/view mode uses the new
  // visual order. Newly added panels append to this stable editing sequence.
  const editingOrderKey = draggable ? dashboard.id : undefined;
  const [editingOrder, setEditingOrder] = useState<{ key?: string; ids: string[] }>(() => ({ key: editingOrderKey, ids: layout.map(item => item.i) }));
  if (editingOrder.key !== editingOrderKey) setEditingOrder({ key: editingOrderKey, ids: layout.map(item => item.i) });
  const orderedWidgets = useMemo(() => {
    const byId = new Map(
      dashboard.widgets.map((widget) => [widget.id, widget]),
    );
    if (draggable && editingOrder.key === dashboard.id) {
      const initial = new Set(editingOrder.ids);
      return [...editingOrder.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), ...dashboard.widgets.filter(widget => !initial.has(widget.id))];
    }
    return layout.map((item) => byId.get(item.i)!);
  }, [dashboard.id, dashboard.widgets, layout, draggable, editingOrder]);
  // Chips step through widgets in the order they are now laid out, so a drag in edit mode changes the order they follow.
  const attentionOrder = useMemo(() => [...layout].sort((a, b) => a.y - b.y || a.x - b.x).map((item) => ({ id: item.i })), [layout]);
  // Idle prefetch warms the next tiles in reading order, only when the board is read (not edited or focused),
  // the scheduler reports diagnostics to measure its idleness, and Save-Data is off.
  const prefetchIds = attentionOrder.map((item) => item.id);
  const connection = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const diagnostics = fetcherDiagnostics(fetcher);
  const prefetched = useIdlePrefetch(prefetchIds, diagnostics, active && !editing && !focus && !!diagnostics && prefetchSupported(prefetchIds.length, connection));
  const range = dashboardRange(dashboard, end);
  const focusMinimum = focus ? Math.max(focus.widget.type === "stat" ? 180 : 360, canvasLayout([
    { ...focus.widget, layout: { ...focus.widget.layout, h: 2 } },
  ], mode, width, minimumHeights)[0].h * 74 - 16) : undefined;
  const previewFootprints: PreviewFootprints | undefined = focus && unfocusedGrid ? (() => {
    // The staged widget replaces its saved copy, so the footprint follows the Layout tab. A new widget is appended.
    const widgets = dashboard.widgets.some(item => item.id === focus.widget.id)
      ? dashboard.widgets.map(item => item.id === focus.widget.id ? focus.widget : item)
      : [...dashboard.widgets, focus.widget];
    const footprint = (dense: boolean) => tileFootprint(widgets, focus.widget.id, {
      mode: unfocusedGrid.mode, width: unfocusedGrid.width, dense, referenceCompact, minimumHeights: minimumHeightsOf(widgets),
    });
    return { dashboard: footprint(false), compact: footprint(true) };
  })() : undefined;
  const stackedView = mode === "stacked" && !editing;
  const tiles = (focus ? [focus.widget] : orderedWidgets).map((widget, index) => (
              <div key={widget.id} className={focus ? styles.focusedTile : undefined} style={!focus && stackedView && !intrinsicStat(widget) ? { height: layout[index].h * 74 - 16 } : undefined}>
                <Tile
                  key={`${dashboard.id}:${widget.id}`}
                  widget={widget}
                  active={active}
                  provider={providers.find(
                    (provider) =>
                      provider.id ===
                      (widget.queryRef
                        ? library.queries.find(
                            (entry) => entry.id === widget.queryRef!.id,
                          )?.providerId
                        : widget.providerId),
                  )}
                  fetcher={fetcher}
                  boardStart={range.start}
                  boardEnd={range.end}
                  refreshStaggerMs={refreshStaggerMs}
                  prefetch={prefetched.has(widget.id)}
                  naturalHeight={!focus && stackedView && intrinsicStat(widget)}
                  referenceCompact={referenceCompact && !editing}
                  editing={editing}
                  focused={!!focus}
                  draggable={draggable}
                  selected={selected === widget.id}
                  onSelect={onSelect}
                  onDrilldown={onDrilldown ? openRelated : undefined}
                  onSelection={onSelection ? selectObservation : undefined}
                  onQueryFields={onQueryFields}
                  onQueryResult={onQueryResult}
                  onTimeRange={onTimeRange ? selectTime : undefined}
                  onNudge={draggable ? step : undefined}
                  onStep={editing && !focus ? step : undefined}
                  stepBlocked={editing && !focus ? stepBlocked : undefined}
                  onDuplicate={editing && !focus && onDuplicate ? duplicateWidget : undefined}
                  onRemove={editing && !focus && onRemove ? removeWidget : undefined}
                  duplicateBlocked={duplicateBlocked}
                  memory={memory}
                  memoryKey={`${dashboard.id}:${widget.id}`}
                  selectionScope={selectionScope}
                />
              </div>
            ));
  const autoRefresh: AutoRefresh = dashboard.customTimeRange
    ? { mode: "fixed" }
    : dashboard.refreshInterval ? { mode: "every", seconds: dashboard.refreshInterval } : { mode: "off" };
  return (
    <DashboardTimeZoneProvider timeZone={dashboard.timeZone}>
    <AttentionStoreProvider>
    <SampleAsOfProvider>
    <TooltipQueryProvider
      fetcher={tooltipFetcher}
      providers={providers}
      start={range.start}
      end={range.end}
    >
      {/* Above the measured canvas, so tile geometry stays relative to the anchor and the strip reserves its own height. */}
      {/* Not in focus mode: the workbench owns the top of the page, and the tiles it hides keep their last known state in the store. */}
      {!!dashboard.widgets.length && !focus && <AttentionStrip widgets={attentionOrder} scopeRef={containerRef} autoRefresh={autoRefresh} />}
      <div
        ref={containerRef}
        className={`${styles.canvas} ${editing && !focus ? styles.editingCanvas : ""}`}
        data-testid="dashboard-canvas"
        style={focusMinimum ? { "--widget-preview-min-height": `${focusMinimum}px` } as CSSProperties : undefined}
        data-layout-mode={mode}
        data-density={dense && !editing && mode === "wide" ? "compact" : "standard"}
        onMouseDownCapture={(event) => {
          // Native selection suppression on the handles replaces the grid's
          // page-wide ::selection stylesheet and body-class mutations.
          if (draggable && event.button === 0 && event.target instanceof Element &&
              event.target.closest(".insights-drag-handle, .react-resizable-handle")) event.preventDefault();
        }}
      >
        {editing && !focus && <div className={styles.srOnly} aria-live="polite">{announcement}</div>}
        <ChartCursorProvider key={dashboard.id}>
        {mounted && (focus ? focus.render(tiles, previewFootprints) : stackedView ? <div className={styles.stackedView}>{tiles}</div> : (
          <ReactGridLayout
            width={width}
            layout={layout}
            gridConfig={{
              cols: 12,
              rowHeight: dense && !editing && mode === "wide" ? 25 : 58,
              margin: dense && !editing && mode === "wide" ? [8, 4] : [16, 16],
              containerPadding: [0, 0],
            }}
            dragConfig={{
              enabled: draggable,
              handle: ".insights-drag-handle",
              enableUserSelectHack: false,
            }}
            resizeConfig={{ enabled: draggable, handles: ["s", "e", "w", "se"], enableUserSelectHack: false }}
            compactor={compactor}
            onDragStart={(_layout, item) => {
              draggedId.current = item?.i;
              containerRef.current?.setAttribute("data-layout-interacting", "true");
            }}
            onDragStop={(next) => {
              draggedId.current = undefined;
              containerRef.current?.removeAttribute("data-layout-interacting");
              if (draggable) onLayout(next);
            }}
            onResizeStart={(_layout, _old, _next, _placeholder, event) => {
              containerRef.current?.setAttribute("data-layout-interacting", "true");
              containerRef.current?.setAttribute("data-layout-resizing", "true");
              containerRef.current?.setAttribute("data-layout-resize", resizeAxis(event));
            }}
            onResizeStop={(next) => {
              containerRef.current?.removeAttribute("data-layout-interacting");
              containerRef.current?.removeAttribute("data-layout-resizing");
              containerRef.current?.removeAttribute("data-layout-resize");
              if (draggable) onLayout(next);
            }}
          >
            {tiles}
          </ReactGridLayout>
        ))}
        </ChartCursorProvider>
      </div>
    </TooltipQueryProvider>
    </SampleAsOfProvider>
    </AttentionStoreProvider>
    </DashboardTimeZoneProvider>
  );
}
