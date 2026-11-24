"use client";

import type { ReactNode } from "react";
import type { RecordedEvent } from "./annotation-events";
import { ChartDataInspector } from "./chart-data-inspector";
import { ChartEvents } from "./chart-events";
import type { Series } from "./chart-renderer-shared";
import styles from "./charts.module.css";
import type { Widget } from "./schema";

/**
 * The actions under a chart, in one fixed order: recorded events, the compare window, prior data, then the current data.
 * Each action appears only when it has something to show, and nothing renders when none does. Renderers place this row
 * inside their footer so every chart offers the same actions in the same place.
 */
export function WidgetFooterActions({ widget, events, compare, inspectPrior, inspect }: {
  widget: Widget;
  events?: readonly RecordedEvent[];
  compare?: ReactNode;
  inspectPrior?: readonly Series[];
  inspect?: readonly Series[];
}) {
  const hasEvents = !!events?.length;
  const hasPrior = !!inspectPrior?.length;
  const hasInspect = !!inspect?.length;
  if (!hasEvents && !compare && !hasPrior && !hasInspect) return null;
  return (
    <div className={styles.chartActions} data-chart-actions>
      {hasEvents && <ChartEvents events={events} />}
      {compare}
      {hasPrior && <ChartDataInspector widget={{ ...widget, title: `${widget.title} · Previous period` }} series={[...inspectPrior]} buttonText="Inspect prior data" />}
      {hasInspect && <ChartDataInspector widget={widget} series={[...inspect]} />}
    </div>
  );
}
