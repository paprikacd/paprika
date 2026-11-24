"use client";

import type { RecordedEvent } from "./annotation-events";

/** The colour of an event's severity: its status token, or the muted ink when the event is unclassified. */
export function eventTone(severity: RecordedEvent["severity"]): string {
  return severity === "critical" || severity === "warning" || severity === "info" ? `var(--gamma-status-${severity})` : "var(--gamma-muted)";
}

/**
 * Event markers for an SVG host, as thin ticks, never filled bands. A point event is a 1 px rule across `top` to `bottom`; an
 * interval is a 3 px bar along `top`. Ticks are decorative and pointer-transparent, so hit testing and density stay the host's.
 */
export function EventTicks({ events, x, top, bottom }: {
  events: readonly RecordedEvent[];
  x: (timestamp: number) => number;
  top: number;
  bottom: number;
}) {
  if (!events.length) return null;
  return (
    <g aria-hidden="true" pointerEvents="none">
      {events.map((event, index) => {
        const start = Date.parse(event.timestamp);
        const finish = event.endTimestamp ? Date.parse(event.endTimestamp) : start;
        const tone = eventTone(event.severity);
        if (!Number.isFinite(start)) return null;
        if (finish > start) {
          const left = x(start);
          return <rect key={`${event.timestamp}-${index}`} data-event-tick="interval" x={left} y={top} width={Math.max(1, x(finish) - left)} height={3} fill={tone} fillOpacity={0.6} />;
        }
        const at = x(start);
        return <line key={`${event.timestamp}-${index}`} data-event-tick="point" x1={at} x2={at} y1={top} y2={bottom} stroke={tone} strokeWidth={1} strokeOpacity={0.6} />;
      })}
    </g>
  );
}
