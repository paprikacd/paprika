"use client";

import { NO_DATA } from "./benign-states";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { exactMetric, formatMetricDetails, latestPoint, seriesName } from "./chart-data";
import configStyles from "./chart-styles.module.css";
import styles from "./charts.module.css";
import { GammaButton } from "./gamma/button";
import { lockBodyScroll } from "./gamma/scroll-lock";
import { GammaSelect } from "./gamma/select";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import type { Widget } from "./schema";
import { contextKey, metricContext, validTimestamp } from "./widget-context";
import type { Series } from "./chart-renderer-shared";

export function ChartDataInspector({
  widget,
  series,
  buttonText = "Inspect data",
}: {
  widget: Widget;
  series: Series[];
  buttonText?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={configStyles.chartDataAction}>
      <GammaButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Inspect chart data for ${widget.title}`}
      >
        {buttonText}
      </GammaButton>
      {open && (
        <ChartDataDialog
          widget={widget}
          series={series}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ChartDataDialog({
  widget,
  series,
  onClose,
}: {
  widget: Widget;
  series: Series[];
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const choices = useMemo(
    () =>
      series.map((entry, index) => ({
        entry,
        value: contextKey(metricContext(entry, index)),
        label: seriesName(entry, index),
      })),
    [series],
  );
  const [selected, setSelected] = useState(() => choices[0]?.value ?? "");
  const [page, setPage] = useState(0);
  const [exact, setExact] = useState(false);
  const timeZone = useDashboardTimeZone();
  // Compact local-style stamp in the dashboard zone: fits a 390 px table without the ISO string and its fraction.
  const timestampFormat = useMemo(
    () =>
      new Intl.DateTimeFormat("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone,
      }),
    [timeZone],
  );
  const chosen =
    choices.find((choice) => choice.value === selected) ?? choices[0];
  if (chosen && chosen.value !== selected) {
    setSelected(chosen.value);
    setPage(0);
  }
  const entry = chosen?.entry;
  const points = useMemo(() => {
    if (!entry) return [];
    if (widget.type === "bar") {
      const point = latestPoint(entry);
      return point ? [point] : [];
    }
    return entry.points
      .filter((point) => validTimestamp(point.timestamp))
      .toSorted((a, b) => a.timestamp - b.timestamp);
  }, [entry, widget.type]);
  const pages = Math.max(1, Math.ceil(points.length / 25));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    const unlock = lockBodyScroll();
    element.showModal();
    close.current?.focus();
    return () => {
      const restore =
        element.contains(document.activeElement) ||
        document.activeElement === document.body;
      element.close();
      unlock();
      if (restore && opener instanceof HTMLElement && opener.isConnected)
        opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={configStyles.dataDialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className={configStyles.inspectorToolbar}>
        <h2 id={`${id}-title`}>{widget.title} data</h2>
        <GammaButton ref={close} variant="ghost" onClick={onClose}>
          Close data
        </GammaButton>
      </div>
      <p id={`${id}-description`}>
        {widget.type === "bar"
          ? "Latest valid sample per series."
          : "Query observations before visual downsampling. Missing samples remain empty. This view does not change dashboard link selection."}{" "}
        Values follow the widget&apos;s decimal setting. Times are in {timeZone}.
      </p>
      <div className={configStyles.inspectorToolbar}>
        <GammaSelect
          aria-label="Data series"
          value={selected}
          options={choices}
          searchable={series.length > 8}
          onValueChange={(value) => {
            setSelected(value);
            setPage(0);
          }}
        />
        <GammaButton
          variant="ghost"
          size="sm"
          aria-pressed={exact}
          onClick={() => setExact((value) => !value)}
        >
          Exact values
        </GammaButton>
      </div>
      {entry && (
        <dl className={configStyles.inspectorLabels}>
          {Object.entries(entry.labels).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div
        className={styles.tableWrap}
        role="region"
        aria-label="Exact chart observations"
        tabIndex={0}
      >
        <table className={styles.table} aria-label={widget.title}>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {points
              .slice(currentPage * 25, (currentPage + 1) * 25)
              .map((point, index) => (
                <tr key={`${point.timestamp}-${index}`}>
                  <td>
                    <time dateTime={new Date(point.timestamp).toISOString()}>
                      {timestampFormat.format(new Date(point.timestamp))}
                    </time>
                  </td>
                  <td
                    className={
                      exact
                        ? `${styles.numeric} ${configStyles.exactValue}`
                        : styles.numeric
                    }
                    data-observation-value={
                      typeof point.value === "number" &&
                      Number.isFinite(point.value)
                        ? point.value
                        : undefined
                    }
                  >
                    {typeof point.value === "number" &&
                    Number.isFinite(point.value)
                      ? exact
                        ? exactMetric(point.value, widget.unit)
                        : formatMetricDetails(
                            point.value,
                            widget.unit,
                            widget.options?.decimals,
                          )
                      : NO_DATA}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!points.length && <p>No valid samples for this series.</p>}
      </div>
      <div className={configStyles.inspectorFooter}>
        <span role="status">
          {points.length} observations · Page {currentPage + 1} of {pages}
        </span>
        <GammaButton
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous observations
        </GammaButton>
        <GammaButton
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next observations
        </GammaButton>
      </div>
    </dialog>
  );
}
