import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import ReactGridLayout, {
  useContainerWidth,
  verticalCompactor,
  type Layout,
} from "react-grid-layout";
import { ArrowUpRight, Grip, Settings2 } from "lucide-react";
import { WidgetVisualization } from "./charts";
import { useWidgetQuery } from "./query";
import { TooltipQueryProvider } from "./tooltip-query";
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
import { canvasLayout, canvasMode } from "./responsive-layout";
import styles from "./insights.module.css";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { GammaButton } from "./gamma/button";
import { useSavedQueryLibrary } from "./saved-query-context";
import { GammaSelect } from "./gamma/select";
import { GammaActionMenu } from "./gamma/action-menu";
import contextStyles from "./widget-context.module.css";
import { queryConnectionKey, queryFields, type QueryFieldSnapshot } from "./query-connections";

type Fetcher = (
  query: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryResult>;
const Tile = memo(function Tile({
  widget,
  active,
  provider,
  fetcher,
  start,
  end,
  editing,
  draggable,
  selected,
  onSelect,
  onDrilldown,
  onQueryFields,
}: {
  widget: Widget;
  active: boolean;
  provider?: Provider;
  fetcher: Fetcher;
  start: number;
  end: number;
  editing: boolean;
  draggable: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onDrilldown?: (link: Drilldown, context: DrilldownContext) => void;
  onQueryFields?: (snapshot: QueryFieldSnapshot) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      {
        rootMargin: "200px",
      },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const { data, loading, error } = useWidgetQuery(widget, {
    fetcher,
    start,
    end,
    step: Math.max(1, Math.ceil((end - start) / 300)),
    enabled: active && visible && (!!widget.queryRef || !!provider),
    debounceMs: editing && selected ? 350 : 0,
  });
  const connectionKey = queryConnectionKey(widget, { start, end });
  useEffect(() => {
    if (selected && onQueryFields) onQueryFields({ widgetId: widget.id, key: connectionKey, fetcher, fields: data && !error ? queryFields(data) : undefined });
  }, [selected, onQueryFields, widget.id, connectionKey, fetcher, data, error]);
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
      : (selectedContext ?? (contexts.length === 1 ? contexts[0] : {}));
  const textColor = widgetTextColor(widget.options);
  const links = widget.drilldowns ?? [];
  const needsContext = links.some((link) =>
    link.bindings?.some((binding) => binding.source !== "constant"),
  );
  const showSeriesPicker =
    !!onDrilldown &&
    needsContext &&
    contexts.length > 1 &&
    !["heatmap", "table", "traces", "plugin"].includes(widget.type);
  const selectContext = useCallback(
    (next: DrilldownContext) =>
      setSelection({ scope: contextScope, context: next, result: data }),
    [contextScope, data],
  );
  return (
    <article
      ref={element}
      className={`${styles.tile} ${selected ? styles.selectedTile : ""}`}
      data-widget-id={widget.id}
      aria-label={widget.title}
      style={
        {
          background: widget.options?.background,
          color: textColor,
          "--widget-text": textColor,
        } as CSSProperties
      }
    >
      <div className={styles.tileHeader}>
        {draggable && (
          <span
            className={`insights-drag-handle ${styles.dragHandle}`}
            title="Drag to move widget"
            aria-hidden="true"
          >
            <Grip size={14} />
          </span>
        )}
        <div className={styles.tileTitle}>
          <h3 style={{ color: textColor }}>{widget.title}</h3>
          {widget.description && (
            <p style={{ color: textColor }}>{widget.description}</p>
          )}
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
      <div className={styles.visualization}>
        {active && (
          <WidgetVisualization
            widget={widget}
            result={data}
            loading={loading}
            error={
              error ??
              (!provider && !widget.queryRef
                ? `Provider “${widget.providerId}” is not configured.`
                : null)
            }
            onContextChange={
              onDrilldown && needsContext ? selectContext : undefined
            }
          />
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
  selected,
  onSelect,
  onLayout,
  onDrilldown,
  onQueryFields,
}: {
  dashboard: Dashboard;
  active?: boolean;
  providers: Provider[];
  fetcher: Fetcher;
  tooltipFetcher?: Fetcher;
  end: number;
  editing: boolean;
  selected?: string;
  onSelect: (id: string) => void;
  onLayout: (layout: Layout) => void;
  onDrilldown?: (link: Drilldown, context: DrilldownContext) => void;
  onQueryFields?: (snapshot: QueryFieldSnapshot) => void;
}) {
  const library = useSavedQueryLibrary();
  const { width, containerRef, mounted } = useContainerWidth({
    initialWidth: 1100,
  });
  const mode = canvasMode(width);
  const draggable = editing && mode === "wide";
  const layout = useMemo(
    () => canvasLayout(dashboard.widgets, mode),
    [dashboard.widgets, mode],
  );
  const orderedWidgets = useMemo(() => {
    const byId = new Map(
      dashboard.widgets.map((widget) => [widget.id, widget]),
    );
    return layout.map((item) => byId.get(item.i)!);
  }, [dashboard.widgets, layout]);
  const range = dashboardRange(dashboard, end);
  return (
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
      >
        {mounted && (
          <ReactGridLayout
            width={width}
            layout={layout}
            gridConfig={{
              cols: 12,
              rowHeight: 58,
              margin: [16, 16],
              containerPadding: [0, 0],
            }}
            dragConfig={{
              enabled: draggable,
              handle: ".insights-drag-handle",
            }}
            resizeConfig={{ enabled: draggable, handles: ["se"] }}
            compactor={verticalCompactor}
            onDragStop={(next) => {
              if (draggable) onLayout(next);
            }}
            onResizeStop={(next) => {
              if (draggable) onLayout(next);
            }}
          >
            {orderedWidgets.map((widget) => (
              <div key={widget.id}>
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
                  editing={editing}
                  draggable={draggable}
                  selected={selected === widget.id}
                  onSelect={onSelect}
                  onDrilldown={onDrilldown}
                  onQueryFields={onQueryFields}
                />
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </TooltipQueryProvider>
  );
}
