import { describe, expect, it } from "vitest";
import { calendarDateTime, calendarTick, horizontalPlotBounds, signedAreaGradient, temporalPosition, timeAxisValue } from "./chart-presentation";

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
