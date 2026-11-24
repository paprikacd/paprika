import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

// The row pitch (74 standard, 29 dense) and the gap pairs belong to grid-geometry.ts. A copy elsewhere drifts silently.
it("keeps the grid arithmetic in grid-geometry.ts", () => {
  const root = join(process.cwd(), "src/features/insights");
  const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testdata" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) && entry.name !== "grid-geometry.ts" ? [path] : [];
  });
  const forbidden = [/[*/] ?(74|29)\b/, /\+ ?(16|4)\) ?\/ ?(74|29)/, /\[(16, ?16|8, ?4)\]/, /rowHeight: ?(58|25)\b/];
  const offenders = sources(root).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${path.slice(root.length + 1)}: ${pattern}`);
  });
  expect(offenders).toEqual([]);
});
