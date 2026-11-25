import { NO_DATA } from "../benign-states";
import { ChartTable } from "../chart-table";
import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { useTraceFetcher } from "../trace-waterfall";
import { TraceDialog } from "../trace-dialog";
import { formatMetric, formatMetricDetails, fullDateTimeFormat, timeFormat } from "../chart-data";
import { useEmbeddedWidget } from "../widget-presentation";
import { ObservationDetails } from "../observation-tooltip";
import configStyles from "../chart-styles.module.css";
import styles from "../charts.module.css";
import contextStyles from "../widget-context.module.css";
import type { DrilldownContext } from "../drilldown";
import { useAppliedFilter } from "../selection-state";
import { traceContext, validTimestamp } from "../widget-context";
import type { Widget } from "../schema";
import { Trace, MAX_ROWS, statusReported } from "./shared";

export function TraceList({
  widget,
  traces,
  onContextChange,
  onActivate,
}: {
  widget: Widget;
  traces: Trace[];
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  const isApplied = useAppliedFilter();
  const [expandedTrace, setExpandedTrace] = useState<string>();
  const fetchTrace = useTraceFetcher();
  const list = useRef<HTMLDivElement>(null);
  const hintElement = useRef<HTMLParagraphElement>(null);
  const hintId = useId();
  const [overflow, setOverflow] = useState<"vertical" | "horizontal" | "both">();
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    let cancelled = false;
    const measure = () => {
      // Account for the hint's height so it cannot cause its own overflow.
      const availableHeight = element.clientHeight + (hintElement.current?.getBoundingClientRect().height ?? 0);
      const vertical = element.clientHeight > 0 && element.scrollHeight > availableHeight + 1;
      const horizontal = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
      if (!cancelled) setOverflow(vertical && horizontal ? "both" : vertical ? "vertical" : horizontal ? "horizontal" : undefined);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; observer?.disconnect(); };
  }, [traces, expandedTrace]);
  // Focus only sets the drilldown context. A trace row is the applied filter when the dashboard's variables hold its selection.
  const activate = onActivate ?? onContextChange;
  const focusTrace = (trace: Trace) => onContextChange?.(traceContext(trace));
  const activateTrace = (trace: Trace) => activate?.(traceContext(trace));
  // Search results carry no trace status, so the column is shown only when a row reports one.
  const reportsStatus = traces.some((trace) => statusReported(trace.status));
  const maximum = Math.max(
    1,
    ...traces
      .slice(0, MAX_ROWS)
      .map((trace) =>
        Number.isFinite(trace.durationMs) ? Math.max(0, trace.durationMs) : 0,
      ),
  );
  return (
    <div className={styles.traceListContainer}>
    <div
      ref={list}
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} traces`}
      aria-describedby={overflow ? hintId : undefined}
    >
      <ChartTable className={styles.table} aria-label={widget.title}>
        <thead>
          <tr>
            <th scope="col">Service / operation</th>
            <th scope="col">Duration</th>
            {reportsStatus && <th scope="col">Status</th>}
            <th scope="col" className={styles.numeric}>
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {traces.slice(0, MAX_ROWS).map((trace, index) => {
            const status = trace.status.trim().toLowerCase();
            const failed = /^(error|fail|failed|failure|status_code_error)$/.test(
              status,
            );
            const successful = /^(ok|success|succeeded|status_code_ok)$/.test(
              status,
            );
            const statusClass = failed
              ? styles.statusError
              : successful
                ? styles.statusSuccess
                : styles.statusNeutral;
            const barClass = failed
              ? styles.traceError
              : successful
                ? styles.traceSuccess
                : "";
            return (
              <Fragment key={`${trace.traceId}-${index}`}><tr
                tabIndex={onContextChange ? 0 : undefined}
                data-filter-active={
                  isApplied(traceContext(trace)) ? "" : undefined
                }
                aria-current={
                  isApplied(traceContext(trace)) ? "true" : undefined
                }
                className={
                  onContextChange ? contextStyles.interactiveRow : undefined
                }
                onFocus={(event) => {
                  if (onContextChange && !(event.target as HTMLElement).closest("[data-trace-waterfall-toggle]")) focusTrace(trace);
                }}
                onClick={(event) => {
                  // The waterfall toggle expands the trace and must not change filters. Portalled details are not part of the row.
                  const target = event.target as Element;
                  if (!activate || !event.currentTarget.contains(target) || target.closest("[data-trace-waterfall-toggle], dialog")) return;
                  activateTrace(trace);
                }}
                onKeyDown={(event) => {
                  if (
                    activate &&
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    activateTrace(trace);
                  }
                }}
              >
                <td>
                  <ObservationDetails
                    label={`Inspect trace ${trace.traceId}`}
                    enabled={!embedded && widget.options?.showTooltip !== false}
                    revision={trace}
                    details={
                      <>
                        <div className={configStyles.tooltipHeader}>
                          <strong className={configStyles.tooltipTitle}>
                            {trace.service || "Unknown service"}
                          </strong>
                          <span>{trace.operation || trace.traceId}</span>
                        </div>
                        <div className={configStyles.tooltipReading}>
                          <strong
                            data-metric-value={
                              Number.isFinite(trace.durationMs) &&
                              trace.durationMs >= 0
                                ? String(trace.durationMs)
                                : undefined
                            }
                          >
                            {Number.isFinite(trace.durationMs) &&
                            trace.durationMs >= 0
                              ? formatMetricDetails(trace.durationMs, "ms", widget.options?.decimals)
                              : NO_DATA}
                          </strong>
                          {statusReported(trace.status) && (
                            <span className={configStyles.tooltipStatus}>
                              {trace.status}
                            </span>
                          )}
                        </div>
                        <div className={configStyles.tooltipLabels}>
                          <dl>
                            <div>
                              <dt>Trace ID</dt>
                              <dd>{trace.traceId}</dd>
                            </div>
                            <div>
                              <dt>Service</dt>
                              <dd>{trace.service || "Unknown"}</dd>
                            </div>
                            <div>
                              <dt>Operation</dt>
                              <dd>{trace.operation || "Unknown"}</dd>
                            </div>
                          </dl>
                        </div>
                        <div className={configStyles.tooltipFooter}>
                          <span>Started</span>
                          {validTimestamp(trace.startTime) ? (
                            <time
                              dateTime={new Date(trace.startTime).toISOString()}
                            >
                              {fullDateTimeFormat.format(
                                new Date(trace.startTime),
                              )}
                            </time>
                          ) : (
                            "No valid timestamp"
                          )}
                        </div>
                      </>
                    }
                  >
                    <span>
                      <span>{trace.service || "Unknown service"}</span>
                      <span className={styles.operation}>
                        {trace.operation || trace.traceId}
                      </span>
                    </span>
                  </ObservationDetails>
                  {!embedded && fetchTrace && /^[a-fA-F0-9]{32}$/.test(trace.traceId) && <button type="button" data-trace-waterfall-toggle className={styles.traceExpand} aria-expanded={expandedTrace === trace.traceId} onClick={event => { event.stopPropagation(); setExpandedTrace(previous => previous === trace.traceId ? undefined : trace.traceId); }}>
                    {expandedTrace === trace.traceId ? "Close waterfall" : "View waterfall"}
                  </button>}
                  {!embedded && expandedTrace === trace.traceId && <TraceDialog traceId={trace.traceId} decimals={widget.options?.decimals} onClose={() => setExpandedTrace(undefined)} />}
                </td>
                <td>
                  <div className={styles.traceTime}>
                    {formatMetric(
                      trace.durationMs >= 0 ? trace.durationMs : NaN,
                      "ms",
                      false,
                      widget.options?.decimals,
                    )}
                    <span
                      className={`${styles.traceBar} ${barClass}`}
                      style={{
                        width: `${Number.isFinite(trace.durationMs) ? Math.max(0, (trace.durationMs / maximum) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </td>
                {reportsStatus && (
                  <td>
                    <span
                      className={`${styles.status} ${statusClass}`}
                    >
                      {trace.status || "Unknown"}
                    </span>
                  </td>
                )}
                <td className={styles.numeric}>
                  {validTimestamp(trace.startTime) ? (
                    <time
                      dateTime={new Date(trace.startTime).toISOString()}
                      title={fullDateTimeFormat.format(
                        new Date(trace.startTime),
                      )}
                    >
                      {timeFormat.format(new Date(trace.startTime))}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
              </tr></Fragment>
            );
          })}
        </tbody>
      </ChartTable>
      {traces.length > MAX_ROWS && (
        <p className={styles.notice}>
          Showing {MAX_ROWS} of {traces.length} traces. Narrow the query to see
          others.
        </p>
      )}
    </div>
    {!reportsStatus && (
      <p className={styles.traceScrollHint} data-trace-status="hidden">
        {fetchTrace ? "Status is shown in the waterfall" : "Search results do not report trace status"}
      </p>
    )}
    {overflow && <p ref={hintElement} id={hintId} className={styles.traceScrollHint}>
      {overflow === "both" ? "Scroll to see all traces and columns" : overflow === "vertical" ? "Scroll to see all traces" : "Scroll horizontally to see more columns"}
    </p>}
    </div>
  );
}
