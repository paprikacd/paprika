import { verticalCompactor, type Layout } from "react-grid-layout/core";
import { describe, expect, it } from "vitest";
import {
  dragLayout,
  dragSettle,
  layoutMoveBlockers,
  layoutMoveForKey,
  layoutResizeForKey,
  moveLayout,
  resizeLayout,
  type LayoutEdit,
} from "./layout-edit";

const item = (i: string, x: number, y: number, w: number, h: number, extra: Record<string, number> = {}) => ({ i, x, y, w, h, ...extra });
const boxes = (layout: Layout) => Object.fromEntries(layout.map(({ i, x, y, w, h }) => [i, [x, y, w, h]]));
const settled = (edit: LayoutEdit): Layout => {
  if (!("layout" in edit)) throw new Error(edit.blocked);
  return edit.layout;
};
const overlaps = (a: Layout[number], b: Layout[number]) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// The first pair of widgets that overlap, as ids, or undefined. One assertion per layout keeps the property test fast.
const firstOverlap = (layout: Layout) => {
  for (let p = 0; p < layout.length; p++) {
    for (let q = p + 1; q < layout.length; q++) if (overlaps(layout[p], layout[q])) return [layout[p].i, layout[q].i];
  }
  return undefined;
};

// Two widgets stacked in the left columns, a tall one on the right.
const stacked = [item("a", 0, 0, 6, 4), item("b", 0, 4, 6, 4), item("c", 6, 0, 6, 8)];

describe("moving a widget within its column flow", () => {
  it("swaps with the widget below in its columns, and the swap survives compaction", () => {
    const next = settled(moveLayout(stacked, "a", "down"));
    expect(boxes(next)).toEqual({ a: [0, 4, 6, 4], b: [0, 0, 6, 4], c: [6, 0, 6, 8] });
    expect(boxes(verticalCompactor.compact(next, 12))).toEqual(boxes(next));
  });

  it("mirrors the swap when the widget below moves up past the widget above", () => {
    const swapped = settled(moveLayout(stacked, "a", "down"));
    expect(boxes(settled(moveLayout(swapped, "a", "up")))).toEqual(boxes(stacked));
  });

  it("names the widget it swapped with", () => {
    expect(moveLayout(stacked, "a", "down")).toMatchObject({ partner: "b" });
  });

  it("disables a downward move when no widget below shares its columns", () => {
    const beside = [item("a", 0, 0, 6, 4), item("d", 6, 4, 6, 4)];
    expect(moveLayout(beside, "a", "down")).toEqual({ blocked: "Nothing below this widget in its columns" });
  });

  it("disables an upward move at the top of its columns", () => {
    expect(moveLayout(stacked, "a", "up")).toEqual({ blocked: "Nothing above this widget in its columns" });
  });

  it("stops left and right moves at the canvas edges and moves one column otherwise", () => {
    expect(moveLayout([item("a", 0, 0, 6, 4)], "a", "left")).toEqual({ blocked: "Already at the left edge of the canvas" });
    expect(moveLayout([item("a", 6, 0, 6, 4)], "a", "right")).toEqual({ blocked: "Already at the right edge of the canvas" });
    expect(boxes(settled(moveLayout([item("a", 6, 0, 6, 4)], "a", "left")))).toEqual({ a: [5, 0, 6, 4] });
  });

  it("explains every Layout-tab move on the narrow canvas and only the real blockers on the wide one", () => {
    const widgets = stacked.map(({ i, x, y, w, h }) => ({ id: i, layout: { x, y, w, h } }));
    const reason = "Layout moves need the wide canvas, where the saved grid is shown";
    expect(layoutMoveBlockers(widgets, "a", "compact")).toEqual({ left: reason, right: reason, up: reason, down: reason });
    expect(layoutMoveBlockers(widgets, "a", "wide")).toEqual({
      left: "Already at the left edge of the canvas",
      up: "Nothing above this widget in its columns",
    });
  });
});

describe("moving past a band of widgets", () => {
  const noOverlaps = (layout: Layout) => layout.every((a, index) => layout.slice(index + 1).every((b) => !overlaps(a, b)));
  // A full-width widget above a row of four stats, with a chart below the row.
  const row = [
    item("a", 0, 0, 12, 4),
    item("s1", 0, 4, 3, 2), item("s2", 3, 4, 3, 2), item("s3", 6, 4, 3, 2), item("s4", 9, 4, 3, 2),
    item("b", 0, 6, 12, 4),
  ];

  it("moves the whole row past a full-width widget, so the stats never split and leave no hole", () => {
    const edit = moveLayout(row, "a", "down");
    expect(edit).toMatchObject({ partner: "s1", passed: ["s1", "s2", "s3", "s4"] });
    const next = settled(edit);
    expect(boxes(next)).toEqual({ a: [0, 2, 12, 4], s1: [0, 0, 3, 2], s2: [3, 0, 3, 2], s3: [6, 0, 3, 2], s4: [9, 0, 3, 2], b: [0, 6, 12, 4] });
    expect(noOverlaps(next)).toBe(true);
    for (const top of [0, 1]) {
      expect(next.filter((entry) => entry.y <= top && top < entry.y + entry.h).reduce((columns, entry) => columns + entry.w, 0)).toBe(12);
    }
  });

  it("moves the row back to its original layout when the widget moves up again", () => {
    const swapped = settled(moveLayout(row, "a", "down"));
    const edit = moveLayout(swapped, "a", "up");
    expect(edit).toMatchObject({ partner: "s4", passed: ["s1", "s2", "s3", "s4"] });
    expect(boxes(settled(edit))).toEqual(boxes(row));
  });

  it("moves widgets of different heights in the band together", () => {
    const mixed = [item("a", 0, 0, 12, 4), item("s", 0, 4, 3, 2), item("t", 3, 4, 9, 6)];
    const edit = moveLayout(mixed, "a", "down");
    expect(edit).toMatchObject({ partner: "s", passed: ["s", "t"] });
    const next = settled(edit);
    expect(boxes(next)).toEqual({ a: [0, 6, 12, 4], s: [0, 0, 3, 2], t: [3, 0, 9, 6] });
    expect(noOverlaps(next)).toBe(true);
  });

  it("passes only the partner when nothing else shares its band", () => {
    expect(moveLayout(stacked, "a", "down")).toMatchObject({ partner: "b", passed: ["b"] });
  });
});

describe("dragging past another widget", () => {
  const pair = [item("a", 0, 0, 6, 4), item("b", 0, 4, 6, 4)];

  it("swaps once the dragged top edge reaches the midpoint of the widget below", () => {
    expect(boxes(dragLayout(pair, "a", { x: 0, y: 6, w: 6, h: 4 }))).toEqual({ a: [0, 4, 6, 4], b: [0, 0, 6, 4] });
  });

  it("keeps the saved order while the midpoint has not been reached", () => {
    expect(boxes(dragLayout(pair, "a", { x: 0, y: 5, w: 6, h: 4 }))).toEqual({ a: [0, 0, 6, 4], b: [0, 4, 6, 4] });
  });

  it("drops below the whole stack by swapping past the widget and compacting upward", () => {
    expect(boxes(dragLayout(pair, "a", { x: 0, y: 30, w: 6, h: 4 }))).toEqual({ a: [0, 4, 6, 4], b: [0, 0, 6, 4] });
  });

  it("drops into empty columns and compacts to the top", () => {
    expect(boxes(dragLayout(pair, "a", { x: 6, y: 30, w: 6, h: 4 }))).toEqual({ a: [6, 0, 6, 4], b: [0, 0, 6, 4] });
  });

  it("swaps back when a widget is dragged up past the midpoint of the widget above", () => {
    const lower = [item("b", 0, 0, 6, 4), item("a", 0, 4, 6, 4)];
    expect(boxes(dragLayout(lower, "a", { x: 0, y: 2, w: 6, h: 4 }))).toEqual({ a: [0, 0, 6, 4], b: [0, 4, 6, 4] });
  });

  it("applies the settled layout to the grid's own items and keeps their size limits", () => {
    const items = [item("a", 0, 6, 6, 4, { minH: 2 }), item("b", 0, 4, 6, 4)];
    expect(dragSettle(pair, items, "a")).toEqual([
      { i: "a", x: 0, y: 4, w: 6, h: 4, minH: 2, moved: false },
      { i: "b", x: 0, y: 0, w: 6, h: 4, moved: false },
    ]);
  });
});

describe("keyboard keys and resizing", () => {
  it("maps Alt+Arrow to a move and Alt+Shift+Arrow to a one-step resize", () => {
    expect(layoutMoveForKey("ArrowDown")).toBe("down");
    expect(layoutMoveForKey("Enter")).toBeUndefined();
    expect(layoutResizeForKey("ArrowLeft")).toEqual([-1, 0]);
    expect(layoutResizeForKey("ArrowUp")).toEqual([0, -1]);
  });

  it("grows a widget and pushes the widget below it down", () => {
    expect(boxes(settled(resizeLayout(stacked.slice(0, 2), "a", 0, 1)))).toEqual({ a: [0, 0, 6, 5], b: [0, 5, 6, 4] });
  });

  it("explains why a resize is blocked at the edge, the minimum and the maximum", () => {
    expect(resizeLayout([item("a", 6, 0, 6, 4)], "a", 1, 0)).toEqual({ blocked: "Already reaches the right edge of the canvas" });
    expect(resizeLayout([item("a", 0, 0, 1, 4)], "a", -1, 0)).toEqual({ blocked: "Already at the minimum width of 1 column" });
    expect(resizeLayout([item("a", 0, 0, 6, 2, { minH: 2 })], "a", 0, -1)).toEqual({ blocked: "Already at the minimum height of 2 rows" });
    expect(resizeLayout([item("a", 0, 0, 6, 12, { maxH: 12 })], "a", 0, 1)).toEqual({ blocked: "Already at the maximum height of 12 rows" });
  });
});

describe("settled layouts", () => {
  // A small deterministic generator so the property checks are repeatable.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("keeps every move, resize and drag overlap-free and stable under the vertical compactor, and resizes change only their widget", () => {
    const next = random(20261102);
    const between = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
    let changedMoves = 0;
    let changedResizes = 0;
    let changedDrags = 0;
    for (let trial = 0; trial < 150; trial++) {
      const count = between(2, 9);
      const drawn: Layout = Array.from({ length: count }, (_, index) => {
        const w = between(1, 12);
        return item(`w${index}`, between(0, 12 - w), between(0, 12), w, between(2, 4));
      });
      const layout = verticalCompactor.compact(drawn, 12);
      for (const subject of layout) {
        for (const move of ["up", "down", "left", "right"] as const) {
          const edit = moveLayout(layout, subject.i, move);
          if (!("layout" in edit)) continue;
          const after = edit.layout.find((entry) => entry.i === subject.i)!;
          expect(after.w).toBe(subject.w);
          expect(after.h).toBe(subject.h);
          expect(firstOverlap(edit.layout)).toBeUndefined();
          expect(boxes(verticalCompactor.compact(edit.layout, 12))).toEqual(boxes(edit.layout));
          if (JSON.stringify(boxes(edit.layout)) !== JSON.stringify(boxes(layout))) changedMoves++;
        }
        // Each one-step resize in turn, then one random step that may be larger.
        for (const [dw, dh] of [[1, 0], [-1, 0], [0, 1], [0, -1], [between(-2, 2), between(-2, 2)]] as const) {
          const edit = resizeLayout(layout, subject.i, dw, dh);
          if (!("layout" in edit)) continue;
          const after = edit.layout.find((entry) => entry.i === subject.i)!;
          expect(after.w).toBe(subject.w + dw);
          expect(after.h).toBe(subject.h + dh);
          for (const entry of layout) {
            if (entry.i === subject.i) continue;
            const kept = edit.layout.find((other) => other.i === entry.i)!;
            expect([kept.w, kept.h]).toEqual([entry.w, entry.h]);
          }
          expect(firstOverlap(edit.layout)).toBeUndefined();
          expect(boxes(verticalCompactor.compact(edit.layout, 12))).toEqual(boxes(edit.layout));
          if (JSON.stringify(boxes(edit.layout)) !== JSON.stringify(boxes(layout))) changedResizes++;
        }
        const target = { x: between(0, 11), y: between(0, 12), w: subject.w, h: subject.h };
        if (target.x + target.w > 12) continue;
        const dragged = dragLayout(layout, subject.i, target);
        expect(firstOverlap(dragged)).toBeUndefined();
        expect(boxes(verticalCompactor.compact(dragged, 12))).toEqual(boxes(dragged));
        if (JSON.stringify(boxes(dragged)) !== JSON.stringify(boxes(layout))) changedDrags++;
      }
    }
    // The property is only meaningful if many edits really reorder, move or resize widgets.
    expect(changedMoves).toBeGreaterThan(150);
    expect(changedResizes).toBeGreaterThan(150);
    expect(changedDrags).toBeGreaterThan(150);
  });
});
