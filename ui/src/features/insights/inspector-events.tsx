"use client";

import type { RecordedEvent } from "./annotation-events";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import type { StatusLevel } from "./status";
import { StatusChip } from "./status-chip";

/**
 * The recorded events at a pinned or hovered observation. Each names its severity with the status chip, so the colour is never
 * the only cue, and gives its time in the dashboard zone. Events are context: they never change the reading above them.
 */
export function InspectorEvents({ events }: { events: readonly RecordedEvent[] }) {
  const timeZone = useDashboardTimeZone();
  if (!events.length) return null;
  const format = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" });
  return (
    <ul aria-label="Events at this time" className="mt-1.5 grid gap-1 text-xs">
      {events.map((event, index) => (
        <li key={`${event.timestamp}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
          <StatusChip status={(event.severity ?? "unknown") as StatusLevel} label={event.label} size="inline" />
          <time dateTime={event.timestamp} className="tabular-nums opacity-80">{format.format(new Date(event.timestamp))}</time>
        </li>
      ))}
    </ul>
  );
}
