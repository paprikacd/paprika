"use client";

// The bar renderer. chart-renderers.tsx re-exports it, so existing importers are unchanged.
import { useCallback, useId, useMemo } from "react";
import { barY } from "@tanstack/charts/bar";
import { focusNearestX } from "@tanstack/charts/focus";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { defineChart } from "@tanstack/charts/scene";
import { tooltip } from "@tanstack/charts/tooltip";
import { dateTimeFormat, formatMetric, formatMetricDetails, latestPoint, seriesName } from "./chart-data";
import { useChartEntrance } from "./chart-entrance";
import chartEntrance from "./chart-entrance.module.css";
import { ChartDataInspector } from "./chart-data-inspector";
import {
  EMPTY_OPTIONS,
  MAX_SERIES,
  PALETTE,
  chartYAxisLayout,
  configuredTheme,
  resolveChartDomain,
  responsiveChartTicks,
  themedPortal,
  thresholdForValue,
  usePlotSize,
  type Series,
} from "./chart-renderer-shared";
import styles from "./charts.module.css";
import { PlotHatchSvg, plotHatchFill } from "./plot-hatch";
import hatchStyles from "./plot-hatch.module.css";
import { usePlotTooltip } from "./plot-tooltip";
import type { Widget } from "./schema";
import { thresholdPaint } from "./status";
import { compactSeriesLabels } from "./series-display";
import { useWidgetPresentation } from "./widget-presentation";

/** One row per displayed series. A series with no valid sample keeps its row (`noData`), so TanStack reserves its band. */
type BarRow = {
  name: string;
  displayName: string;
  seriesIndex: number;
  label: string;
} & (
  | { noData: false; value: number; timestamp: number; color: string }
  // A plot datum needs a numeric timestamp. NaN is never read: TanStack emits no point for a no-data row.
  | { noData: true; value: null; timestamp: number; color: undefined }
);
const BAR_NO_AXIS_MARGIN = 8;

/** TanStack's default bar domain: zero-inclusive over the finite values, then niced to `count` ticks. */
function barDomain(values: readonly number[], count: number): [number, number] {
  let minimum = 0;
  let maximum = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return scaleLinear().domain(minimum === maximum ? [0, 1] : [minimum, maximum]).nice(count).domain();
}

/** The count TanStack nices the y scale to (`resolveTickCount` in @tanstack/charts): the axis tick count, or
 * without an axis the default 48px spacing over the plot, clamped to 2 to 7 ticks. */
function barNiceCount(showAxis: boolean, axisTicks: number, height: number) {
  return showAxis ? axisTicks : Math.max(2, Math.min(7, Math.floor((height - 2 * BAR_NO_AXIS_MARGIN) / 48)));
}

export function BarChart({ widget, series }: { widget: Widget; series: Series[] }) {
  const { ref, width, height } = usePlotSize();
  const { embedded, showAxis, descriptionId } = useWidgetPresentation();
  const entering = useChartEntrance({ disabled: embedded, anchor: ref });
  const hatch = useId();
  const emptyNoticeId = `${hatch}-empty`;
  const ticks = responsiveChartTicks(width, height);
  const options = widget.options ?? EMPTY_OPTIONS;
  const tooltipEnabled =
    !embedded && options.showTooltip !== false;
  const plotTooltip = usePlotTooltip(widget, series, tooltipEnabled);
  const displayLabels = useMemo(() => compactSeriesLabels(series.slice(0, MAX_SERIES)), [series]);
  const rows = useMemo(
    () =>
      series.slice(0, MAX_SERIES).map((entry, index): BarRow => {
        const base = {
          name: seriesName(entry, index),
          displayName: displayLabels[index],
          seriesIndex: index,
          label: String(index + 1),
        };
        const point = latestPoint(entry);
        if (!point)
          return { ...base, noData: true, value: null, timestamp: Number.NaN, color: undefined };
        return {
          ...base,
          noData: false,
          value: point.value,
          timestamp: point.timestamp,
          color:
            thresholdPaint(thresholdForValue(point.value, options.thresholds)) ??
            (index === 0 && widget.color
              ? widget.color
              : PALETTE[index % PALETTE.length]),
        };
      }),
    [series, widget.color, options.thresholds, displayLabels],
  );
  const noDataRows = useMemo(() => rows.filter((row) => row.noData), [rows]);
  const values = useMemo(() => rows.flatMap((row) => (row.noData ? [] : [row.value])), [rows]);
  const domain = useMemo(
    () =>
      resolveChartDomain(
        rows.map((row) => ({
          name: row.name,
          labels: {},
          points: row.noData ? [] : [{ timestamp: row.timestamp, value: row.value }],
        })),
        options,
      ),
    [rows, options],
  );
  // The chart draws exactly the domain and ticks its labels were computed for, so each gridline shows its own value.
  const baseDomain = useMemo<[number, number]>(
    () => domain ?? barDomain(values, barNiceCount(showAxis, ticks.y, height)),
    [domain, values, showAxis, ticks.y, height],
  );
  const yAxis = useMemo(
    () => chartYAxisLayout(values, widget.unit, options.decimals, options.yAxisLabel, options.axisUnit, baseDomain, ticks.y),
    [values, widget.unit, options.decimals, options.yAxisLabel, options.axisUnit, baseDomain, ticks.y],
  );
  const { left: axisLeft, separateUnit, scale: yScale } = yAxis;
  const yDomain = yScale.domain;
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(rows, {
            x: "label",
            y: "value",
            fill: (row) => (row.noData ? "none" : row.color),
            maxThickness: 42,
            radius: 3,
            inset: 3,
          }),
          // Decorative: it takes no focus or tooltip. The explicit y domain keeps its ends from changing the scale.
          ...(yDomain && noDataRows.length
            ? [
                decorative(
                  barY(noDataRows, {
                    id: "no-data",
                    x: "label",
                    y1: yDomain[0],
                    y2: yDomain[1],
                    fill: plotHatchFill(hatch),
                    maxThickness: 42,
                    radius: 3,
                    inset: 3,
                  }),
                ),
              ]
            : []),
        ],
        scales: {
          x: {
            scale: scaleBand,
            axis: !showAxis
              ? false
              : {
                  label: options.xAxisLabel
                    ? { text: options.xAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    line: false,
                    format: (value: string) => {
                      const name =
                        rows.find((row) => row.label === value)?.displayName || value;
                      const characters = Math.max(
                        4,
                        Math.min(
                          16,
                          Math.floor(
                            (width - 70) / Math.max(1, rows.length) / 6,
                          ),
                        ),
                      );
                      return name.length > characters
                        ? `${name.slice(0, characters - 1)}…`
                        : name;
                    },
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 11,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
          y: {
            scale: scaleLinear().domain(yDomain),
            nice: false,
            grid:
              options.showGrid === false
                ? false
                : {
                    stroke: "var(--gamma-chart-grid, var(--gamma-border, #e4ebed))",
                  },
            axis: !showAxis
              ? false
              : {
                  label: options.yAxisLabel
                    ? { text: options.yAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    values: yScale.ticks,
                    line: false,
                    format: (value: number) =>
                      yScale.label(value, !separateUnit),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 11,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
        },
        margin: !showAxis
          ? { top: BAR_NO_AXIS_MARGIN, right: BAR_NO_AXIS_MARGIN, bottom: BAR_NO_AXIS_MARGIN, left: BAR_NO_AXIS_MARGIN }
          : {
              top: separateUnit ? 18 : height < 130 ? 4 : 12,
              right: 10,
              bottom: options.xAxisLabel ? 47 : 28,
              left: axisLeft,
            },
        clip: true,
        theme: configuredTheme(options),
        svgAnimation: false,
        focus: embedded ? false : tooltipEnabled ? focusNearestX : undefined,
        tooltip:
          options.showTooltip === false
            ? false
            : tooltipEnabled
              ? { use: plotTooltip.extension, sticky: true }
              : {
                  use: tooltip,
                  portal: themedPortal,
                  sticky: true,
                  className: styles.tooltip,
                  format: (point) =>
                    point.datum.noData
                      ? ""
                      : `${point.datum.name}\nLatest valid sample · ${dateTimeFormat.format(new Date(point.datum.timestamp))}\n${formatMetricDetails(point.datum.value, widget.unit, options.decimals)}`,
                },
      }),
    [
      rows,
      noDataRows,
      yDomain,
      hatch,
      widget.unit,
      axisLeft,
      separateUnit,
      yScale,
      options,
      width,
      height,
      showAxis,
      embedded,
      tooltipEnabled,
      plotTooltip.extension,
    ],
  );
  const noDataSentence =
    noDataRows.length === 1
      ? "1 series has no valid sample in this range."
      : noDataRows.length
        ? `${noDataRows.length} series have no valid sample in this range.`
        : "";
  const accessibleDescription = [
    embedded
      ? "Latest valid value for each series."
      : "Latest value for each series. Use arrow keys to explore values.",
    noDataSentence,
  ]
    .filter(Boolean)
    .join(" ");
  // An embedded chart is described by its sub-widget's text, so the notice gets a hidden node of its own.
  const associateDescription = useCallback(
    ({ svg }: { svg: SVGSVGElement }) => {
      const described = [descriptionId, noDataRows.length ? emptyNoticeId : ""].filter(Boolean).join(" ");
      if (described) svg.setAttribute("aria-describedby", described);
    },
    [descriptionId, emptyNoticeId, noDataRows.length],
  );
  return (
    <div className={styles.chart}>
      <div
        className={`${styles.plot} ${chartEntrance.tanstackPlot}`}
        ref={ref}
        data-chart-entering={entering || undefined}
        onPointerMoveCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onPointerDownCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onKeyDownCapture={tooltipEnabled ? plotTooltip.onInteract : undefined}
        onFocusCapture={tooltipEnabled ? plotTooltip.onFocus : undefined}
        onBlurCapture={tooltipEnabled ? plotTooltip.onBlur : undefined}
      >
        {showAxis && separateUnit && <span className={styles.axisUnit} title={yScale.unit} data-chart-axis-unit>{yScale.unit}</span>}
        <Chart
          definition={definition}
          height={height}
          width={width}
          style={{ width: "100%", maxWidth: "100%" }}
          ariaLabel={widget.title}
          tabIndex={embedded ? -1 : undefined}
          onRender={embedded ? associateDescription : plotTooltip.onRender}
          onFocusChange={tooltipEnabled ? plotTooltip.onFocusChange : undefined}
          onSelect={tooltipEnabled ? plotTooltip.onSelect : undefined}
          ariaDescription={accessibleDescription}
        />
        {noDataRows.length > 0 && <PlotHatchSvg id={hatch} />}
        {embedded && noDataRows.length > 0 && <span id={emptyNoticeId} className={styles.srOnly}>{noDataSentence}</span>}
      </div>
      {(options.showLegend !== false || !embedded) && <div className={styles.chartFooter} data-chart-footer>
      {options.showLegend !== false && (
        <div className={`${styles.legend} ${styles.barLegend}`} role="list" aria-label="Latest values by category" tabIndex={0}>
          {rows.map((row) => {
            const name = row.displayName === row.name ? row.name : <><span aria-hidden="true">{row.displayName}</span><span className={styles.srOnly}>{row.name}</span></>;
            return row.noData ? (
              <span className={styles.legendItem} role="listitem" key={row.seriesIndex} title={row.name} data-no-data-series={row.name}>
                <span className={`${hatchStyles.hatch} ${hatchStyles.swatch} ${styles.noDataKey}`} aria-hidden="true" />
                <span className={styles.legendName}>{name}</span>
                <span className={`${styles.legendValue} ${styles.noDataValue}`}>No data</span>
              </span>
            ) : (
              <span className={styles.legendItem} role="listitem" key={row.seriesIndex} title={row.name}>
                <span className={styles.swatch} aria-hidden="true" style={{ background: row.color }} />
                <span className={styles.legendName}>{name}</span>
                <span className={styles.legendValue} aria-label={`${row.name}, latest valid sample: ${formatMetricDetails(row.value, widget.unit, options.decimals)} at ${new Date(row.timestamp).toISOString()}`} data-legend-value={row.value} data-legend-timestamp={row.timestamp}>{formatMetric(row.value, widget.unit, false, options.decimals)}</span>
              </span>
            );
          })}
        </div>
      )}
      {!embedded && <ChartDataInspector widget={widget} series={series} />}
      </div>}
      {plotTooltip.panel}
      {series.length > MAX_SERIES && (
        <span className={styles.notice} role="status">
          First {MAX_SERIES} of {series.length} series
        </span>
      )}
    </div>
  );
}
