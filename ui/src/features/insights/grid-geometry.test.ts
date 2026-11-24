import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DENSE_GRID, STANDARD_GRID, columnWidth, gridOf, pixelsToRows, rowsToPixels } from "./grid-geometry";

it("converts row units to pixels with the trailing gap removed", () => {
  expect(rowsToPixels(2)).toBe(132);
  expect(rowsToPixels(1, true)).toBe(25);
  expect(rowsToPixels(3, true)).toBe(83);
  expect(rowsToPixels(2)).toBe(2 * 74 - 16);
});

it("rounds pixel heights up to whole rows", () => {
  expect(pixelsToRows(0)).toBe(1);
  expect(pixelsToRows(132)).toBe(2);
  expect(pixelsToRows(133)).toBe(3);
  expect(pixelsToRows(25, true)).toBe(1);
  expect(pixelsToRows(26, true)).toBe(2);
});

it("returns the dense or standard geometry", () => {
  expect(gridOf(false)).toBe(STANDARD_GRID);
  expect(gridOf(true)).toBe(DENSE_GRID);
});

it("computes column width from the gap", () => {
  expect(columnWidth(1200)).toBeCloseTo((1200 - 11 * 16) / 12);
  expect(columnWidth(1200, true)).toBeCloseTo((1200 - 11 * 8) / 12);
});

it("keeps the stacked view gap in step with the standard row gap", () => {
  const css = readFileSync(join(process.cwd(), "src/features/insights/insights.module.css"), "utf8");
  const rule = /\.stackedView\s*\{([^}]*)\}/.exec(css);
  expect(rule).not.toBeNull();
  expect(rule![1]).toContain(`gap: ${STANDARD_GRID.gapY}px`);
});
