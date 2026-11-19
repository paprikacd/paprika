import { describe, expect, it } from "vitest";
import { placeClearOutsideWidgetTooltip, placeHeatmapTooltip, placeOutsideWidgetTooltip, placePointerAvoiding, placePlotTooltip, placeTooltip, readTooltipPlacement, tooltipLimit, type TooltipPlacement, type TooltipTarget, type TooltipViewport } from "./tooltip-position";

const point = (x: number, y: number) => ({ left: x, right: x, top: y, bottom: y });
const pointer = (x: number, y: number): TooltipTarget => ({ kind: "pointer", point: { x, y } });

describe("shared observation tooltip positioning", () => {
  const viewport = { width: 1000, height: 700 };

  it("tracks the exact pointer without easing and flips away from the viewport edge", () => {
    const size = { width: 330, height: 260 };
    const first = placeTooltip(pointer(50, 80), size, viewport);
    const moved = placeTooltip(pointer(55, 84), size, viewport);
    expect(moved.left - first.left).toBe(5);
    expect(moved.top - first.top).toBe(4);
    expect(first.placement).toBe("pointer-bottom-right");
    const edge = placeTooltip(pointer(970, 350), size, viewport);
    expect(edge.placement).toBe("pointer-bottom-left");
    expect(edge.left + size.width).toBe(954);
  });

  it("keeps a preview on the same side as query content grows or shrinks", () => {
    for (const placement of [undefined, "top", "bottom"] as const) for (const y of [100, 350, 400, 650]) {
      const positions = [20, 160, 380, 560, 900].map(height => placeTooltip(pointer(500, y), { width: 330, height }, viewport, { placement }));
      expect(new Set(positions.map(position => position.placement)).size).toBe(1);
      expect(new Set(positions.map(position => position.maxHeight)).size).toBe(1);
    }
  });

  it("keeps the default anchored placements identical to the legacy functions", () => {
    const anchor = { left: 300, right: 306, top: 220, bottom: 226 }, size = { width: 240, height: 250 };
    expect(placeTooltip({ kind: "anchor", anchor, preferSide: true }, size, viewport)).toEqual(placePlotTooltip(anchor, size, viewport));
    expect(placeTooltip({ kind: "anchor", anchor }, size, viewport)).toEqual(placeHeatmapTooltip(anchor, size, viewport));
    const widget = { left: 100, right: 600, top: 100, bottom: 400 };
    expect(placeTooltip({ kind: "outside", anchor, widget }, size, viewport)).toEqual(placeOutsideWidgetTooltip(widget, anchor, size, viewport));
  });

  it("uses the overlap fallback on a phone when the only outside slot is a sliver beside a tall widget", () => {
    const phone = { width: 390, height: 844 };
    const widget = { left: 0, right: 390, top: 100, bottom: 700 };
    const anchor = { left: 150, right: 240, top: 300, bottom: 340 };
    const size = { width: 340, height: 300 };
    const placed = placeOutsideWidgetTooltip(widget, anchor, size, phone);
    // Above the widget there is 78 px and below it 122 px: neither can show a 200 px reading, so the panel overlaps the widget instead.
    expect(placed.overlapsWidget).toBe(true);
    // A wide viewport keeps the outside slot, as before.
    expect(placeOutsideWidgetTooltip(widget, anchor, size, { width: 1512, height: 844 }).overlapsWidget).toBe(false);
  });

  it("keeps the phone slot floor when obstacles are present, so no sliver is picked from the candidates", () => {
    const phone = { width: 390, height: 844 };
    const widget = { left: 0, right: 390, top: 100, bottom: 700 };
    const anchor = { left: 150, right: 240, top: 300, bottom: 340 };
    const size = { width: 340, height: 300 };
    // A header across the top leaves only the 78 px sliver above the widget, and the bottom slot is 122 px: both fall under the floor.
    const obstacles = [{ left: 0, right: 390, top: 0, bottom: 90 }];
    const placed = placeClearOutsideWidgetTooltip(widget, anchor, size, phone, obstacles);
    expect(placed.overlapsWidget).toBe(true);
    expect(placeClearOutsideWidgetTooltip(widget, anchor, size, { width: 1512, height: 844 }, obstacles).overlapsWidget).toBe(false);
  });

  it("treats explicit placement as a preference and flips when that side cannot fit", () => {
    const size = { width: 250, height: 160 };
    const top = placeTooltip({ kind: "anchor", anchor: point(500, 450) }, size, viewport, { placement: "top", offset: 20 });
    expect(top.placement).toBe("top");
    expect(top.top).toBe(270);
    const flipped = placeTooltip({ kind: "anchor", anchor: point(500, 20) }, size, viewport, { placement: "top", offset: 20 });
    expect(flipped.placement).toBe("bottom");
    expect(flipped.top).toBe(40);
    const left = placeTooltip({ kind: "anchor", anchor: point(500, 300), preferSide: true }, size, viewport, { placement: "left" });
    expect(left.placement).toBe("left");
    const rightFlip = placeTooltip({ kind: "anchor", anchor: point(990, 300), preferSide: true }, size, viewport, { placement: "right" });
    expect(rightFlip.placement).toBe("left");
  });

  it("offers the requested side for a pointer preview and flips it when the side has no room", () => {
    const size = { width: 200, height: 100 };
    expect(placeTooltip(pointer(500, 300), size, viewport, { placement: "left" }).placement).toBe("pointer-bottom-left");
    expect(placeTooltip(pointer(20, 300), size, viewport, { placement: "left" }).placement).toBe("pointer-bottom-right");
    expect(placeTooltip(pointer(500, 300), size, viewport, { placement: "top" }).placement).toBe("pointer-top-right");
  });

  it("applies the offset as the gap from the anchor, and zero offset touches it", () => {
    const anchor = { left: 40, right: 110, top: 150, bottom: 180 };
    const zero = placeTooltip({ kind: "anchor", anchor, preferSide: true }, { width: 250, height: 100 }, viewport, { placement: "right", offset: 0 });
    expect(zero.left).toBe(110);
    expect(zero.top).toBe(115);
    const wide = placeTooltip({ kind: "anchor", anchor, preferSide: true }, { width: 250, height: 100 }, viewport, { placement: "right", offset: 30 });
    expect(wide.left).toBe(140);
    const below = placeHeatmapTooltip(anchor, { width: 120, height: 60 }, viewport, { placement: "bottom", offset: 25 });
    expect(below.top).toBe(205);
  });

  it("keeps every side inside narrow, offset, small and scrolled visual viewports for every target and option", () => {
    const placements: TooltipPlacement[] = ["auto", "top", "right", "bottom", "left"];
    const targets: TooltipTarget[] = [];
    const widget = { left: 60, right: 520, top: 80, bottom: 600 };
    for (const x of [-100, 60, 260, 520, 2000]) for (const y of [-100, 80, 300, 600, 2000]) {
      targets.push(pointer(x, y), { kind: "anchor", anchor: point(x, y), preferSide: true }, { kind: "anchor", anchor: point(x, y) });
      targets.push({ kind: "outside", anchor: point(x, y), widget });
    }
    const viewports: TooltipViewport[] = [viewport, { width: 320, height: 240 }, { left: 73, top: 115, width: 275, height: 190 }];
    for (const current of viewports) {
      for (const placement of placements) for (const offset of [0, 40]) for (const maxWidth of [undefined, 220, 640]) for (const maxHeight of [undefined, 160, 800]) {
        const options = { placement, offset, maxWidth, maxHeight };
        const left = (current.left ?? 0) + 12, top = (current.top ?? 0) + 12;
        const right = (current.left ?? 0) + current.width - 12, bottom = (current.top ?? 0) + current.height - 12;
        for (const target of targets) {
          // A pointer preview only exists over its anchor, so its point lies inside the viewport.
          if (target.kind === "pointer" && (target.point.x < left || target.point.x > right || target.point.y < top || target.point.y > bottom)) continue;
          const limit = tooltipLimit(target, current, options);
          const size = { width: Math.min(640, limit.width), height: Math.min(800, limit.height) };
          const result = placeTooltip(target, size, current, options);
          const height = Math.min(size.height, result.maxHeight ?? size.height);
          expect(Object.values(result).filter(value => typeof value === "number").every(Number.isFinite)).toBe(true);
          expect(result.left).toBeGreaterThanOrEqual(left - 1e-9);
          expect(result.top).toBeGreaterThanOrEqual(top - 1e-9);
          expect(result.left + size.width).toBeLessThanOrEqual(right + 1e-9);
          expect(result.top + height).toBeLessThanOrEqual(bottom + 1e-9);
        }
      }
    }
  }, 30_000);

  it("reserves a scrollable region below or above a pointer when neither side fits", () => {
    const result = placeTooltip(pointer(150, 85), { width: 292, height: 560 }, { width: 320, height: 260 });
    expect(result.placement).toBe("pointer-bottom-right");
    expect(result.top).toBe(101);
    expect(result.maxHeight).toBe(147);
  });

  it("clamps a requested size to the visual viewport, and keeps an unset size at its default", () => {
    const small = { left: 80, top: 40, width: 300, height: 200 };
    expect(tooltipLimit(pointer(100, 100), small, { maxWidth: 330, maxHeight: 560 })).toEqual({ width: 276, height: 176 });
    expect(tooltipLimit(pointer(100, 100), small, { maxWidth: 900, maxHeight: 2000 })).toEqual({ width: 276, height: 176 });
    expect(tooltipLimit(pointer(100, 100), viewport, {})).toEqual({ width: 976, height: 560 });
    expect(tooltipLimit(pointer(100, 100), viewport, { maxWidth: 220, maxHeight: 160 })).toEqual({ width: 220, height: 160 });
  });

  it("limits an outside inspector to a requested maximum width within the space beside its widget", () => {
    const outside = { kind: "outside" as const, anchor: point(300, 220), widget: { left: 100, right: 600, top: 100, bottom: 400 } };
    expect(tooltipLimit(outside, viewport, {})).toEqual({ width: 330, height: 560 });
    expect(tooltipLimit(outside, viewport, { maxWidth: 260 })).toEqual({ width: 260, height: 560 });
    // Free space beside the widget (378px here) still limits a larger request.
    expect(tooltipLimit(outside, viewport, { maxWidth: 500 })).toEqual({ width: 378, height: 560 });
    expect(placeTooltip(outside, { width: 260, height: 250 }, viewport, { maxHeight: 180 }).maxHeight).toBeLessThanOrEqual(180);
  });
});

describe("tooltip settings", () => {
  it("reads valid settings, clamps the gap, and drops invalid values so the defaults apply", () => {
    expect(readTooltipPlacement({ tooltipPlacement: "left", tooltipOffset: 99, tooltipMaxWidth: 420, tooltipMaxHeight: 240 }))
      .toEqual({ placement: "left", offset: 40, maxWidth: 420, maxHeight: 240 });
    expect(readTooltipPlacement({ tooltipPlacement: "auto", tooltipOffset: -4 })).toEqual({ placement: "auto", offset: 0 });
    expect(readTooltipPlacement({ tooltipPlacement: "fixed-card", tooltipOffset: Number.NaN, tooltipMaxWidth: -5, tooltipMaxHeight: Number.POSITIVE_INFINITY })).toEqual({});
    expect(readTooltipPlacement(undefined)).toEqual({});
    expect(readTooltipPlacement({ showTooltip: true })).toEqual({});
  });
});

describe("pointer previews avoid tooltip controls", () => {
  it("keeps a low pointer's preview tall by stopping it under the header and toolbar, not squeezing it below", () => {
    // Service Pulse at 1512x900: the pointer sits low on the plot, under a header and a toolbar that both weigh 8.
    const viewport = { width: 1512, height: 900, left: 0, top: 0 };
    const size = { width: 330, height: 495 };
    const header = { left: 0, right: 1512, top: 0, bottom: 120, weight: 8 };
    const toolbar = { left: 0, right: 1512, top: 120, bottom: 170, weight: 8 };
    const pointer = { kind: "pointer" as const, point: { x: 700, y: 650 } };
    const placed = placePointerAvoiding(pointer, size, viewport, [header, toolbar], {});
    const visible = Math.min(size.height, placed.maxHeight ?? size.height);
    // Below the pointer only 222 px is free, which squeezes the reading. Above the pointer 448 px is free, below the toolbar.
    expect(visible).toBeGreaterThanOrEqual(400);
    expect(placed.top).toBeGreaterThanOrEqual(170);
    expect(placed.top + visible).toBeLessThanOrEqual(650);
  });

  it("keeps a full-height preview when a tall header leaves a free band beside the low pointer", () => {
    // The header and the strip below it take the top 300 px. Above the pointer only 318 px is clear, below it 222 px,
    // but the 572 px band between the strip and the viewport bottom fits the full 495 px panel.
    const viewport = { width: 1512, height: 900, left: 0, top: 0 };
    const size = { width: 330, height: 495 };
    const header = { left: 0, right: 1512, top: 0, bottom: 250, weight: 8 };
    const strip = { left: 0, right: 1512, top: 250, bottom: 300, weight: 8 };
    const pointer = { kind: "pointer" as const, point: { x: 700, y: 650 } };
    const placed = placePointerAvoiding(pointer, size, viewport, [header, strip], {});
    expect(Math.min(size.height, placed.maxHeight ?? size.height)).toBe(size.height);
    expect(placed.top).toBeGreaterThanOrEqual(strip.bottom);
    expect(placed.top + size.height).toBeLessThanOrEqual(viewport.height - 12);
    expect(placed.placement).toBe("pointer-band-right");
  });

  it("moves a pointer preview off the attention strip, and keeps the first candidate when nothing clears it", () => {
    const viewport = { width: 1000, height: 700, left: 0, top: 0 };
    const size = { width: 300, height: 200 };
    // A strip (weight 8) where the default below-the-pointer slot lands.
    const strip = { left: 400, right: 1000, top: 160, bottom: 400, weight: 8 };
    const pointer = { kind: "pointer" as const, point: { x: 500, y: 150 } };
    const plain = placeTooltip(pointer, size, viewport);
    expect(plain.top).toBeLessThan(strip.bottom);
    expect(plain.top + size.height).toBeGreaterThan(strip.top);
    const avoided = placePointerAvoiding(pointer, size, viewport, [strip], {});
    const avoidedHeight = Math.min(size.height, avoided.maxHeight ?? size.height);
    expect(avoided.top + avoidedHeight <= strip.top || avoided.top >= strip.bottom || avoided.left + size.width <= strip.left || avoided.left >= strip.right).toBe(true);
    // With the strip covering the whole viewport there is no clear placement, so the first candidate wins.
    const everywhere = { left: 0, right: 1000, top: 0, bottom: 700, weight: 8 };
    expect(placePointerAvoiding(pointer, size, viewport, [everywhere], {})).toEqual(placeTooltip(pointer, size, viewport, { placement: "auto" }));
  });
});
