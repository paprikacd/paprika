import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import type { QueryResult, Widget } from "./schema";
import { WidgetLoadingPlaceholder, WidgetLoadingProvider, widgetLoadingFamily } from "./widget-loading";

const timeseries: Widget = { id: "cpu", title: "CPU", type: "timeseries", providerId: "p", query: "up", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } };
const result: QueryResult = { series: [{ name: "cpu", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] }] };

// jsdom reports a hidden page by default, so each test states the visibility it depends on.
let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

describe("loading placeholder families", () => {
  it("chooses the shape a widget will draw from its type or plugin", () => {
    const family = (type: Widget["type"], pluginId?: string) => widgetLoadingFamily({ type, pluginId });
    expect(family("timeseries")).toBe("line");
    expect(family("stat")).toBe("line");
    expect(family("bar")).toBe("bar");
    expect(family("table")).toBe("table");
    expect(family("traces")).toBe("table");
    expect(family("heatmap")).toBe("matrix");
    expect(family("plugin", "status-grid")).toBe("matrix");
    expect(family("plugin", "incident-calendar")).toBe("matrix");
    expect(family("plugin", "connection-map")).toBe("topology");
    expect(family("plugin", "pipeline-topology")).toBe("topology");
    expect(family("plugin", "threshold-gauge")).toBe("bar");
    expect(family("plugin", "record-table")).toBe("table");
    expect(family("plugin", "stacked-timeseries")).toBe("line");
  });
});

describe("initial load", () => {
  it("shows a family-shaped placeholder inside a busy frame, with one status for the whole load", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} loading />);
    expect(container.querySelector("[data-widget-state-frame]")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("[data-loading-family]")).toHaveAttribute("data-loading-family", "line");
    expect(screen.getByRole("status", { name: "Loading widget" })).toHaveTextContent("Querying data source…");
  });

  it("keeps the placeholder out of the accessibility tree and out of the focus order", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} loading />);
    const placeholder = container.querySelector("[data-loading-family]") as HTMLElement;
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(placeholder.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")).toHaveLength(0);
    expect(placeholder.textContent).toBe("");
  });
});

describe("refresh", () => {
  it("keeps the last result visible, marks it busy, and adds no placeholder or announcement", () => {
    const { container, rerender } = render(<WidgetVisualization widget={timeseries} result={result} />);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    rerender(<WidgetVisualization widget={timeseries} result={result} loading />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector("[data-loading-family]")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading widget" })).toBeNull();
    expect(screen.queryByText("Querying data source…")).toBeNull();
  });
});

describe("motion", () => {
  it("pauses the placeholder while the page is hidden, and resumes when it is shown", () => {
    hidden = true;
    const { container } = render(<WidgetLoadingPlaceholder widget={timeseries} />);
    const placeholder = () => container.querySelector("[data-loading-family]");
    expect(placeholder()).toHaveAttribute("data-loading-motion", "paused");
    expect(placeholder()).not.toHaveAttribute("data-motion");
    hidden = false;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(placeholder()).toHaveAttribute("data-loading-motion", "auto");
  });

  it("stops the shimmer under reduced motion, whether from the operating system or a Gamma scope", () => {
    const css = readFileSync(join(process.cwd(), "src/features/insights/charts.module.css"), "utf8");
    // The placeholder's own state lives in data-loading-motion; data-motion is only the Gamma scope's reduced-motion preference.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.loadingPlaceholder\[data-loading-motion="auto"\] \{ animation: none; \}\s*\}/);
    expect(css).toContain(':is([data-motion="reduced"]) .loadingPlaceholder[data-loading-motion="auto"] { animation: none; }');
    expect(css).toContain('.loadingPlaceholder[data-loading-motion="paused"] { animation: none; }');
  });
});

describe("host presentation", () => {
  it("replaces the default initial placeholder when a host supplies one", () => {
    const { container } = render(
      <WidgetLoadingProvider render={({ phase }) => <p>{phase === "initial" ? "Host loading" : "Host refresh"}</p>}>
        <WidgetVisualization widget={timeseries} loading />
      </WidgetLoadingProvider>,
    );
    expect(screen.getByText("Host loading")).toBeInTheDocument();
    expect(container.querySelector("[data-loading-family]")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading widget" })).toBeNull();
  });

  it("shows a host refresh notice beside a result that stays visible", () => {
    const { container } = render(
      <WidgetLoadingProvider render={({ phase }) => <p>{phase === "initial" ? "Host loading" : "Host refresh"}</p>}>
        <WidgetVisualization widget={timeseries} result={result} loading />
      </WidgetLoadingProvider>,
    );
    expect(screen.getByText("Host refresh")).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector("[data-loading-family]")).toBeNull();
  });
});
