"use client";

import type { Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";
import { useWidgetDrilldown } from "./widget-drilldown";
import { drilldownContextReason } from "./widget-context";
import { GammaButton } from "./gamma/button";
import styles from "./chart-styles.module.css";

/** Named actions use the pinned observation, including an explicit missing value. */
export function ObservationDrilldowns({ widget, context }: { widget: Widget; context: DrilldownContext }) {
  const open = useWidgetDrilldown();
  if (!open || !widget.drilldowns?.length) return null;
  return <div className={styles.tooltipActions}>
    {widget.drilldowns.map(link => {
      const reason = drilldownContextReason(link, context);
      return <div key={link.id}>
        <GammaButton size="sm" variant="secondary" disabled={!!reason} onClick={() => open(link, context)}>{link.title}</GammaButton>
        <p className={styles.tooltipActionReason}>{reason ?? (link.carryTimeRange === false ? "Uses the destination time range." : "Keeps the current time range.")}</p>
      </div>;
    })}
  </div>;
}
