import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { RecordMatrix, RecordTable } from "./plugins/records";
import { TraceFetcherProvider, TraceWaterfall } from "./trace-waterfall";
import { formatMetric } from "./units";
import type { QueryResult, Widget } from "./schema";

// Rendered surfaces never show float noise, and with decimals set every reading has exactly that many places.
// Attributes count too: a screen reader reads aria-label, aria-valuetext and title.
afterEach(() => { document.body.innerHTML = ""; });

const layout = { x: 0, y: 0, w: 6, h: 4 };
const DECIMALS: (number | undefined)[] = [undefined, 0, 2];
// Float noise (5.878749999999975), a 15-digit byte count (scaled in readings), and a classic sum (0.1 + 0.2).
const values: { name: string; value: number; unit: string }[] = [
  { name: "noisy", value: 5.878749999999975, unit: "ms" },
  { name: "bytes", value: 296303060975000, unit: "bytes" },
  { name: "sum", value: 0.1 + 0.2, unit: "" },
];
const series = (value: number) => ({ series: [{ name: "latency", labels: { service: "api" }, points: [{ timestamp: Date.UTC(2026, 0, 1), value }] }] }) as QueryResult;
const widget = (type: Widget["type"], unit: string, decimals?: number): Widget => ({ id: "w", title: "Latency", type, providerId: "metrics", query: "latency", unit, layout, options: decimals === undefined ? {} : { decimals } });

// Visible text, plus the accessible names and titles a reader announces. Machine values in data-* attributes are not
// display text, and the exact value in a collapsed "Source details" block is shown only when asked for (it may group digits).
function visibleText(root: HTMLElement) {
  // The "Exact value" row is the one place a reading is printed unrounded (12 significant digits, grouped), so it is exempt.
  const exactRows = [...root.querySelectorAll("*")].filter(element => element.children.length === 0 && element.textContent?.trim() === "Exact value").map(element => element.parentElement).filter((row): row is HTMLElement => row !== null);
  const hidden = (element: Element | null) => element?.closest("details:not([open]),[hidden]") != null || (element !== null && exactRows.some(row => row.contains(element)));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!hidden(node.parentElement)) parts.push(node.textContent ?? "");
  const names = [...root.querySelectorAll("[aria-label],[aria-valuetext],[title]")].filter(element => !hidden(element)).flatMap(element => ["aria-label", "aria-valuetext", "title"].map(name => element.getAttribute(name) ?? ""));
  // A title that starts "Exact value" is the deliberate exact view (12 significant digits, grouped): exempt like the row.
  return [...parts, ...names.filter(name => !name.startsWith("Exact value"))].join(" ");
}
// Whitespace is not part of a reading: "5.88ms" and "5.88 ms" are the same text.
const squash = (text: string) => text.replace(/\s+/g, "");
function expectNoNoise(text: string) {
  expect(text).not.toMatch(/\d\.\d{6,}/);
  // Digit grouping is removed first, so a 15-digit run is caught whether or not it is grouped.
  expect(text.replace(/(?<=\d),(?=\d{3})/g, "")).not.toMatch(/\d{15,}/);
}

describe("every rendered reading honours decimals and hides float noise", () => {
  for (const decimals of DECIMALS) {
    for (const { name, value, unit } of values) {
      it(`stat shows ${name} as formatted at ${decimals ?? "Auto"}`, () => {
        const { container } = render(<WidgetVisualization widget={widget("stat", unit, decimals)} result={series(value)} />);
        const text = visibleText(container);
        expectNoNoise(text);
        // The reading itself: exactly the places the setting asks for, after the unit is scaled.
        expect(squash(text)).toContain(squash(formatMetric(value, unit, false, decimals)));
      });
      it(`built-in heatmap shows ${name} without noise at ${decimals ?? "Auto"}`, () => {
        const { container } = render(<WidgetVisualization widget={widget("heatmap", unit, decimals)} result={series(value)} />);
        expectNoNoise(visibleText(container));
      });
    }
    // Record surfaces keep one unit per column, so they take the noisy and sum values in their authored unit.
    for (const { name, value, unit } of values.filter(entry => entry.unit !== "bytes")) {
      it(`record table shows ${name} without noise at ${decimals ?? "Auto"}`, () => {
        const { container } = render(<RecordTable widget={{ ...widget("plugin", unit, decimals), pluginId: "record-table" } as Widget} result={{ records: { columns: [{ key: "latency", type: "number", unit }], rows: [[value]], truncated: false } }} />);
        const text = visibleText(container);
        expectNoNoise(text);
        expect(squash(text)).toContain(squash(formatMetric(value, unit, false, decimals)));
      });
      it(`record matrix shows ${name} without noise at ${decimals ?? "Auto"}`, () => {
        const { container } = render(<RecordMatrix widget={{ ...widget("plugin", unit, decimals), pluginId: "record-matrix", config: { x: "x", y: "y", value: "latency" } } as Widget} result={{ records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "latency", type: "number", unit }], rows: [[1, "a", value]], truncated: false } }} />);
        expectNoNoise(visibleText(container));
      });
    }
    it(`record table keeps an identifier as stored at ${decimals ?? "Auto"}`, () => {
      const { container } = render(<RecordTable widget={{ ...widget("plugin", "", decimals), pluginId: "record-table" } as Widget} result={{ records: { columns: [{ key: "order_id", type: "number" }], rows: [[296303060975000]], truncated: false } }} />);
      // An identifier is its stored digits, so the 15-digit value is the reading here; only float noise is ruled out.
      const text = visibleText(container);
      expect(text).toContain("296303060975000");
      expect(text).not.toMatch(/\d\.\d{6,}/);
    });
    it(`trace waterfall prints durations at ${decimals ?? "Auto"} with no noise`, async () => {
      const spans = [{ spanId: "root", service: "api", operation: "GET", startTime: 1000, durationMs: 5.878749999999975, status: "ok" }];
      const { container, findByRole, unmount } = render(<TraceFetcherProvider fetchTrace={async () => ({ spans })}><TraceWaterfall traceId="abc" decimals={decimals} /></TraceFetcherProvider>);
      await findByRole("region", { name: "Trace abc waterfall" });
      const text = visibleText(container);
      expectNoNoise(text);
      expect(squash(text)).toContain(squash(`${(5.878749999999975).toFixed(decimals ?? 2)} ms`));
      unmount();
    });
  }
});
