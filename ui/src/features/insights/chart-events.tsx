"use client";

import { useMemo } from "react";
import type { RecordedEvent } from "./annotation-events";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import styles from "./chart-events.module.css";

/** Recorded context stays reachable without resizing the signal under review. */
export function ChartEvents({ events }: { events: readonly RecordedEvent[] }) {
  const timeZone = useDashboardTimeZone();
  const format = useMemo(() => new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone,
  }), [timeZone]);
  if (!events.length) return null;
  return <details className={styles.events} data-chart-events role="group" aria-label="Chart events" onKeyDown={event => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary>{events.length} {events.length === 1 ? "event" : "events"} in view</summary>
    <ul tabIndex={0} aria-label="Recorded chart events">
      {events.map((event, index) => <li key={`${event.timestamp}-${index}`}>
        <span className={styles.bullet} data-severity={event.severity ?? "unclassified"} aria-hidden="true" />
        <strong>{event.label}</strong>
        <span className={styles.severity}>{event.severity ?? "unclassified"}</span>
        <div className={styles.time}>
          <time dateTime={event.timestamp} title={new Date(event.timestamp).toISOString()}>{format.format(new Date(event.timestamp))}</time>
          {event.endTimestamp && <time dateTime={event.endTimestamp}>to {format.format(new Date(event.endTimestamp))}</time>}
        </div>
      </li>)}
    </ul>
  </details>;
}
