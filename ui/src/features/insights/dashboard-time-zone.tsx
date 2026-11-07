"use client";

import { createContext, useContext, type ReactNode } from "react";
import { isFormattableTimeZone, isValidTimeZone } from "./schema";

/**
 * The viewer's own zone, which renders even when the canonical list lacks it: the list validates saved dashboards only.
 * UTC is the explicit fallback where the runtime reports no zone or cannot format the one it reports.
 */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isFormattableTimeZone(zone)) return zone;
  } catch {
    // Some embedded runtimes omit zone data; UTC is the explicit fallback.
  }
  return "UTC";
}

/** An explicit dashboard zone wins. An absent or unusable one falls back to the viewer's zone. */
export function resolveDashboardTimeZone(timeZone?: string | null): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : browserTimeZone();
}

const DashboardTimeZoneContext = createContext<string | null>(null);

/** Supplies the dashboard's IANA zone to every chart that labels time. */
export function DashboardTimeZoneProvider({ timeZone, children }: { timeZone?: string; children: ReactNode }) {
  return <DashboardTimeZoneContext.Provider value={resolveDashboardTimeZone(timeZone)}>{children}</DashboardTimeZoneContext.Provider>;
}

/** The effective zone for dashboard time labels. Outside a provider it is the viewer's zone. */
export function useDashboardTimeZone(): string {
  return useContext(DashboardTimeZoneContext) ?? browserTimeZone();
}
