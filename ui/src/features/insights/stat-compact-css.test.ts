import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const sparkline = readFileSync(join(process.cwd(), "src/features/insights/stat-sparkline.module.css"), "utf8");
const charts = readFileSync(join(process.cwd(), "src/features/insights/charts.module.css"), "utf8");

it("separates compact history without changing the authored background rule at larger heights", () => {
  const compact = sparkline.slice(sparkline.lastIndexOf("@container insight-widget (max-height: 40px)"));
  expect(compact).toContain("grid-template-columns: minmax(0, auto) minmax(28px, 1fr)");
  expect(compact).toContain("position: static");
  expect(compact).toContain("mask-image: none");
  expect(compact).toContain("min-height: 26px");
  expect(sparkline.slice(0, sparkline.indexOf("@container"))).toContain("position: absolute");
  expect(charts).toContain(".stat.stat { gap: 0; overflow: auto; }");
});

it("does not center compact empty or failed-query messages below the clipped body", () => {
  const compact = charts.slice(charts.lastIndexOf("@container insight-widget (max-height: 40px)"));
  expect(compact).toContain("min-height: 0");
  expect(compact).toContain("justify-content: flex-start");
  expect(compact).toContain("overflow: auto");
  expect(compact).toContain(".state > * { flex-shrink: 0; }");
});
