import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarDateTime, calendarTicks } from "./chart-presentation";
import { browserTimeZone, resolveDashboardTimeZone } from "./dashboard-time-zone";
import { isCanonicalTimeZone, isFormattableTimeZone } from "./schema";

// The list lacks Asia/Kolkata here, as a list built before the name was added would. The runtime still formats the zone.
vi.mock("./time-zones.generated", async (importOriginal) => {
  const original = await importOriginal<typeof import("./time-zones.generated")>();
  return { timeZones: original.timeZones.filter((zone) => zone !== "Asia/Kolkata") };
});

const DAY = 86_400_000;
const KOLKATA_OFFSET = 330 * 60_000;

/** Makes the viewer's runtime report `timeZone` as its own zone, as a browser does. Everything else still formats for real. */
function viewerZone(timeZone: string) {
  const real = Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...real, timeZone });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the viewer's own zone when the canonical list lacks it", () => {
  it("is outside the list, so a saved dashboard cannot name it, yet this runtime formats it", () => {
    expect(isCanonicalTimeZone("Asia/Kolkata")).toBe(false);
    expect(isFormattableTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("is the zone that labels render in, rather than UTC", () => {
    viewerZone("Asia/Kolkata");
    expect(browserTimeZone()).toBe("Asia/Kolkata");
    // A dashboard without a zone, and one with a stale zone, both render in the viewer's zone.
    expect(resolveDashboardTimeZone(undefined)).toBe("Asia/Kolkata");
    expect(resolveDashboardTimeZone("Factory")).toBe("Asia/Kolkata");
    // 00:00 UTC on 1 January is 05:30 in Kolkata.
    const midnightUtc = Date.UTC(2026, 0, 1);
    expect(calendarDateTime(midnightUtc, browserTimeZone())).toContain("05:30:00.000");
    expect(calendarDateTime(midnightUtc, "UTC")).toContain("00:00:00.000");
  });

  it("puts calendar ticks on the viewer's local midnights", () => {
    viewerZone("Asia/Kolkata");
    const start = Date.UTC(2026, 0, 1), end = Date.UTC(2026, 0, 5);
    const ticks = calendarTicks(start, end, 4, browserTimeZone());
    const days = ticks.filter((tick) => tick.grain === "day");
    expect(days.length).toBeGreaterThan(0);
    // Kolkata is UTC+05:30, so its local midnight falls at 18:30 UTC on the previous day.
    for (const tick of days) expect((tick.value + KOLKATA_OFFSET) % DAY).toBe(0);
    expect(ticks.map((tick) => tick.value)).not.toEqual(calendarTicks(start, end, 4, "UTC").map((tick) => tick.value));
  });

  it("still falls back to UTC when the runtime reports no zone", () => {
    const real = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...real, timeZone: undefined } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(browserTimeZone()).toBe("UTC");
  });
});
