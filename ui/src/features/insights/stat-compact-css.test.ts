import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const sparkline = readFileSync(join(process.cwd(), "src/features/insights/stat-sparkline.module.css"), "utf8");
const shell = readFileSync(join(process.cwd(), "src/features/insights/insights.module.css"), "utf8");
const charts = readFileSync(join(process.cwd(), "src/features/insights/charts.module.css"), "utf8");

it("reserves the full two-row KPI body for an adequately sized number and sparkline", () => {
  expect(charts).toContain("font-size: clamp(26px, 7cqw, 38px)");
  expect(charts).toContain('.stat:where(:not(.embeddedStat)):has([data-sparkline-placement="side"]) .statValue');
  expect(charts).toContain('.stat.stat .statValue { font-size: clamp(16px, 8cqw, 21px);');
  // Do not enlarge readonly embedded single-value widgets inside tooltips.
  expect(sparkline).toContain("height: clamp(36px, 82%, 68px)");
  expect(sparkline).toContain(".withSparkline[data-sparkline-placement=\"side\"] .plot");
  // Keep small one-track and phone-intrinsic layouts separate.
  expect(sparkline).toContain(".withSparkline[data-sparkline-placement=\"side\"] .plot { height: min(100%, 28px); }");
  expect(sparkline).toContain("height: 40px");
});

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

it("fits the one-track reading target without adding vertical padding or suppressing overflow", () => {
  const compact = sparkline.slice(sparkline.lastIndexOf("@container insight-widget (max-height: 40px)"), sparkline.indexOf("/* Static decorative"));
  expect(compact).toContain("padding: 0 12px 0 var(--stat-reading-inset, 0px)");
  expect(compact).toContain("min-height: 26px");
  expect(compact).not.toMatch(/overflow:\s*(hidden|clip)/);
  expect(charts).toContain(".stat.stat { gap: 0; overflow: auto; }");
});

it("allocates a full reading lane inside compact desktop one-track cards", () => {
  const header = shell.match(/\.root\[data-compact-shell\] \.tile\[data-compact-stat="true"\] \.tileHeader\s*\{([^}]+)\}/)?.[1];
  expect(header).toContain("min-height: 23px");
  expect(header).toContain("padding-top: 4px");
  expect(header).not.toContain("font-size");
  expect(header).not.toContain("overflow");
});
