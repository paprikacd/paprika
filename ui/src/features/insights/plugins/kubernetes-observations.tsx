"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { DrilldownContext } from "../drilldown";
import { MetricDetails } from "../metric-tooltip-content.tsx";
import { ObservationTooltip } from "../observation-tooltip.tsx";
import { formatMetricDetails, type Point, type Series } from "../chart-data";
import { useObservationOwner, type ObservationOwner, type TriggerHandlers } from "../observation-owner";
import { occurrenceKeys } from "../tooltip-identity";
import type { Widget } from "../schema";
import { NO_DATA } from "../benign-states";

/** Shared by the Kubernetes renderers: one observation owner per widget, with the same tooltip the other Insights renderers use. */

export const RESOURCE_UNIT = { cpu: "cores", memory: "B" } as const;

/** One observation: a mark's reading, shown in the shared tooltip. Keys name the observation across refreshes. */
export interface Observation {
  key: string;
  subject: string;
  series: Series;
  point: Point;
  unit: string;
  description: string;
  detail: ReactNode;
  context: DrilldownContext;
}

export interface Observed {
  index: number;
  trigger?: TriggerHandlers;
}

export interface Observations {
  id: string;
  root: RefObject<HTMLDivElement | null>;
  observe: (key: string) => Observed | undefined;
  popover: ReactNode;
}

/** Shares one observation owner per widget: marks open a single tooltip, and a refresh keeps an open one on its mark. */
export function useObservations(observations: Observation[], widget: Widget, enabled: boolean): Observations {
  const id = useId(), root = useRef<HTMLDivElement>(null);
  const keys = occurrenceKeys(observations.map(observation => observation.key));
  const owner: ObservationOwner = useObservationOwner({
    enabled,
    retention: { keys },
    locate: key => root.current?.querySelector<HTMLElement>(`[data-observation="${keys.indexOf(key)}"]`) ?? null,
  });
  const indexByKey = new Map(observations.map((observation, index) => [observation.key, index]));
  const activeIndex = owner.active ? keys.indexOf(owner.active.key) : -1;
  const current = activeIndex >= 0 ? observations[activeIndex] : undefined;
  const observe = (key: string): Observed | undefined => {
    const index = indexByKey.get(key);
    if (index === undefined) return undefined;
    return { index, trigger: enabled ? owner.trigger(keys[index]) : undefined };
  };
  const popover = owner.active && current ? (
    <ObservationTooltip id={id} anchor={owner.active.anchor} avoidWidget anchorOwnsHistoryKeys pinned={owner.active.pinned}
      onDismiss={owner.dismiss} onEnter={owner.panelEnter} onLeave={owner.panelLeave}>
      <MetricDetails widget={widget} series={current.series} index={0} point={current.point} unit={current.unit}
        decimals={widget.options?.decimals} subject={current.subject} seriesLabel={widget.title} description={current.description}>
        {current.detail}
      </MetricDetails>
    </ObservationTooltip>
  ) : null;
  return { id, root, observe, popover };
}

export interface RovingProps {
  tabIndex: number;
  "data-roving": number;
  onKeyDown: (event: KeyboardEvent<Element>) => void;
  onFocus: () => void;
}

/**
 * One tab stop per widget for its marks. Arrow keys move between marks: left and right by one, up and down by a row of
 * `columns` marks, Home and End to the ends. Marks that are not native buttons pass `activate`, which Enter and Space
 * call, so the keyboard can pin a tooltip on an SVG mark as a click does.
 */
export function useRoving(root: RefObject<HTMLElement | null>, count: number, columns = 1) {
  const [active, setActive] = useState(0);
  const current = Math.max(0, Math.min(active, count - 1));
  return (index: number, activate?: (event: KeyboardEvent<Element>) => void): RovingProps => ({
    tabIndex: index === current ? 0 : -1,
    "data-roving": index,
    onFocus: () => setActive(index),
    onKeyDown: (event) => {
      if (activate && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        activate(event);
        return;
      }
      const step = Math.max(1, columns);
      const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1
        : event.key === "ArrowDown" ? index + step : event.key === "ArrowUp" ? index - step
        : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
      if (next === null) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(count - 1, next));
      setActive(target);
      root.current?.querySelector<HTMLElement | SVGElement>(`[data-roving="${target}"]`)?.focus();
    },
  });
}

/** The element's content width in whole pixels, kept current by a ResizeObserver. Null before the first measurement. */
export function useInlineSize(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const measured = Math.floor(element.getBoundingClientRect().width);
      if (measured > 0) setWidth(previous => (previous === measured ? previous : measured));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export const text = (value: number | null, unit: string, decimals?: number) => (value === null ? NO_DATA : formatMetricDetails(value, unit, decimals));

/** The latest sample time in the result. Requests and limits are read at this instant. */
export function sampleTime(series: Series[] | undefined): number {
  let latest = 0;
  for (const entry of series ?? []) for (const point of entry.points) if (Number.isFinite(point.timestamp) && point.timestamp > latest) latest = point.timestamp;
  return latest;
}
