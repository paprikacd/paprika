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
  type KeyboardEvent,
  type ReactNode,
} from "react";
import ReactGridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Compactor,
  type Layout,
} from "react-grid-layout";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Grip, Network, PieChart, Settings2, Shield, Target } from "lucide-react";
import { WidgetVisualization } from "./charts";
import { sourceWaitMessage, useSourceStatus } from "./source-status";
import { useWidgetDefinitions } from "./widget-registry";
import { WidgetDrilldownProvider } from "./widget-drilldown";
import { useWidgetQuery, type QueryRetention, type RetainedQuery } from "./query";
import { ChartEntranceContext, type ChartEntranceSlot } from "./chart-entrance";
import { TooltipQueryProvider } from "./tooltip-query";
import { ChartCursorProvider } from "./chart-cursor";
import { DashboardWindowProvider } from "./dashboard-window";
import { DashboardTimeZoneProvider, useDashboardTimeZone } from "./dashboard-time-zone";
import { fullDateTimeOptions } from "./chart-data";
import type { ObservationWindow } from "./time-window";
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
import type { DrilldownContext } from "./drilldown";
import {
  contextKey,
  drilldownContextReason,
  widgetContexts,
} from "./widget-context";
import { dashboardRange } from "./time-range";
import { widgetTextColor } from "./appearance";
import { canvasLayout, canvasMode, denseCanvasLayout, intrinsicStat, type CanvasMode } from "./responsive-layout";
import {
  dragSettle,
  gridPlacement,
  LAYOUT_KEYSHORTCUTS,
  layoutMoveForKey,
  layoutResizeForKey,
  moveLayout,
  resizeLayout,
  type LayoutEdit,
} from "./layout-edit";
import styles from "./insights.module.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { GammaButton } from "./gamma/button";
import { useSavedQueryLibrary } from "./saved-query-context";
import { GammaSelect } from "./gamma/select";
import { GammaActionMenu } from "./gamma/action-menu";
import contextStyles from "./widget-context.module.css";
import recordStyles from "./plugins/records.module.css";
import { queryConnectionKey, queryFields, type QueryFieldSnapshot } from "./query-connections";
import { AttentionStoreProvider, useAttentionPublisher } from "./attention-store";
import { AttentionStrip, type AutoRefresh } from "./attention-strip";
import { isAttentionLevel, widgetAttention, WidgetAttentionContext, type AttentionFailure } from "./widget-attention";
import { statusToken, thresholdPaint } from "./status";

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
interface WidgetMemory { retained?: RetainedQuery; annotation?: RetainedAnnotationEvents; entered: boolean }
/** The query and draw-in records for one widget, backed by that widget's entry in the canvas memory. */
function memoryFor(memory: Map<string, WidgetMemory>, key: string): { retention: QueryRetention; annotationRetention: AnnotationEventsRetention; entrance: ChartEntranceSlot } {
  return {
    retention: {
      read: () => memory.get(key)?.retained,
      write: (retained) => { memory.set(key, { ...memory.get(key), retained, entered: memory.get(key)?.entered ?? false }); },
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
const Tile = memo(function Tile({
  widget,
  active,
  provider,
  fetcher,
  start,
  end,
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
  memory,
  memoryKey,
}: {
  widget: Widget;
  active: boolean;
  provider?: Provider;
  fetcher: Fetcher;
  start: number;
  end: number;
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
  memory: Map<string, WidgetMemory>;
  memoryKey: string;
}) {
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
        rootMargin: "200px",
      },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  // A focused editor stays engaged while its author scrolls down to query controls.
  const engaged = visible || focused;
  const memoryOf = useMemo(() => memoryFor(memory, memoryKey), [memory, memoryKey]);
  // A tile whose source is not in the loaded list waits while the list is pending or
  // unavailable. A loaded source queries even when the shared catalog failed, so local
  // tiles keep working beside the banner.
  const sourceStatus = useSourceStatus();
  const waitingOn = sourceStatus !== "ready" && !provider ? sourceStatus : null;
  const awaitingSources = waitingOn !== null;
  // A shared tile stays busy while the shared catalog reloads, even though it still queries.
  const busyOnSources = waitingOn === "pending" || (sourceStatus === "pending" && provider?.source === "observability");
  const { data, loading, error, refresh } = useWidgetQuery(widget, {
    fetcher,
    start,
    end,
    step: Math.max(1, Math.ceil((end - start) / 300)),
    enabled: active && engaged && !savedQueryLoading && !awaitingSources && (!!widget.queryRef || !!provider),
    debounceMs: editing && selected ? 350 : 0,
    retention: memoryOf.retention,
  });
  // A paused, never-queried tile has no result yet; it is not an empty query
  // response. Keep that distinction through the observer-to-effect handoff.
  const canQuery = !!widget.queryRef || (!!provider && !!widget.providerId && !!widget.query.trim());
  const awaitingFirstResult = active && canQuery && !data && !error;
  const annotationData = useRecordedEvents(widget.annotationSource, fetcher, widget.providerId, start, end, active && engaged && !library.loading && !library.error, memoryOf.annotationRetention);
  const annotationState = widget.annotationSource && library.error ? { events: [], error: library.error } : annotationData;
  const fetchTrace = useCallback((traceId: string, signal: AbortSignal) => fetcher({
    providerId: widget.providerId, query: widget.query, kind: "traces", start, end,
    step: Math.max(1, Math.ceil((end - start) / 300)), traceId,
    ...(widget.queryRef ? { queryRef: widget.queryRef } : {}),
  }, signal), [fetcher, widget.providerId, widget.query, widget.queryRef, start, end]);
  const previous = useCallback((window: ObservationWindow, signal: AbortSignal) => {
    const duration = window.end - window.start;
    if (!Number.isFinite(duration) || duration < 1000 || duration > 31 * 86400_000 || window.start - duration <= 0)
      return Promise.reject(new Error("Choose a window from one second up to 31 days with an available previous period."));
    return fetcher({ providerId: widget.providerId, query: widget.query, kind: "metrics",
      start: (window.start - duration) / 1000, end: (window.start - 1) / 1000,
      step: Math.max(1, Math.ceil(duration / 300_000)), ...(widget.queryRef ? { queryRef: widget.queryRef } : {}) }, signal);
  }, [fetcher, widget.providerId, widget.query, widget.queryRef]);
  const windowActions = useMemo(() => ({ apply: editing ? undefined : onTimeRange, previous, rangeEnd: end * 1000 }), [editing, onTimeRange, previous, end]);
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
  const attention = useMemo(
    () => widgetAttention(widget, { result: savedQueryLoading ? undefined : data, failure: sourceFailure, rangeEnd: end * 1000 }),
    [widget, savedQueryLoading, data, sourceFailure, end],
  );
  // The newest settled query. The retained record keeps it across a remount, so a restored result keeps its age.
  const retention = memoryOf.retention;
  // Read on each render: a settle writes the record and then re-renders the tile, so the read is never stale.
  const completedAt = retention.read()?.request?.settledAt;
  // The strip counts the same facts query_dashboard does. An unmounted tile keeps its last facts, released not dropped.
  const attentionPublisher = useAttentionPublisher();
  const facts = attention.facts;
  useEffect(() => {
    attentionPublisher.publish({ widgetId: widget.id, title: widget.title, facts, completedAt });
  }, [attentionPublisher, widget.id, widget.title, facts, completedAt]);
  useEffect(() => () => attentionPublisher.release(widget.id), [attentionPublisher, widget.id]);
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
  // These plugins call the host only for a deliberate click or keyboard activation.
  // Other renderers can report focus/hover context and must not change filters.
  const selectionEnabled = supportsDashboardSelection(widget) &&
    !!widget.selectionBindings?.length && !!onSelection && !editing;
  const selectContext = useCallback(
    (next: DrilldownContext) => {
      setSelection({ scope: contextScope, context: next, result: data });
      if (selectionEnabled) onSelection?.(widget, next);
    },
    [contextScope, data, widget, onSelection, selectionEnabled],
  );
  // Capture runs before the focused control's own arrow handling (a sparkline or a selector), so Alt+Arrow
  // edits the layout whichever control in the tile has focus. Plain arrows and text fields keep their keys.
  const layoutKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!onNudge || !event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (!(event.shiftKey ? layoutResizeForKey(event.key) : layoutMoveForKey(event.key))) return;
    if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    event.stopPropagation();
    onNudge(widget.id, event.key, event.shiftKey);
  };
  return (
    <article
      ref={element}
      tabIndex={onNudge ? 0 : undefined}
      aria-keyshortcuts={onNudge ? LAYOUT_KEYSHORTCUTS : undefined}
      onKeyDownCapture={onNudge ? layoutKey : undefined}
      className={`${styles.tile} ${selected && !focused ? styles.selectedTile : ""}`}
      data-intrinsic-stat={naturalHeight || undefined}
      data-widget-id={widget.id}
      data-widget-type={widget.type}
      data-widget-sparkline={widget.type === "stat" && widget.options?.showSparkline || undefined}
      data-sparkline-placement={widget.type === "stat" ? widget.options?.sparklinePlacement : undefined}
      data-stat-icon={StatIcon ? "true" : undefined}
      data-attention={attention.state}
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
            data-widget-edit={widget.id}
            onClick={() => onSelect(widget.id)}
          >
            <Settings2 size={15} />
          </GammaButton>
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
              if (next) selectContext(next);
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
          <AnnotationEventsProvider state={annotationState}><DashboardWindowProvider value={windowActions}><TraceFetcherProvider fetchTrace={fetchTrace}><WidgetDrilldownProvider open={onDrilldown}><ChartEntranceContext.Provider value={memoryOf.entrance}><WidgetAttentionContext.Provider value={attention}><WidgetVisualization
            widget={widget}
            naturalHeight={naturalHeight}
            result={savedQueryLoading ? undefined : data}
            loading={savedQueryLoading || loading || (engaged && awaitingFirstResult)}
            deferred={!savedQueryLoading && !engaged && awaitingFirstResult}
            sourceState={!savedQueryLoading && waitingOn ? { status: waitingOn, label: waitingOn === "pending" ? "Waiting for data sources…" : sourceWaitMessage(waitingOn) } : undefined}
            error={visibleError}
            onRetry={error && active && engaged && !savedQueryLoading ? refresh : undefined}
            onContextChange={
              (onDrilldown && needsContext) || selectionEnabled ? selectContext : undefined
            }
          /></WidgetAttentionContext.Provider></ChartEntranceContext.Provider></WidgetDrilldownProvider></TraceFetcherProvider></DashboardWindowProvider></AnnotationEventsProvider>
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

export function DashboardCanvas({
  dashboard,
  active = true,
  providers,
  fetcher,
  tooltipFetcher = fetcher,
  end,
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
  focus,
}: {
  dashboard: Dashboard;
  active?: boolean;
  providers: Provider[];
  fetcher: Fetcher;
  tooltipFetcher?: Fetcher;
  end: number;
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
  /** Compose the editor around the same tile/query owner used on the dashboard. */
  focus?: { widget: Widget; render: (preview: ReactNode) => ReactNode };
}) {
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
  const mode = canvasMode(width);
  useEffect(() => { if (mounted) onModeChange?.(mode); }, [mode, mounted, onModeChange]);
  const draggable = editing && mode === "wide" && !focus;
  const definitions = useWidgetDefinitions();
  const minimumHeights = useMemo(() => new Map(dashboard.widgets.map(widget => [widget.id,
    definitions.find(definition => definition.type === widget.type && definition.id === (widget.pluginId ?? widget.type))?.sizing?.minHeight ?? 0,
  ])), [dashboard.widgets, definitions]);
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
  const interaction = useRef({ widgets: dashboard.widgets, layout, onLayout, onDrilldown, onSelection, onTimeRange });
  useLayoutEffect(() => {
    interaction.current = { widgets: dashboard.widgets, layout, onLayout, onDrilldown, onSelection, onTimeRange };
  });
  const openRelated = useCallback((link: Drilldown, context: DrilldownContext) => interaction.current.onDrilldown?.(link, context), []);
  const selectObservation = useCallback((widget: Widget, context: DrilldownContext) => interaction.current.onSelection?.(widget, context), []);
  const selectTime = useCallback((window: ObservationWindow) => interaction.current.onTimeRange?.(window), []);
  const nudge = useCallback((id: string, key: string, resize: boolean) => {
    const { widgets, layout, onLayout } = interaction.current;
    const widget = widgets.find((item) => item.id === id);
    const resizing = resize ? layoutResizeForKey(key) : undefined;
    const direction = resize ? undefined : layoutMoveForKey(key);
    if (!widget || (!resizing && !direction)) return;
    const edit: LayoutEdit | undefined = resizing
      ? resizeLayout(layout, id, resizing[0], resizing[1])
      : direction ? moveLayout(layout, id, direction) : undefined;
    if (!edit) return;
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
  const range = dashboardRange(dashboard, end);
  const focusMinimum = focus ? Math.max(focus.widget.type === "stat" ? 180 : 360, canvasLayout([
    { ...focus.widget, layout: { ...focus.widget.layout, h: 2 } },
  ], mode, width, minimumHeights)[0].h * 74 - 16) : undefined;
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
                  start={range.start}
                  end={range.end}
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
                  onNudge={draggable ? nudge : undefined}
                  memory={memory}
                  memoryKey={`${dashboard.id}:${widget.id}`}
                />
              </div>
            ));
  const autoRefresh: AutoRefresh = dashboard.customTimeRange
    ? { mode: "fixed" }
    : dashboard.refreshInterval ? { mode: "every", seconds: dashboard.refreshInterval } : { mode: "off" };
  return (
    <DashboardTimeZoneProvider timeZone={dashboard.timeZone}>
    <AttentionStoreProvider>
    <TooltipQueryProvider
      fetcher={tooltipFetcher}
      providers={providers}
      start={range.start}
      end={range.end}
      step={Math.max(1, Math.ceil((range.end - range.start) / 300))}
    >
      {/* Above the measured canvas, so tile geometry stays relative to the anchor and the strip reserves its own height. */}
      {!!dashboard.widgets.length && <AttentionStrip widgets={orderedWidgets} scopeRef={containerRef} autoRefresh={autoRefresh} inset={!!focus} />}
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
        {draggable && <div className={styles.srOnly} aria-live="polite">{announcement}</div>}
        <ChartCursorProvider key={dashboard.id}>
        {mounted && (focus ? focus.render(tiles) : stackedView ? <div className={styles.stackedView}>{tiles}</div> : (
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
            resizeConfig={{ enabled: draggable, handles: ["se"], enableUserSelectHack: false }}
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
            onResizeStart={() => {
              containerRef.current?.setAttribute("data-layout-interacting", "true");
              containerRef.current?.setAttribute("data-layout-resizing", "true");
            }}
            onResizeStop={(next) => {
              containerRef.current?.removeAttribute("data-layout-interacting");
              containerRef.current?.removeAttribute("data-layout-resizing");
              if (draggable) onLayout(next);
            }}
          >
            {tiles}
          </ReactGridLayout>
        ))}
        </ChartCursorProvider>
      </div>
    </TooltipQueryProvider>
    </AttentionStoreProvider>
    </DashboardTimeZoneProvider>
  );
}
