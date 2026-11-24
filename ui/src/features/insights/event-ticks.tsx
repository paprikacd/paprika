"use client";

import { eventsInRange, type RecordedEvent } from "./annotation-events";

/** The colour of an event's severity: its status token, or the muted ink when the event is unclassified. */
export function eventTone(severity: RecordedEvent["severity"]): string {
  return severity === "critical" || severity === "warning" || severity === "info" ? `var(--gamma-status-${severity})` : "var(--gamma-muted)";
}

/**
 * Event markers for an SVG host, as thin ticks, never filled bands. A point event is a 1 px rule across `top` to `bottom`; an
 * interval is a 3 px bar along `top`. Only events that overlap `range` are drawn, and an interval is clipped to it, so a tick
 * never lands outside the plot. Ticks are decorative and pointer-transparent, so hit testing and density stay the host's:
 * the host's inspector lists the events at the inspected time.
 */
export function EventTicks({ events, x, top, bottom, range }: {
  events: readonly RecordedEvent[];
  x: (timestamp: number) => number;
  top: number;
  bottom: number;
  /** The plotted time range in milliseconds. */
  range: { start: number; end: number };
}) {
  const shown = eventsInRange(events, range.start, range.end);
  if (!shown.length) return null;
  const clamp = (timestamp: number) => Math.min(range.end, Math.max(range.start, timestamp));
  return (
    <g aria-hidden="true" pointerEvents="none">
      {shown.map((event, index) => {
        const start = Date.parse(event.timestamp);
        const finish = event.endTimestamp ? Date.parse(event.endTimestamp) : start;
        const tone = eventTone(event.severity);
        if (Number.isFinite(finish) && finish > start) {
          const left = x(clamp(start));
          return <rect key={`${event.timestamp}-${index}`} data-event-tick="interval" x={left} y={top} width={Math.max(1, x(clamp(finish)) - left)} height={3} fill={tone} fillOpacity={0.6} />;
        }
        const at = x(start);
        return <line key={`${event.timestamp}-${index}`} data-event-tick="point" x1={at} x2={at} y1={top} y2={bottom} stroke={tone} strokeWidth={1} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" />;
      })}
    </g>
  );
}
