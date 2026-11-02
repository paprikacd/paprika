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
} from "react";
import ReactGridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Compactor,
  type Layout,
} from "react-grid-layout";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Grip, Network, PieChart, Settings2, Shield, Target } from "lucide-react";
import { WidgetVisualization } from "./charts";
import { WidgetDrilldownProvider } from "./widget-drilldown";
import { useWidgetQuery, type QueryRetention, type RetainedQuery } from "./query";
import { ChartEntranceContext, type ChartEntranceSlot } from "./chart-entrance";
import { TooltipQueryProvider } from "./tooltip-query";
import { ChartCursorProvider } from "./chart-cursor";
import { DashboardWindowProvider } from "./dashboard-window";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import type { ObservationWindow } from "./time-window";
import { TraceFetcherProvider } from "./trace-waterfall";
import { AnnotationEventsProvider, useRecordedEvents } from "./annotation-events";
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
interface WidgetMemory { retained?: RetainedQuery; entered: boolean }
/** The query and draw-in records for one widget, backed by that widget's entry in the canvas memory. */
function memoryFor(memory: Map<string, WidgetMemory>, key: string): { retention: QueryRetention; entrance: ChartEntranceSlot } {
  return {
    retention: {
      read: () => memory.get(key)?.retained,
      write: (retained) => { memory.set(key, { retained, entered: memory.get(key)?.entered ?? false }); },
    },
    entrance: {
      entered: () => memory.get(key)?.entered ?? false,
      markEntered: () => { memory.set(key, { retained: memory.get(key)?.retained, entered: true }); },
    },
  };
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
  const memoryOf = useMemo(() => memoryFor(memory, memoryKey), [memory, memoryKey]);
  const { data, loading, error, refresh } = useWidgetQuery(widget, {
    fetcher,
    start,
    end,
    step: Math.max(1, Math.ceil((end - start) / 300)),
    enabled: active && visible && !savedQueryLoading && (!!widget.queryRef || !!provider),
    debounceMs: editing && selected ? 350 : 0,
    retention: memoryOf.retention,
  });
  // A paused, never-queried tile has no result yet; it is not an empty query
  // response. Keep that distinction through the observer-to-effect handoff.
  const canQuery = !!widget.queryRef || (!!provider && !!widget.providerId && !!widget.query.trim());
  const awaitingFirstResult = active && canQuery && !data && !error;
  const annotationData = useRecordedEvents(widget.annotationSource, fetcher, widget.providerId, start, end, active && visible && !library.loading && !library.error);
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
  const textColor = widgetTextColor(widget.options);
  const StatIcon = widget.type === "stat" && widget.options?.statIcon ? STAT_ICONS[widget.options.statIcon] : undefined;
  const links = widget.drilldowns ?? [];
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
      className={`${styles.tile} ${selected ? styles.selectedTile : ""}`}
      data-intrinsic-stat={naturalHeight || undefined}
      data-widget-id={widget.id}
      data-widget-type={widget.type}
      data-widget-sparkline={widget.type === "stat" && widget.options?.showSparkline || undefined}
      data-sparkline-placement={widget.type === "stat" ? widget.options?.sparklinePlacement : undefined}
      data-stat-icon={StatIcon ? "true" : undefined}
      data-compact-stat={widget.type === "stat" && widget.layout.h === 1 ? "true" : undefined}
      aria-label={widget.title}
      style={
        {
          background: widget.options?.background,
          color: textColor,
          "--widget-text": textColor,
          "--stat-icon-color": widget.color,
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
          <h3 style={{ color: textColor }}>{widget.title}</h3>
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
            trigger={<ArrowUpRight size={15} aria-hidden="true" />}
            items={links.map((link) => {
              const reason = drilldownContextReason(link, context);
              return {
                id: link.id,
                label: link.title,
                description:
                  reason ??
                  (context.series ? `From ${context.series}` : undefined),
                disabled: !!reason,
                onSelect: () => onDrilldown(link, context),
              };
            })}
          />
        )}
        {editing && (
          <GammaButton
            iconOnly
            size="sm"
            variant="quiet"
            className={styles.iconButton}
            aria-label={`Edit ${widget.title}`}
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
      {widget.type === "timeseries" && context.timestamp !== undefined && <div className={contextStyles.selection} role="status">
        Links use selected sample at <time dateTime={new Date(context.timestamp).toISOString()}>{new Date(context.timestamp).toLocaleString()}</time>
      </div>}
      <div className={styles.visualization}>
        {active && (
          <AnnotationEventsProvider state={annotationState}><DashboardWindowProvider value={windowActions}><TraceFetcherProvider fetchTrace={fetchTrace}><WidgetDrilldownProvider open={onDrilldown}><ChartEntranceContext.Provider value={memoryOf.entrance}><WidgetVisualization
            widget={widget}
            naturalHeight={naturalHeight}
            result={savedQueryLoading ? undefined : data}
            loading={savedQueryLoading || loading || (visible && awaitingFirstResult)}
            deferred={!savedQueryLoading && !visible && awaitingFirstResult}
            error={
              savedQueryLoading ? null : error ??
              (!provider && !widget.queryRef
                ? `Provider “${widget.providerId}” is not configured.`
                : null)
            }
            onRetry={error && active && visible && !savedQueryLoading ? refresh : undefined}
            onContextChange={
              (onDrilldown && needsContext) || selectionEnabled ? selectContext : undefined
            }
          /></ChartEntranceContext.Provider></WidgetDrilldownProvider></TraceFetcherProvider></DashboardWindowProvider></AnnotationEventsProvider>
        )}
      </div>
    </article>
  );
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
  const draggable = editing && mode === "wide";
  const layout = useMemo(
    () => dense && !editing ? denseCanvasLayout(dashboard.widgets, mode, width, referenceCompact) : canvasLayout(dashboard.widgets, mode, width),
    [dashboard.widgets, mode, width, dense, editing, referenceCompact],
  );
  // React-grid-layout settles a drag through this compactor, both for the live preview and on drop. The saved
  // positions are read after commit, so a drag always settles against the layout that was on screen when it began.
  const settledBase = useRef(layout);
  useLayoutEffect(() => { settledBase.current = layout; }, [layout]);
  const draggedId = useRef<string | undefined>(undefined);
  const compactor = useMemo<Compactor>(() => ({
    type: "vertical",
    allowOverlap: false,
    compact: (items, cols) => draggedId.current === undefined
      ? verticalCompactor.compact(items, cols)
      : dragSettle(settledBase.current, items, draggedId.current),
  }), []);
  // Keyboard edits are document edits like drags: each one goes through onLayout, so it is one undo step.
  const [announcement, setAnnouncement] = useState("");
  const nudge = useCallback((id: string, key: string, resize: boolean) => {
    const widget = dashboard.widgets.find((item) => item.id === id);
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
    const partner = edit.partner ? dashboard.widgets.find((item) => item.id === edit.partner)?.title : undefined;
    const beside = partner ? `, ${direction === "down" ? "below" : "above"} ${partner}` : "";
    setAnnouncement(`Moved ${widget.title} ${direction}${beside}: ${gridPlacement(placed)}.`);
  }, [dashboard.widgets, layout, onLayout]);
  const orderedWidgets = useMemo(() => {
    const byId = new Map(
      dashboard.widgets.map((widget) => [widget.id, widget]),
    );
    return layout.map((item) => byId.get(item.i)!);
  }, [dashboard.widgets, layout]);
  const range = dashboardRange(dashboard, end);
  const stackedView = mode === "stacked" && !editing;
  const tiles = orderedWidgets.map((widget, index) => (
              <div key={widget.id} style={stackedView && !intrinsicStat(widget) ? { height: layout[index].h * 74 - 16 } : undefined}>
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
                  naturalHeight={stackedView && intrinsicStat(widget)}
                  referenceCompact={referenceCompact && !editing}
                  editing={editing}
                  draggable={draggable}
                  selected={selected === widget.id}
                  onSelect={onSelect}
                  onDrilldown={onDrilldown}
                  onSelection={onSelection}
                  onQueryFields={onQueryFields}
                  onQueryResult={onQueryResult}
                  onTimeRange={onTimeRange}
                  onNudge={draggable ? nudge : undefined}
                  memory={memory}
                  memoryKey={`${dashboard.id}:${widget.id}`}
                />
              </div>
            ));
  return (
    <DashboardTimeZoneProvider timeZone={dashboard.timeZone}>
    <TooltipQueryProvider
      fetcher={tooltipFetcher}
      providers={providers}
      start={range.start}
      end={range.end}
      step={Math.max(1, Math.ceil((range.end - range.start) / 300))}
    >
      <div
        ref={containerRef}
        className={`${styles.canvas} ${editing ? styles.editingCanvas : ""}`}
        data-testid="dashboard-canvas"
        data-layout-mode={mode}
        data-density={dense && !editing && mode === "wide" ? "compact" : "standard"}
      >
        {draggable && <div className={styles.srOnly} aria-live="polite">{announcement}</div>}
        <ChartCursorProvider key={dashboard.id}>
        {mounted && (stackedView ? <div className={styles.stackedView}>{tiles}</div> : (
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
            }}
            resizeConfig={{ enabled: draggable, handles: ["se"] }}
            compactor={compactor}
            onDragStart={(_layout, item) => {
              draggedId.current = item?.i;
            }}
            onDragStop={(next) => {
              draggedId.current = undefined;
              if (draggable) onLayout(next);
            }}
            onResizeStop={(next) => {
              if (draggable) onLayout(next);
            }}
          >
            {tiles}
          </ReactGridLayout>
        ))}
        </ChartCursorProvider>
      </div>
    </TooltipQueryProvider>
    </DashboardTimeZoneProvider>
  );
}
