"use client";

import {
  Component,
  memo,
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
import { GammaButton } from "./gamma/button";
import { WidgetInitialLoading, useWidgetLoadingPresentation } from "./widget-loading";
export {
  downsamplePoints,
  formatMetric,
  thresholdForValue,
  resolveChartDomain,
} from "./chart-renderers";

export interface WidgetVisualizationProps {
  widget: Widget;
  result?: QueryResult;
  loading?: boolean;
  naturalHeight?: boolean;
  deferred?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onContextChange?: (context: DrilldownContext) => void;
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
}: {
  widget: Widget;
  result: QueryResult;
  definition: WidgetDefinition;
  onContextChange?: (context: DrilldownContext) => void;
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
  return (
    <Renderer
      widget={config === widget.config ? widget : { ...widget, config }}
      result={result}
      embedded={embedded}
      onContextChange={embedded ? undefined : onContextChange}
    />
  );
}

// State renderers need the same measured container as populated charts.
function WidgetStateFrame({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <div className={`${styles.visualization}${busy ? ` ${styles.loadingFrame}` : ""}`} data-widget-state-frame="" aria-busy={busy || undefined}>{children}</div>;
}

export const WidgetVisualization = memo(function WidgetVisualization({
  widget,
  result,
  loading,
  naturalHeight = false,
  deferred,
  error,
  onRetry,
  onContextChange,
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
      <WidgetStateFrame><div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Widget plugin unavailable</strong>
        <p>
          Install the trusted “{widget.pluginId}” plugin in this Paprika host.
        </p>
      </div></WidgetStateFrame>
    );
  // A failed widget that reloads keeps its error in place and marks the frame busy, so the alert is not re-inserted on each refresh.
  if (error)
    return (
      <WidgetStateFrame busy={loading}><div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Query failed</strong>
        <p>{error}</p>
        {onRetry && <GammaButton size="sm" onClick={onRetry} aria-label={`Retry query for ${widget.title}`}>Retry</GammaButton>}
      </div></WidgetStateFrame>
    );
  if (deferred && !result)
    return (
      <WidgetStateFrame><div className={styles.state} role="status" aria-label="Widget waiting to load">
        <span>Waiting to load…</span>
      </div></WidgetStateFrame>
    );
  // The initial load alone shows placeholders. A refresh keeps the last result visible and never announces itself.
  if (loading && !result)
    return (
      <WidgetStateFrame busy>
        <WidgetInitialLoading widget={widget} />
      </WidgetStateFrame>
    );
  const series = result?.series ?? [];
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
    return <WidgetStateFrame><EmptyState partial={!!(result?.truncated || result?.records?.truncated)} /></WidgetStateFrame>;
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
      {(result?.truncated || result?.records?.truncated) && (
        <p className={styles.limitNotice} role="status">
          Provider response may be incomplete. Narrow the query or check the data source.
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
            />
          </TooltipWidgetDataProvider>
        </RendererBoundary>
      </div>
    </div>
  );
});
