"use client";

import { useId, useRef, type ReactNode, type RefObject } from "react";
import type { DrilldownContext } from "../drilldown";
import { MetricDetails, ObservationTooltip } from "../chart-renderers";
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

export const text = (value: number | null, unit: string, decimals?: number) => (value === null ? NO_DATA : formatMetricDetails(value, unit, decimals));

/** The latest sample time in the result. Requests and limits are read at this instant. */
export function sampleTime(series: Series[] | undefined): number {
  let latest = 0;
  for (const entry of series ?? []) for (const point of entry.points) if (Number.isFinite(point.timestamp) && point.timestamp > latest) latest = point.timestamp;
  return latest;
}
