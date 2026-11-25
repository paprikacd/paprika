"use client";

import {
  Component,
  memo,
  Suspense,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  widgetKind,
  pluginConfigSchema,
  type QueryResult,
  type Widget,
} from "./schema";
import { EmptyState, latestPoint } from "./chart-renderers";
import {
  getWidgetDefinition,
  useWidgetDefinitions,
  type WidgetDefinition,
} from "./widget-registry";
import styles from "./charts.module.css";
import configStyles from "./chart-styles.module.css";
import type { DrilldownContext } from "./drilldown";
import { widgetTextColor } from "./appearance";
import { useEmbeddedWidget } from "./widget-presentation";
import { TooltipWidgetDataProvider } from "./tooltip-widget-data";
import { limitFact, sourceNotice, truncationOf } from "./truncation";
import { GammaButton } from "./gamma/button";
import { WidgetInitialLoading, useWidgetLoadingPresentation } from "./widget-loading";
export {
  downsamplePoints,
  formatMetric,
  thresholdForValue,
  resolveChartDomain,
} from "./chart-renderers";

// Failures whose source is named in the frame, so the author can tell which connection to check.
const SOURCE_FAILURES = new Set(["invalid_query", "forbidden", "provider_error", "provider_not_found"]);
// Failures an author can correct in the query editor. Access and capacity failures are not query faults.
const EDITABLE_FAILURES = new Set(["invalid_query", "provider_error"]);

export interface WidgetVisualizationProps {
  widget: Widget;
  result?: QueryResult;
  loading?: boolean;
  naturalHeight?: boolean;
  deferred?: boolean;
  error?: string | null;
  /** The machine code of a failed query, such as invalid_query; it names the failure's class in the frame. */
  errorCode?: string;
  /** The data source's display name, shown on an actionable connection failure. */
  providerName?: string;
  /** Opens the widget's query for editing. Offered only in edit mode, for a failure the author can correct. */
  onEditQuery?: () => void;
  /**
   * The tile needs a shared source that is not loaded yet. "pending" is busy
   * (aria-busy) so the render worker and tests wait for it; the others are final.
   */
  sourceState?: { status: "pending" | "unavailable" | "signin"; label: string };
  onRetry?: () => void;
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}

class RendererBoundary extends Component<
  { children: ReactNode; resetKey: unknown },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidUpdate(
    previous: Readonly<{ children: ReactNode; resetKey: unknown }>,
  ) {
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: false });
  }
  render() {
    return this.state.error ? (
      <div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Widget could not render</strong>
        <p>Check the widget configuration or update its installed plugin.</p>
      </div>
    ) : (
      this.props.children
    );
  }
}

function RegisteredRenderer({
  widget,
  result,
  definition,
  onContextChange,
  onActivate,
}: {
  widget: Widget;
  result: QueryResult;
  definition: WidgetDefinition;
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  if (widgetKind(widget) !== definition.dataKind)
    throw new Error("Widget data kind does not match its registered renderer");
  const config = useMemo(
    () =>
      definition.parseConfig
        ? pluginConfigSchema.parse(definition.parseConfig(widget.config) ?? {})
        : widget.config,
    [definition, widget.config],
  );
  const Renderer = definition.render;
  // Plugin renderers may load on first use; the tile's busy frame holds the same size while they load.
  return (
    <Suspense fallback={<WidgetStateFrame busy>{null}</WidgetStateFrame>}>
      <Renderer
        widget={config === widget.config ? widget : { ...widget, config }}
        result={result}
        embedded={embedded}
        onContextChange={embedded ? undefined : onContextChange}
        onActivate={embedded ? undefined : onActivate}
      />
    </Suspense>
  );
}

// State renderers need the same measured container as populated charts.
/** `natural`: the tile's height follows its content (a phone-stacked stat), so the state sizes itself rather than the tile. */
function WidgetStateFrame({ children, busy = false, natural = false }: { children: ReactNode; busy?: boolean; natural?: boolean }) {
  return <div className={`${styles.visualization}${natural ? ` ${styles.intrinsicStat}` : ""}${busy ? ` ${styles.loadingFrame}` : ""}`} data-widget-state-frame="" aria-busy={busy || undefined}>{children}</div>;
}

export const WidgetVisualization = memo(function WidgetVisualization({
  widget,
  result,
  loading,
  naturalHeight = false,
  deferred,
  error,
  sourceState,
  onRetry,
  errorCode,
  providerName,
  onEditQuery,
  onContextChange,
  onActivate,
}: WidgetVisualizationProps) {
  // Registered plugins may arrive after a host loads an optional bundle.
  useWidgetDefinitions();
  const loadingPresentation = useWidgetLoadingPresentation();
  const definition = getWidgetDefinition(widget);
  const resetKey = useMemo(
    () => ({ widget, result, definition }),
    [widget, result, definition],
  );
  if (!definition)
    return (
      <WidgetStateFrame natural={naturalHeight}><div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Widget plugin unavailable</strong>
        <p>
          Install the trusted “{widget.pluginId}” plugin in this Paprika host.
        </p>
      </div></WidgetStateFrame>
    );
  // A failed widget that reloads keeps its error in place and marks the frame busy, so the alert is not re-inserted on each refresh.
  if (error)
    return (
      <WidgetStateFrame natural={naturalHeight} busy={loading}><div className={`${styles.state} ${styles.error}`} role="alert" data-query-failure={errorCode}>
        <strong>Query failed</strong>
        <p title={error}>{error}</p>
        {providerName && errorCode && SOURCE_FAILURES.has(errorCode) && <p className={styles.limitFact}>Source: {providerName}</p>}
        {onRetry && <GammaButton size="sm" onClick={onRetry} aria-label={`Retry query for ${widget.title}`}>Retry</GammaButton>}
        {onEditQuery && errorCode && EDITABLE_FAILURES.has(errorCode) && <GammaButton size="sm" onClick={onEditQuery} aria-label={`Edit query for ${widget.title}`}>Edit query</GammaButton>}
      </div></WidgetStateFrame>
    );
  if (sourceState && !result) {
    const pending = sourceState.status === "pending";
    return (
      <WidgetStateFrame natural={naturalHeight} busy={pending}>
        <div className={styles.state} data-widget-state={pending ? "waiting-for-sources" : "source-unavailable"} aria-busy={pending || undefined}>
          <span>{sourceState.label}</span>
        </div>
      </WidgetStateFrame>
    );
  }
  if (deferred && !result)
    return (
      <WidgetStateFrame natural={naturalHeight}><div className={styles.state} role="status" aria-label="Widget waiting to load">
        <span>Waiting to load…</span>
      </div></WidgetStateFrame>
    );
  // The initial load alone shows placeholders. A refresh keeps the last result visible and never announces itself.
  if (loading && !result)
    return (
      <WidgetStateFrame natural={naturalHeight} busy>
        <WidgetInitialLoading widget={widget} />
      </WidgetStateFrame>
    );
  const series = result?.series ?? [];
  const truncation = truncationOf(result);
  const textColor = widgetTextColor(widget.options);
  if (
    !result ||
    (widget.type !== "plugin" &&
      (widgetKind(widget) === "traces"
        ? !result?.traces?.length
        : widget.type === "heatmap" || widget.type === "table"
          ? !series.length
          : !series.some((entry) => latestPoint(entry))))
  )
    return <WidgetStateFrame natural={naturalHeight}><EmptyState partial={!!(result?.truncated || result?.records?.truncated)} /></WidgetStateFrame>;
  return (
    <div
      className={`${styles.visualization} ${naturalHeight ? styles.intrinsicStat : ""} ${configStyles.visualization} ${textColor ? configStyles.customText : ""} ${loading && loadingPresentation ? styles.refreshHost : ""}`}
      style={
        {
          background: widget.options?.background,
          color: textColor,
          "--widget-text": textColor,
          "--widget-background": widget.options?.background,
        } as CSSProperties
      }
      aria-busy={!!loading}
    >
      {loading && loadingPresentation && <div className={styles.refreshNotice}>{loadingPresentation({ widget, phase: "refresh" })}</div>}
      {/* A single value shows a partial response as a chip beside its reading, so a block notice never pushes the reading out. */}
      {/* A row cap is a neutral fact. Plugins print their own neutral footers for it, so the host adds none for them. */}
      {widget.type !== "stat" && truncation === "limit" && widget.type !== "plugin" && (
        <p className={styles.limitFact} data-truncation="limit">{limitFact(result)}</p>
      )}
      {widget.type !== "stat" && (truncation === "partial" || truncation === "warning" || truncation === "unknown") && (
        <p className={styles.limitNotice} role="status" data-truncation={truncation}>
          {sourceNotice(truncation)}
        </p>
      )}
      <div className={styles.visualizationContent}>
        <RendererBoundary
          key={`${definition.id}:${widget.id}`}
          resetKey={resetKey}
        >
          <TooltipWidgetDataProvider result={result} kind={widgetKind(widget)}>
            <RegisteredRenderer
              widget={widget}
              result={result}
              definition={definition}
              onContextChange={onContextChange}
              onActivate={onActivate}
            />
          </TooltipWidgetDataProvider>
        </RendererBoundary>
      </div>
    </div>
  );
});
