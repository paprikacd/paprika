import { expect, it } from "vitest";
import { correctPortalPosition, placePointerTooltip } from "./tooltip-pointer";
it("keeps ordinary body portal coordinates unchanged", () => {
  expect(correctPortalPosition({ left: 100, top: 80 }, { left: 100, top: 80, width: 300, height: 200 }, { width: 300, height: 200 })).toEqual({ left: 100, top: 80 });
});
it("corrects translated/scaled fixed containing blocks in viewport coordinates", () => {
  expect(correctPortalPosition({ left: 100, top: 80 }, { left: 250, top: 180, width: 600, height: 400 }, { width: 300, height: 200 })).toEqual({ left: 25, top: 30 });
});
it("flips and bounds a pointer panel within the owning iframe viewport", () => {
  const p = placePointerTooltip({ x: 370, y: 680 }, { width: 300, height: 180 }, { width: 390, height: 700 });
  expect(p.left).toBeGreaterThanOrEqual(12);
  expect(p.left + 300).toBeLessThanOrEqual(378);
  expect(p.top + 180).toBeLessThan(680);
});
