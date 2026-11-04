import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { browserTimeZone, DashboardTimeZoneProvider, resolveDashboardTimeZone, useDashboardTimeZone } from "./dashboard-time-zone";
import { dashboardSchema, isValidTimeZone, newDashboard, parseDashboard, serializeDashboard } from "./schema";

const dashboard = (timeZone?: unknown) => ({
  ...newDashboard(),
  id: "zoned",
  title: "Zoned",
  ...(timeZone === undefined ? {} : { timeZone }),
});

describe("dashboard time zone option", () => {
  it("accepts IANA zone names and refuses names the runtime cannot format", () => {
    for (const zone of ["UTC", "Europe/London", "America/New_York", "Etc/GMT+5"]) expect(isValidTimeZone(zone)).toBe(true);
    for (const zone of ["", "Local", "Not/AZone", " UTC", "UTC ", "x".repeat(65)]) expect(isValidTimeZone(zone)).toBe(false);
  });

  it("refuses a zone spelled in another letter case, because the server matches exact IANA names", () => {
    for (const zone of ["europe/london", "EUROPE/LONDON", "america/new_york", "utc", "Utc"]) expect(isValidTimeZone(zone), zone).toBe(false);
    for (const zone of ["UTC", "Europe/London", "America/New_York", "Asia/Calcutta"]) expect(isValidTimeZone(zone), zone).toBe(true);
  });

  it("is optional, and a dashboard without it stays valid", () => {
    expect(dashboardSchema.safeParse(dashboard()).success).toBe(true);
    expect(dashboardSchema.safeParse(dashboard("Europe/London")).success).toBe(true);
  });

  it("rejects null, non-string and unknown zones with the published wording", () => {
    for (const value of [null, 1, "Local", "Mars/Olympus"]) expect(dashboardSchema.safeParse(dashboard(value)).success).toBe(false);
    const result = dashboardSchema.safeParse(dashboard("Mars/Olympus"));
    expect(result.success ? "" : result.error.issues[0].message).toBe("Use an IANA time zone name, such as Europe/London or UTC");
  });

  it("round-trips through the YAML and JSON document formats", () => {
    const source = serializeDashboard({ ...newDashboard(), id: "zoned", title: "Zoned", timeZone: "UTC" }, "yaml");
    expect(parseDashboard(source, "yaml").timeZone).toBe("UTC");
    expect(parseDashboard(JSON.stringify(dashboard("Europe/London")), "json").timeZone).toBe("Europe/London");
  });
});

describe("dashboard time zone context", () => {
  function wrap(timeZone?: string) {
    function Wrapper({ children }: { children: ReactNode }) {
      return <DashboardTimeZoneProvider timeZone={timeZone}>{children}</DashboardTimeZoneProvider>;
    }
    return Wrapper;
  }

  it("gives every chart the dashboard's explicit zone", () => {
    const { result } = renderHook(() => useDashboardTimeZone(), { wrapper: wrap("Europe/London") });
    expect(result.current).toBe("Europe/London");
  });

  it("uses the viewer's browser zone when the dashboard omits one", () => {
    const { result } = renderHook(() => useDashboardTimeZone(), { wrapper: wrap(undefined) });
    expect(result.current).toBe(browserTimeZone());
    expect(isValidTimeZone(result.current)).toBe(true);
  });

  it("uses the viewer's browser zone outside any provider", () => {
    const { result } = renderHook(() => useDashboardTimeZone());
    expect(result.current).toBe(browserTimeZone());
  });

  it("treats an unusable explicit zone as absent instead of formatting with it", () => {
    expect(resolveDashboardTimeZone("Local")).toBe(browserTimeZone());
    expect(resolveDashboardTimeZone("Not/AZone")).toBe(browserTimeZone());
    expect(resolveDashboardTimeZone("UTC")).toBe("UTC");
  });
});
