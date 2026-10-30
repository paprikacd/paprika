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

export const WidgetVisualization = memo(function WidgetVisualization({
  widget,
  result,
  loading,
  deferred,
  error,
  onRetry,
  onContextChange,
}: WidgetVisualizationProps) {
  // Registered plugins may arrive after a host loads an optional bundle.
  useWidgetDefinitions();
  const definition = getWidgetDefinition(widget);
  const resetKey = useMemo(
    () => ({ widget, result, definition }),
    [widget, result, definition],
  );
  if (!definition)
    return (
      <div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Widget plugin unavailable</strong>
        <p>
          Install the trusted “{widget.pluginId}” plugin in this Paprika host.
        </p>
      </div>
    );
  if (error)
    return (
      <div className={`${styles.state} ${styles.error}`} role="alert">
        <strong>Query failed</strong>
        <p>{error}</p>
        {onRetry && <GammaButton size="sm" onClick={onRetry} aria-label={`Retry query for ${widget.title}`}>Retry</GammaButton>}
      </div>
    );
  if (deferred && !result)
    return (
      <div className={styles.state} role="status" aria-label="Widget waiting to load">
        <span>Waiting to load…</span>
      </div>
    );
  if (loading && !result)
    return (
      <div className={styles.state} role="status" aria-label="Loading widget">
        <span className={styles.loading} />
        <span>Querying data source…</span>
      </div>
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
    return <EmptyState partial={!!(result?.truncated || result?.records?.truncated)} />;
  return (
    <div
      className={`${styles.visualization} ${configStyles.visualization} ${textColor ? configStyles.customText : ""}`}
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
