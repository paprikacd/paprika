"use client";

import { NO_DATA, seriesShown } from "./benign-states";
import { useObservationOwner } from "./observation-owner";
import { useId, useMemo, useState, type KeyboardEvent, type CSSProperties } from "react";
import { MetricDetails } from "./metric-tooltip-content";
import { isRestoringTooltipFocus } from "./tooltip-focus";
export { MetricDetails } from "./metric-tooltip-content";
import { formatMetric, seriesName } from "./chart-data";
import { formatBounds } from "./units";
import { heatmapValueEm, heatmapValueGlyphs, useHeatmapValueFit } from "./heatmap-value-width";
export {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  exactMetric,
  formatTimeTick,
} from "./chart-data";
import { TooltipSubWidget } from "./tooltip-widgets";
import { useEmbeddedWidget } from "./widget-presentation";
import { ObservationTooltip } from "./observation-tooltip";
export { ObservationTooltip, ObservationDetails, heatmapTooltipSizeLimit, placeHeatmapTooltip, placePlotTooltip, placeOutsideWidgetTooltip, placeClearOutsideWidgetTooltip, outsideTooltipWidthLimit, tooltipOverlapsOtherWidget } from "./observation-tooltip";
import configStyles from "./chart-styles.module.css";
import styles from "./charts.module.css";
import type { DrilldownContext } from "./drilldown";
import { useAppliedFilter } from "./selection-state";
import { readableTextColor } from "./appearance";
import { contextKey, metricContext, validTimestamp } from "./widget-context";
import type { QueryResult, Threshold, Widget } from "./schema";
import { EMPTY_OPTIONS, thresholdForValue, usePlotSize, type Point, type Series } from "./chart-renderer-shared";
import { thresholdInk, thresholdPaint } from "./status";
import { StatusChip } from "./status-chip";
import { TimeSeriesChart } from "./time-series-chart";
import { BarChart } from "./bar-chart";
import { displaySeriesNames } from "./series-display";
import { MAX_ROWS, critical, criticalStroke } from "./renderers/shared";
import { EmptyState } from "./renderers/empty-state";
import { Stat } from "./renderers/stat";
import { MetricTable } from "./renderers/metric-table";
import { TraceList } from "./renderers/trace-list";
export { TimeSeriesChart, resolveTimeSeriesDomain } from "./time-series-chart";
export { BarChart } from "./bar-chart";
export { ChartDataInspector } from "./chart-data-inspector";
export {
  thresholdForValue,
  resolveChartDomain,
  responsiveChartTicks,
  chartYAxisLayout,
} from "./chart-renderer-shared";


/** The value text a heatmap cell shows. Its width (heatmapValueEm) sizes the value so a long unit or number stays inside its cell. */
function heatmapValueText(value: number | undefined, unit: Widget["unit"], decimals: number | undefined): string {
  return value === undefined ? NO_DATA : formatMetric(value, unit, false, decimals);
}

export const DEFAULT_HEATMAP_THRESHOLDS: Threshold[] = [
  { value: 0, status: "critical", label: "Unhealthy" },
  { value: 1, status: "ok", label: "Healthy" },
];

export { EmptyState } from "./renderers/empty-state";
export function balancedHeatmapColumns(
  count: number,
  width: number,
  hasText = true,
) {
  const gap = width <= 340 ? 4 : 6;
  const minimum = hasText ? 120 : width <= 340 ? 48 : 64;
  const maximum = Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  const cells = Math.max(1, Math.min(MAX_ROWS, count));
  return Math.ceil(cells / Math.ceil(cells / maximum));
}

function thresholdRange(
  thresholds: readonly Threshold[],
  index: number,
  unit: string,
  decimals?: number,
) {
  if (thresholds.length === 1) return "All values";
  const axis = thresholds.map(threshold => threshold.value);
  if (index === 0) return `Below ${formatBounds([thresholds[1].value], unit, decimals, axis)[0]}`;
  const next = thresholds[index + 1];
  if (!next) return `≥ ${formatBounds([thresholds[index].value], unit, decimals, axis)[0]}`;
  const [from, to] = formatBounds([thresholds[index].value, next.value], unit, decimals, axis);
  return `≥ ${from} and < ${to}`;
}

export function Heatmap({
  widget,
  series,
  onContextChange,
  onActivate,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  const isApplied = useAppliedFilter();
  const { ref: cellsRef, width: cellsWidth } = usePlotSize();
  const tooltipId = useId();
  // One tab stop for the grid: the focused cell keeps it, and the arrow keys move it, as status-grid does.
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const options = widget.options ?? EMPTY_OPTIONS;
  const thresholds = options.thresholds?.length
    ? options.thresholds
    : DEFAULT_HEATMAP_THRESHOLDS;
  const cells = useMemo(
    () =>
      series.slice(0, MAX_ROWS).map((entry, index) => {
        // A missing latest scrape is unknown, even if an older sample was healthy.
        const point = entry.points.reduce<Point | undefined>(
          (latest, current) =>
            validTimestamp(current.timestamp) &&
            (!latest || current.timestamp >= latest.timestamp)
              ? current
              : latest,
          undefined,
        );
        const value =
          typeof point?.value === "number" && Number.isFinite(point.value)
            ? point.value
            : undefined;
        return {
          name: seriesName(entry, index),
          key: contextKey(metricContext(entry, index, true)),
          source: entry,
          labels: entry.labels,
          point,
          value,
        };
      }),
    [series],
  );
  // Cells are kept by position and key: a reordered series closes its pinned panel, as before.
  const cellKeys = useMemo(() => cells.map((cell, index) => `${index}\u0000${cell.key}`), [cells]);
  const owner = useObservationOwner({
    enabled: options.showTooltip !== false && !embedded,
    retention: { keys: cellKeys },
  });
  const active = owner.active ? { ...owner.active, index: cellKeys.indexOf(owner.active.key) } : undefined;
  const selected = active ? cells[active.index] : undefined;
  const selectedThreshold =
    selected?.value === undefined
      ? undefined
      : thresholdForValue(selected.value, thresholds);
  // Short names for the heading; the full identity stays in Source details.
  const heatmapSubjects = useMemo(() => displaySeriesNames(series.slice(0, MAX_ROWS)), [series]);
  const hasText = options.showLabels !== false || options.showValues !== false;
  // One value text per cell feeds the visible text, its width and both accessible names, so they cannot drift apart.
  const valueTexts = cells.map((cell) => heatmapValueText(cell.value, widget.unit, options.decimals));
  // The fit re-runs when the column count changes: the cells re-render after the ResizeObserver has already measured the old layout.
  const columns = balancedHeatmapColumns(cells.length, cellsWidth, hasText);
  const tabIndex = Math.min(keyboardIndex, cells.length - 1);
  const navigateCells = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowUp") next -= columns;
    else if (event.key === "ArrowDown") next += columns;
    // Home and End stay with the open preview, which scrolls on them (Page Up/Down and Home/End are its documented keys).
    else return;
    event.preventDefault();
    next = Math.max(0, Math.min(cells.length - 1, next));
    setKeyboardIndex(next);
    cellsRef.current?.querySelectorAll<HTMLElement>("[data-heatmap-cell]")[next]?.focus();
  };
  useHeatmapValueFit(cellsRef, [columns, options.showValues !== false, ...valueTexts].join("\u0000"));
  return (
    <div className={configStyles.heatmap}>
      <div
        ref={cellsRef}
        className={`${configStyles.cells} ${hasText ? "" : configStyles.colorOnlyCells}`}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
        role="group"
        aria-label={`${widget.title} heatmap`}
      >
        {cells.map((cell, index) => {
          const threshold =
            cell.value === undefined
              ? undefined
              : thresholdForValue(cell.value, thresholds);
          const valueText = valueTexts[index];
          const valueStyle = { "--value-em": heatmapValueEm(valueText), "--value-glyphs": heatmapValueGlyphs(valueText) } as CSSProperties;
          const label = `${heatmapSubjects[index] ?? cell.name}: ${valueText}${threshold?.label ? ` · ${threshold.label}` : ""}`;
          const trigger = owner.trigger(cellKeys[index]);
          if (embedded)
            return (
              <div
                key={`${cell.name}-${index}`}
                role="img"
                aria-label={label}
                className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
                data-heatmap-cell=""
                data-status-stroke={critical(threshold)}
                style={{
                  background: thresholdPaint(threshold) ?? "#e6e9e0",
                  color:
                    options.textColor ??
                    (thresholdInk(threshold) ?? "#69725f"),
                  ...criticalStroke(threshold),
                }}
              >
                {options.showLabels !== false && (
                  <span className={configStyles.cellName}>{cell.name}</span>
                )}
                {options.showValues !== false && (
                  <strong data-heatmap-value="" style={valueStyle}>{valueText}</strong>
                )}
              </div>
            );
          return (
            <button
              key={`${cell.name}-${index}`}
              type="button"
              className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
              data-heatmap-cell=""
              data-status-stroke={critical(threshold)}
              style={{
                background: thresholdPaint(threshold) ?? "#e6e9e0",
                color:
                  options.textColor ??
                  (thresholdInk(threshold) ?? "#69725f"),
                ...criticalStroke(threshold),
              }}
              aria-label={label}
              data-filter-active={isApplied({ series: cell.name, labels: cell.labels, value: cell.value ?? null }) ? "" : undefined}
              aria-current={isApplied({ series: cell.name, labels: cell.labels, value: cell.value ?? null }) ? "true" : undefined}
              tabIndex={index === tabIndex ? 0 : -1}
              onKeyDown={(event) => navigateCells(event, index)}
              aria-describedby={
                active?.index === index && options.showTooltip !== false
                  ? tooltipId
                  : undefined
              }
              aria-pressed={
                options.showTooltip !== false
                  ? active?.index === index && active.pinned
                  : undefined
              }
              onPointerEnter={trigger.onPointerEnter}
              onPointerLeave={trigger.onPointerLeave}
              onFocus={(event) => {
                // Focus, including arrow-key movement, only sets the drilldown context.
                setKeyboardIndex(index);
                onContextChange?.({
                  series: cell.name,
                  labels: cell.labels,
                  value: cell.value ?? null,
                });
                // Returning focus to a cell after Escape must not reopen the preview it just closed; it still holds the focus.
                if (isRestoringTooltipFocus()) owner.holdFocus(event.currentTarget);
                else trigger.onFocus(event);
              }}
              onBlur={trigger.onBlur}
              onClick={(event) => {
                // A click, or Enter and Space which the browser turns into one, activates the cell and pins its panel.
                (onActivate ?? onContextChange)?.({
                  series: cell.name,
                  labels: cell.labels,
                  value: cell.value ?? null,
                });
                if (options.showTooltip === false) return;
                trigger.onClick(event);
              }}
            >
              {options.showLabels !== false && (
                <span className={configStyles.cellName}>{cell.name}</span>
              )}
              {options.showValues !== false && (
                <strong data-heatmap-value="" style={valueStyle}>{valueText}</strong>
              )}
            </button>
          );
        })}
      </div>
      {!embedded && selected && active && options.showTooltip !== false && (
        <ObservationTooltip
          id={tooltipId}
          anchor={active.anchor}
          avoidWidget
          pinned={active.pinned}
          onDismiss={owner.dismiss}
          onEnter={owner.panelEnter}
          onLeave={owner.panelLeave}
        >
          <MetricDetails
            widget={widget}
            series={selected.source}
            index={active.index}
            point={selected.point}
            unit={widget.unit}
            decimals={options.decimals}
            subject={heatmapSubjects[active.index]}
            seriesLabel={widget.title}
            description="Latest sample"
          >
            {selectedThreshold?.status ? (
              <StatusChip
                status={selectedThreshold.status}
                color={selectedThreshold.color}
                label={selectedThreshold.label ?? "Threshold matched"}
              />
            ) : (
              <span className={configStyles.tooltipStatus}>
                <i
                  style={{ background: thresholdPaint(selectedThreshold) ?? "#a5ad9b" }}
                />
                {selectedThreshold?.label ??
                  (selectedThreshold ? "Threshold matched" : "Unknown")}
              </span>
            )}
            <span className={configStyles.tooltipRange}>
              {selectedThreshold
                ? thresholdRange(
                    thresholds,
                    thresholds.indexOf(selectedThreshold),
                    widget.unit,
                    options.decimals,
                  )
                : "The latest sample has no finite value"}
            </span>
          </MetricDetails>
          {options.tooltipView && (
            <TooltipSubWidget
              view={options.tooltipView}
              series={selected.source}
              seriesIndex={active.index}
              point={selected.point}
              unit={widget.unit}
              color={widget.color}
            />
          )}
        </ObservationTooltip>
      )}
      {options.showLegend !== false && (
        <div
          className={configStyles.thresholdLegend}
          aria-label="Heatmap thresholds"
        >
          {thresholds.map((threshold, index) => (
            <span key={threshold.value}>
              <i style={{ background: thresholdPaint(threshold) }} />
              <span>
                {threshold.label ||
                  formatMetric(
                    threshold.value,
                    widget.unit,
                    false,
                    options.decimals,
                  )}
                <small>{thresholdRange(thresholds, index, widget.unit, options.decimals)}</small>
              </span>
            </span>
          ))}
        </div>
      )}
      {series.length > MAX_ROWS && (
        <span className={styles.notice}>
          {seriesShown(MAX_ROWS, series.length)}. Narrow the query to see
          others.
        </span>
      )}
    </div>
  );
}

export function contrastText(hex: string) {
  return readableTextColor(hex);
}

export function BuiltinWidgetRenderer({
  widget,
  result,
  onContextChange,
  onActivate,
}: {
  widget: Widget;
  result: QueryResult;
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}) {
  const series = result.series ?? [];
  switch (widget.type) {
    case "timeseries":
      return <TimeSeriesChart widget={widget} series={series} onContextChange={onContextChange} onActivate={onActivate} />;
    case "bar":
      return <BarChart widget={widget} series={series} onContextChange={onContextChange} onActivate={onActivate} />;
    case "stat":
      return (
        <Stat
          widget={widget}
          series={series}
          result={result}
          onContextChange={onContextChange}
        />
      );
    case "table":
      return (
        <MetricTable
          widget={widget}
          series={series}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    case "traces":
      return (
        <TraceList
          widget={widget}
          traces={result.traces ?? []}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    case "heatmap":
      return (
        <Heatmap
          widget={widget}
          series={series}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    default:
      return <EmptyState />;
  }
}
