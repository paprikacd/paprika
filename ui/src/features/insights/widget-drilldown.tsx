"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Drilldown } from "./schema";
import type { DrilldownContext } from "./drilldown";

type OpenDrilldown = (link: Drilldown, context: DrilldownContext) => void;
const WidgetDrilldown = createContext<OpenDrilldown | undefined>(undefined);

/** The host owns dashboard navigation; chart renderers only pass selected data. */
export function WidgetDrilldownProvider({ open, children }: { open?: OpenDrilldown; children: ReactNode }) {
  return <WidgetDrilldown.Provider value={open}>{children}</WidgetDrilldown.Provider>;
}

export const useWidgetDrilldown = () => useContext(WidgetDrilldown);
