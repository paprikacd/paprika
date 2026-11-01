import { describe, expect, it } from "vitest";
import { calendarDateTime, calendarTick, calendarTickLabel, calendarTicks, horizontalPlotBounds, signedAreaGradient, temporalPosition, timeAxisValue } from "./chart-presentation";

const DAY = 86_400_000;
// 2026-01-02T23:30:00Z: late evening in UTC, already the next morning in Tokyo.
const lateUtc = Date.UTC(2026, 0, 2, 23, 30);

describe("area gradient", () => {
  it("fades a positive-only series from its colour at the top to transparent at zero", () => {
    const gradient = signedAreaGradient("fill-a", "#2867b9", [1, 4, null, 2]);
    expect(gradient).toMatchObject({ id: "fill-a", type: "linear", x1: 0, y1: 0, x2: 0, y2: 1 });
    expect(gradient.stops).toEqual([
      { offset: 0, color: "#2867b9", opacity: 0.28 },
      { offset: 1, color: "#2867b9", opacity: 0 },
    ]);
  });

  it("fades a negative-only series from transparent at zero to its colour at the bottom", () => {
    const gradient = signedAreaGradient("fill-b", "#b4473d", [-1, -4]);
    expect(gradient.stops).toEqual([
      { offset: 0, color: "#b4473d", opacity: 0 },
      { offset: 1, color: "#b4473d", opacity: 0.28 },
    ]);
  });

  it("anchors a signed series at the zero line, fading to transparent there", () => {
    // Highest 3 and lowest -1 put zero three quarters of the way down: 3 / (3 + 1).
    const gradient = signedAreaGradient("fill-c", "#53876a", [3, -1, 2], 0.5);
    expect(gradient.stops).toEqual([
      { offset: 0, color: "#53876a", opacity: 0.5 },
      { offset: 0.75, color: "#53876a", opacity: 0 },
      { offset: 1, color: "#53876a", opacity: 0.5 },
    ]);
  });

  it("ignores unobserved and non-finite values, and keeps a zero line at the bottom when nothing is observed", () => {
    expect(signedAreaGradient("fill-d", "#000000", [null, Number.NaN, Number.POSITIVE_INFINITY]).stops.at(-1)).toEqual({ offset: 1, color: "#000000", opacity: 0 });
  });
});

describe("calendar ticks", () => {
  it("shows the clock time for spans of a day or less", () => {
    expect(calendarTick(lateUtc, DAY, "UTC")).toBe("23:30");
  });

  it("adds the time to dates for spans of two to four days, so sub-day ticks never repeat a date", () => {
    expect(calendarTick(lateUtc, 2 * DAY, "UTC")).toBe("Jan 2 23:30");
  });

  it("shows dates for wider spans", () => {
    expect(calendarTick(lateUtc, 30 * DAY, "UTC")).toBe("Jan 2");
  });

  it("honours the dashboard's zone rather than the viewer's", () => {
    // Tokyo is nine hours ahead, so the same instant reads 08:30 on the next day.
    expect(calendarTick(lateUtc, DAY, "Asia/Tokyo")).toBe("08:30");
    expect(calendarTick(lateUtc, 2 * DAY, "Asia/Tokyo")).toBe("Jan 3 08:30");
  });

  it("formats as UTC when the zone is unusable, and never throws", () => {
    expect(calendarTick(lateUtc, DAY, "Not/AZone")).toBe("23:30");
    expect(calendarTick(Number.NaN, DAY, "UTC")).toBe("—");
    expect(calendarTick(new Date(lateUtc), DAY, "UTC")).toBe("23:30");
  });

  it("states the full timestamp in the zone that it uses", () => {
    expect(calendarDateTime(lateUtc, "UTC")).toMatch(/Jan 0?2, 2026, 23:30:00\.000 UTC/);
    expect(calendarDateTime(lateUtc, "Asia/Tokyo")).toMatch(/Jan 0?3, 2026, 08:30:00\.000/);
    expect(calendarDateTime(Number.NaN, "UTC")).toBe("—");
  });
});

describe("plot geometry", () => {
  it("passes timestamps through as numbers for numeric axes and as dates for calendar axes", () => {
    expect(timeAxisValue(lateUtc, false)).toBe(lateUtc);
    expect(timeAxisValue(lateUtc, true)).toEqual(new Date(lateUtc));
  });

  it("maps a timestamp proportionally across the span, and centres a degenerate domain", () => {
    expect(temporalPosition(2500, 0, 10_000, 40, 240)).toBe(90);
    expect(temporalPosition(5000, 5000, 5000, 40, 240)).toBe(140);
  });

  it("keeps the requested insets when there is room, and shrinks them before the plot can invert", () => {
    expect(horizontalPlotBounds(300, 40, 20)).toEqual({ left: 40, right: 20, plotWidth: 240 });
    for (const width of [0, 1, 12, 30, 90, 200]) {
      const bounds = horizontalPlotBounds(width, 40, 20);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeGreaterThanOrEqual(0);
      expect(bounds.plotWidth).toBeGreaterThanOrEqual(0);
    }
    expect(horizontalPlotBounds(0, 40, 20)).toEqual({ left: 0, right: 0, plotWidth: 0 });
    expect(horizontalPlotBounds(Number.NaN, 40, 20).plotWidth).toBe(0);
  });
});

describe("zone-aware calendar ticks", () => {
  const at = (iso: string) => Date.parse(iso);
  const labels = (ticks: ReturnType<typeof calendarTicks>, zone: string) => ticks.map((tick) => calendarTickLabel(tick, zone));

  it("skips the hour that a spring-forward night does not have in New York, and places the ticks by true instant", () => {
    const ticks = calendarTicks(at("2026-03-08T05:00:00Z"), at("2026-03-08T10:00:00Z"), 6, "America/New_York");
    // 01:00 EST is 06:00Z; the clock then reads 03:00 EDT at 07:00Z. Nothing reads 02:00 that day.
    expect(ticks.map((tick) => tick.value)).toEqual([5, 6, 7, 8, 9, 10].map((hour) => Date.UTC(2026, 2, 8, hour)));
    expect(labels(ticks, "America/New_York")).toEqual(["Mar 8", "01:00", "03:00", "04:00", "05:00", "06:00"]);
    expect(ticks.every((tick) => tick.grain === "hour")).toBe(true);
  });

  it("skips the missing half-hours of the spring-forward jump in Melbourne, and keeps every tick one step apart in elapsed time", () => {
    // Melbourne moves from 02:00 AEST to 03:00 AEDT at 16:00Z on 3 October 2026.
    const ticks = calendarTicks(at("2026-10-03T14:00:00Z"), at("2026-10-03T17:00:00Z"), 6, "Australia/Melbourne");
    const gaps = ticks.slice(1).map((tick, index) => tick.value - ticks[index].value);
    expect(gaps.every((gap) => gap === 30 * 60_000)).toBe(true);
    const shown = labels(ticks, "Australia/Melbourne");
    expect(shown).toContain("01:30");
    expect(shown).toContain("03:00");
    expect(shown.some((label) => label.startsWith("02:"))).toBe(false);
  });

  it("places a day that is 23 hours long at its true width, with midnight labels in Melbourne", () => {
    const ticks = calendarTicks(at("2026-10-02T14:00:00Z"), at("2026-10-06T00:00:00Z"), 4, "Australia/Melbourne");
    expect(ticks.every((tick) => tick.grain === "day")).toBe(true);
    expect(labels(ticks, "Australia/Melbourne")).toEqual(["Oct 3", "Oct 4", "Oct 5", "Oct 6"]);
    const gaps = ticks.slice(1).map((tick, index) => (tick.value - ticks[index].value) / 3_600_000);
    // Only 4 October, the day the clocks move forward, is 23 hours long.
    expect(gaps).toEqual([24, 23, 24]);
  });

  it("aligns weeks to Monday in the zone", () => {
    const ticks = calendarTicks(at("2026-11-01T00:00:00Z"), at("2026-12-01T00:00:00Z"), 5, "UTC");
    expect(ticks.every((tick) => tick.grain === "week")).toBe(true);
    expect(labels(ticks, "UTC")).toEqual(["Nov 2", "Nov 9", "Nov 16", "Nov 23", "Nov 30"]);
  });

  it("aligns months to the first of the month, and names January with its year", () => {
    const ticks = calendarTicks(at("2026-01-01T00:00:00Z"), at("2027-01-01T00:00:00Z"), 4, "UTC");
    expect(ticks.every((tick) => tick.grain === "month")).toBe(true);
    expect(labels(ticks, "UTC")).toEqual(["Jan 2026", "Apr", "Jul", "Oct", "Jan 2027"]);
  });

  it("reads each midnight in the dashboard zone rather than in UTC", () => {
    // Tokyo midnight on 3 October is 15:00Z on 2 October.
    const ticks = calendarTicks(at("2026-10-02T12:00:00Z"), at("2026-10-04T12:00:00Z"), 3, "Asia/Tokyo");
    expect(ticks.map((tick) => tick.value)).toContain(at("2026-10-02T15:00:00Z"));
    expect(labels(ticks, "Asia/Tokyo")).toContain("Oct 3");
  });

  it("keeps a day tick on a local midnight that does not exist, at the first instant of that day", () => {
    // Santiago springs forward from 00:00 to 01:00 on 6 September 2026, so midnight never happens that day.
    const ticks = calendarTicks(at("2026-09-05T12:00:00Z"), at("2026-09-07T12:00:00Z"), 3, "America/Santiago");
    expect(ticks.map((tick) => tick.value)).toContain(at("2026-09-06T04:00:00Z"));
    expect(labels(ticks, "America/Santiago")).toContain("Sep 6");
  });

  it("returns nothing for an empty or invalid span, and formats an unusable zone as UTC", () => {
    expect(calendarTicks(5, 5, 4, "UTC")).toEqual([]);
    expect(calendarTicks(Number.NaN, 10, 4, "UTC")).toEqual([]);
    expect(calendarTicks(at("2026-11-01T00:00:00Z"), at("2026-11-01T06:00:00Z"), 6, "Not/AZone").map((tick) => tick.value)).toEqual(
      calendarTicks(at("2026-11-01T00:00:00Z"), at("2026-11-01T06:00:00Z"), 6, "UTC").map((tick) => tick.value),
    );
    expect(calendarTickLabel({ value: Number.NaN, grain: "hour" }, "UTC")).toBe("—");
  });
});
