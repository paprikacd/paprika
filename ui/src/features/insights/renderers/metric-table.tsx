import { NO_DATA, seriesShown } from "../benign-states";
import { ChartTable } from "../chart-table";
import { useState } from "react";
import { MetricDetails } from "../metric-tooltip-content";
import { formatMetricDetails, latestPoint, seriesName } from "../chart-data";
import { formatSharedScale } from "../units";
import { TooltipSubWidget } from "../tooltip-widgets";
import { ObservationDetails } from "../observation-tooltip";
import configStyles from "../chart-styles.module.css";
import styles from "../charts.module.css";
import contextStyles from "../widget-context.module.css";
import type { DrilldownContext } from "../drilldown";
import { useAppliedFilter } from "../selection-state";
import { metricContext, validTimestamp } from "../widget-context";
import type { Widget } from "../schema";
import { type Series } from "../chart-renderer-shared";
import { displaySeriesNames } from "../series-display";
import { MAX_ROWS } from "./shared";

export function MetricTable({
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
  const isApplied = useAppliedFilter();
  const [hoveredRow, setHoveredRow] = useState<{
    index: number;
    entry: Series;
    anchor: HTMLTableRowElement;
  }>();
  // Focus only sets the drilldown context. A row is the applied filter when the dashboard's variables hold its selection.
  const activate = onActivate ?? onContextChange;
  const focusRow = (entry: Series, index: number) => onContextChange?.(metricContext(entry, index));
  const activateRow = (entry: Series, index: number) => activate?.(metricContext(entry, index));
  // Each row's extremes, and one display scale per column, so a column compares in one unit ("1.03 s" beside "1.21 s").
  const tableRows = series.slice(0, MAX_ROWS).map(entry => {
    let min = Infinity;
    let max = -Infinity;
    for (const point of entry.points)
      if (typeof point.value === "number" && Number.isFinite(point.value) && validTimestamp(point.timestamp)) {
        min = Math.min(min, point.value);
        max = Math.max(max, point.value);
      }
    return { entry, latest: latestPoint(entry), min, max };
  });
  // One unit per column, chosen from its largest value; the authored decimals then apply to every scaled value.
  const columnLabels = (values: number[]) => formatSharedScale(values, widget.unit, { decimals: widget.options?.decimals });
  // Rows name themselves with the same compacted labels as the charts; the full identity stays in each row's title.
  const displayNames = displaySeriesNames(series.slice(0, MAX_ROWS));
  const latestLabels = columnLabels(tableRows.map(row => row.latest?.value ?? NaN));
  const minLabels = columnLabels(tableRows.map(row => row.min));
  const maxLabels = columnLabels(tableRows.map(row => row.max));
  return (
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} data table`}
    >
      <ChartTable className={styles.table} aria-label={widget.title}>
        <thead>
          <tr>
            <th scope="col">Series</th>
            <th scope="col" className={styles.numeric}>
              Latest valid
            </th>
            <th scope="col" className={styles.numeric}>
              Min
            </th>
            <th scope="col" className={styles.numeric}>
              Max
            </th>
          </tr>
        </thead>
        <tbody>
          {tableRows.map(({ entry, latest, min, max }, index) => {
            const name = displayNames[index];
            const fullName = seriesName(entry, index);
            return (
              <tr
                key={`${fullName}-${index}`}
                onPointerEnter={(event) => {
                  if (
                    event.pointerType !== "touch" &&
                    widget.options?.tooltipView &&
                    widget.options.showTooltip !== false
                  )
                    setHoveredRow({
                      index,
                      entry,
                      anchor: event.currentTarget,
                    });
                }}
                onPointerLeave={() => setHoveredRow(undefined)}
                tabIndex={onContextChange ? 0 : undefined}
                data-filter-active={
                  isApplied(metricContext(entry, index)) ? "" : undefined
                }
                aria-current={
                  isApplied(metricContext(entry, index)) ? "true" : undefined
                }
                className={
                  onContextChange ? contextStyles.interactiveRow : undefined
                }
                onFocus={() => onContextChange && focusRow(entry, index)}
                onClick={(event) => {
                  // The series name is its own button: its click activates through onSelect, so the row must not repeat it.
                  if (!activate || !event.currentTarget.contains(event.target as Node) || (event.target as Element).closest("button")) return;
                  activateRow(entry, index);
                }}
                onKeyDown={(event) => {
                  if (
                    activate &&
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    activateRow(entry, index);
                  }
                }}
              >
                <td>
                  <ObservationDetails
                    label={`Inspect series ${fullName}`}
                    enabled={widget.options?.showTooltip !== false}
                    onSelect={activate && widget.options?.showTooltip !== false ? () => activateRow(entry, index) : undefined}
                    selectOnFocus={false}
                    revision={entry}
                    externalAnchor={
                      hoveredRow?.index === index && hoveredRow.entry === entry
                        ? hoveredRow.anchor
                        : undefined
                    }
                    details={
                      <>
                        <MetricDetails widget={widget}
                          series={entry}
                          index={index}
                          point={latest}
                          unit={widget.unit}
                          decimals={widget.options?.decimals}
                        >
                          <span className={configStyles.tooltipRange}>
                            Minimum:{" "}
                            {Number.isFinite(min)
                              ? formatMetricDetails(min, widget.unit, widget.options?.decimals)
                              : NO_DATA}{" "}
                            · Maximum:{" "}
                            {Number.isFinite(max)
                              ? formatMetricDetails(max, widget.unit, widget.options?.decimals)
                              : NO_DATA}
                          </span>
                        </MetricDetails>
                        {widget.options?.tooltipView && (
                          <TooltipSubWidget
                            view={widget.options.tooltipView}
                            series={entry}
                            seriesIndex={index}
                            point={latest}
                            unit={widget.unit}
                            color={widget.color}
                          />
                        )}
                      </>
                    }
                  >
                    <span title={fullName}>{name}</span>
                  </ObservationDetails>
                </td>
                <td className={styles.numeric}>
                  {latestLabels[index]}
                </td>
                <td className={styles.numeric}>
                  {minLabels[index]}
                </td>
                <td className={styles.numeric}>
                  {maxLabels[index]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </ChartTable>
      {series.length > MAX_ROWS && (
        <p className={styles.notice}>
          {seriesShown(MAX_ROWS, series.length)}. Narrow the query to see
          others.
        </p>
      )}
    </div>
  );
}
