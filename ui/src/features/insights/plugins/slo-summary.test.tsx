import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { SloSummary, registerSloSummaryPlugin, rowsThatFit, shortRangeEnd } from "./slo-summary";
import { getWidgetDefinition, getWidgetPlugins } from "../widget-registry";
import { SLO_PERIODS, validateSloConfig } from "../slo";
import { SLO_DEFAULT_CONFIG } from "./slo-summary";

afterEach(cleanup);

const config = { objective: 99.9, period: "30d", total: "http_requests_total", bad: 'http_requests_total{code="500"}' };
const widgetWith = (overrides: Partial<Widget> = {}, decimals?: number): Widget => ({
  id: "slo", title: "Availability", type: "plugin", pluginId: "slo-summary", providerId: "metrics", query: "", unit: "%",
  layout: { x: 0, y: 0, w: 6, h: 3 }, config, options: decimals === undefined ? {} : { decimals }, ...overrides,
});

// Every window of the 30d multiwindow preset reads the same total and bad, labelled as the compiled query labels them.
// The newest sample is now, so a card reads its window as live. A test that needs an earlier range moves its samples back.
// Point timestamps are Unix milliseconds, as the provider stores them (providers.go multiplies the seconds by 1000).
const NOW = Date.now();
const WINDOWS = ["5m", "30m", "1h", "2h", "6h", "1d", "3d", "30d"];
function result(readings: Record<string, [number, number]>, labels: Record<string, string> = {}): QueryResult {
  const series: NonNullable<QueryResult["series"]> = [];
  for (const window of WINDOWS) {
    const [total, bad] = readings[window] ?? readings.default ?? [0, 0];
    for (const [part, value] of [["total", total], ["bad", bad]] as const) {
      series.push({ name: `${window}-${part}`, labels: { ...labels, slo_window: window, slo_part: part }, points: [{ timestamp: NOW, value }] });
    }
  }
  return { series };
}

describe("slo-summary renderer", () => {
  it("shows meeting with availability against the target and the budget", () => {
    const { container } = render(<SloSummary widget={widgetWith({}, 2)} result={result({ default: [1000, 0] })} />);
    const panel = container.querySelector("[data-slo-state]");
    expect(panel).toHaveAttribute("data-slo-state", "meeting");
    expect(screen.getByText("Meeting")).toBeInTheDocument();
    expect(container.querySelector("[data-slo-availability]")).toHaveTextContent("100.00%");
    expect(screen.getByText(/Objective 99\.9\d*%/)).toBeInTheDocument();
  });

  it("shows partial, never meeting, when a truncated services result may hide groups", () => {
    const groupedConfig = { ...config, groupBy: "service" };
    const a = result({ default: [1000, 0] }, { service: "a" });
    const b = result({ default: [1000, 0] }, { service: "b" });
    const { container } = render(
      <SloSummary widget={widgetWith({ config: groupedConfig })} result={{ series: [...(a.series ?? []), ...(b.series ?? [])], truncated: true }} />,
    );
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "partial");
    const header = container.querySelector("header");
    expect(header).toHaveTextContent("Partial");
    expect(header).not.toHaveTextContent("Meeting");
    expect(container).toHaveTextContent("Result truncated: some groups are not proven to meet the objective.");
  });

  it("names a group whose series lack the grouping label, rather than calling it all requests", () => {
    const groupedConfig = { ...config, groupBy: "service" };
    const named = result({ default: [1000, 0] }, { service: "a" });
    const unnamed = result({ default: [1000, 0] });
    const { container } = render(
      <SloSummary widget={widgetWith({ config: groupedConfig })} result={{ series: [...(named.series ?? []), ...(unnamed.series ?? [])] }} />,
    );
    const rows = [...container.querySelectorAll("tbody th")].map(cell => cell.textContent);
    expect(rows).toContain("(no service)");
    expect(rows).not.toContain("All requests");
  });

  it("keeps the 99.9 target distinct from a 100 availability", () => {
    const { container } = render(<SloSummary widget={widgetWith({}, 0)} result={result({ default: [1000, 0.5] })} />);
    expect(container.querySelector("[data-slo-availability]")).toHaveTextContent("99.95%");
    expect(screen.getByText(/Objective 99\.9\d*%/)).toBeInTheDocument();
  });

  it("shows an overspent budget as an empty track with the overflow cue and a signed reading", () => {
    const { container } = render(<SloSummary widget={widgetWith()} result={result({ "30d": [1000000, 2000], default: [1, 0] })} />);
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "breaching");
    const budget = container.querySelector("[data-slo-overspent]");
    expect(budget).not.toBeNull();
    expect(budget).toHaveTextContent("-100%");
    expect(budget).not.toHaveTextContent("0000");
    expect(screen.getByRole("img", { name: "Error budget remaining -100%" })).toBeInTheDocument();
  });

  it("keeps the sign of a small overspend at whole-number decimals", () => {
    // allowed = 1000 requests at 99.9%, so 1000.4 failures is an overspend of 0.04% of the budget.
    const { container } = render(<SloSummary widget={widgetWith({}, 0)} result={result({ "30d": [1000000, 1000.4], default: [1, 0] })} />);
    expect(container.querySelector("[data-slo-overspent]")).toHaveTextContent("-0.04%");
  });

  it("reads a burn rate below its factor below the factor, not as the factor itself", () => {
    // At one decimal the rate and its factor stay distinct; at zero decimals 0.6 reads as 1 by the widget's own decimals.
    render(<SloSummary widget={widgetWith({}, 1)} result={result({ "3d": [1000, 0.6], default: [1000, 0] })} />);
    const chip = screen.getByText("3d·6h").closest("li");
    expect(chip).toHaveAttribute("data-slo-severity", "warning");
    expect(chip).toHaveTextContent("0.6 × / 0.0 × of 1.0 ×");
    expect(chip).not.toHaveTextContent("1 × / 1 ×");
  });

  it("reads no traffic as no requests, never as 100%", () => {
    const { container } = render(<SloSummary widget={widgetWith()} result={result({ default: [0, 0] })} />);
    expect(screen.getByText("No requests in 30d")).toBeInTheDocument();
    expect(container.querySelector("[data-slo-availability]")).toBeNull();
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "unknown");
  });

  it("lists burn windows and marks the firing pair", () => {
    const readings = { ...Object.fromEntries(WINDOWS.map(w => [w, [1000, 0]])), "30d": [1000000, 500], "2h": [10000, 50], "1d": [100000, 500] } as Record<string, [number, number]>;
    const { container } = render(<SloSummary widget={widgetWith()} result={result(readings)} />);
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "at_risk");
    const chips = container.querySelectorAll("[data-slo-severity]");
    expect(chips).toHaveLength(4);
    expect(container.querySelector('[data-slo-severity="warning"][data-slo-firing]')).not.toBeNull();
    expect(container.querySelector('[data-slo-severity="critical"][data-slo-firing]')).toBeNull();
  });

  it("renders a services table sorted by the evaluation with the omitted groups disclosed", () => {
    const groupBy = { ...config, groupBy: "service" };
    const groups = ["a", "b", "c", "d", "e", "f", "g"].map((service, index) => result({ default: [1000, index === 0 ? 0 : 0] }, { service }).series!);
    const series = groups.flat();
    const widget = widgetWith({ config: { ...groupBy, maxRows: 3 } });
    render(<SloSummary widget={widget} result={{ series }} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Showing 3 of 7 groups; 4 more groups not shown")).toBeInTheDocument();
  });

  it("keeps Auto budget readings below 100 from rounding up to 100", () => {
    // 1000000 requests allow 1000 failures at 99.9%. 0.4 failures leave 99.96% of the budget.
    const { container } = render(<SloSummary widget={widgetWith()} result={result({ "30d": [1000000, 0.4], default: [1, 0] })} />);
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "meeting");
    expect(screen.getByRole("img", { name: "Error budget remaining 99.96%" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("100.0%");
  });

  it("says a truncated result proves nothing rather than no requests", () => {
    // One window's bad series was dropped, so the group is incomplete and cannot prove meeting.
    const full = result({ default: [1000, 0] });
    const truncated = { ...full, series: full.series?.filter(series => !(series.labels.slo_window === "1h" && series.labels.slo_part === "bad")), truncated: true };
    render(<SloSummary widget={widgetWith()} result={truncated} />);
    expect(screen.getByText("Result truncated; objective not proven")).toBeInTheDocument();
    expect(screen.queryByText(/No requests/)).toBeNull();
  });

  it("keeps a complete group meeting in a truncated result and says the result is truncated", () => {
    const { container } = render(<SloSummary widget={widgetWith()} result={{ ...result({ default: [1000, 0] }), truncated: true }} />);
    expect(container.querySelector("[data-slo-state]")).toHaveAttribute("data-slo-state", "meeting");
    expect(screen.getByText("Result truncated: the series may be incomplete.")).toBeInTheDocument();
  });

  it("names a missing error series as missing, not as no requests", () => {
    const totalOnly: QueryResult = { series: WINDOWS.map((window) => ({ name: window, labels: { slo_window: window, slo_part: "total" }, points: [{ timestamp: NOW, value: 1000 }] })) };
    render(<SloSummary widget={widgetWith()} result={totalOnly} />);
    expect(screen.getByText("Error series missing")).toBeInTheDocument();
  });

  it("shows the worst burn pair in services mode and the bare group value under the group header", () => {
    const series = ["checkout", "search"].flatMap((service) => result({ default: [1000, 0] }, { service }).series!);
    render(<SloSummary widget={widgetWith({ config: { ...config, groupBy: "service" } })} result={{ series }} />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Worst burn" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "checkout" })).toBeInTheDocument();
    expect(within(table).getAllByText(/^1h·5m /)).not.toHaveLength(0);
  });

  it("reports an invalid configuration instead of guessing a reading", () => {
    render(<SloSummary widget={widgetWith({ config: { objective: 99.9, period: "30d", total: "x" } })} result={result({ default: [1, 0] })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("invalid");
  });
});

describe("slo-summary registration", () => {
  it("registers the plugin once with the decimals control, validates its config and is listed in the library", () => {
    registerSloSummaryPlugin();
    registerSloSummaryPlugin();
    const definition = getWidgetDefinition("plugin", "slo-summary");
    expect(definition).toBeDefined();
    expect(definition?.styleControls).toEqual(["decimals"]);
    expect(getWidgetPlugins().map((plugin) => plugin.id)).toContain("slo-summary");
    expect(definition?.validateInput?.(result({}), { objective: 99.9 })).toHaveLength(1);
    expect(definition?.validateInput?.(result({}), config)).toEqual([]);
    expect(SLO_PERIODS).toContain("30d");
  });
});

describe("slo-summary listing, layout and tooltip", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("is listed in the widget library with a default config that validates", () => {
    registerSloSummaryPlugin();
    const definition = getWidgetDefinition("plugin", "slo-summary");
    expect(definition?.listed).not.toBe(false);
    expect(getWidgetPlugins().some(plugin => plugin.id === "slo-summary")).toBe(true);
    expect(validateSloConfig(definition?.defaultConfig)).toBeUndefined();
    expect(definition?.defaultConfig).toEqual(SLO_DEFAULT_CONFIG);
  });

  it("names the omitted groups in a footer that is always visible, singular and plural", () => {
    const grouped = { ...config, groupBy: "service" };
    const three = { series: ["a", "b", "c"].flatMap(service => result({ default: [1000, 0] }, { service }).series ?? []) };
    const { container, unmount } = render(<SloSummary widget={widgetWith({ config: { ...grouped, maxRows: 2 } })} result={three} />);
    expect(container.querySelector("[data-slo-footer]")).toHaveTextContent("Showing 2 of 3 groups; 1 more group not shown");
    unmount();
    const again = render(<SloSummary widget={widgetWith({ config: { ...grouped, maxRows: 1 } })} result={three} />);
    expect(again.container.querySelector("[data-slo-footer]")).toHaveTextContent("Showing 1 of 3 groups; 2 more groups not shown");
  });

  it("keeps the services rows in a labelled region, with no empty tab stop, and labelled cells for narrow cards", () => {
    const grouped = { ...config, groupBy: "service" };
    const { container } = render(<SloSummary widget={widgetWith({ config: grouped })} result={result({ default: [1000, 0] }, { service: "a" })} />);
    const region = container.querySelector("[data-slo-scroll]");
    // Rows that do not fit are hidden and counted, so the region never scrolls and takes no keyboard stop.
    expect(region).not.toHaveAttribute("tabindex");
    expect(region).toHaveAttribute("role", "region");
    expect(container.querySelector("td[data-label='Availability']")).toBeInTheDocument();
  });

  it("shows the exact burn values in a tooltip on the burn window", () => {
    render(<SloSummary widget={widgetWith()} result={result({ default: [1000, 0], "5m": [1000, 20], "1h": [1000, 20] })} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Burn windows 1h and 5m" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("20 ×");
    expect(tooltip).not.toHaveTextContent("20×");
    expect(tooltip).toHaveTextContent("Fires as critical");
  });

  it("reads a burn factor in the tooltip with the same unit spacing as its chip", () => {
    const { container } = render(<SloSummary widget={widgetWith()} result={result({ default: [1000, 0] })} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Burn windows 1h and 5m" }));
    const tooltip = screen.getByRole("tooltip");
    expect(container.querySelector("[aria-label='Burn windows']")).toHaveTextContent("of 14.4 ×");
    expect(tooltip).toHaveTextContent("14.4 ×");
    expect(tooltip).not.toHaveTextContent("14.4×");
  });

  it("lays each services row out in two wrapped lines at phone width, with every reading labelled", () => {
    const css = read("./slo-summary.module.css");
    const phone = css.slice(css.indexOf("@media (max-width: 480px)"), css.indexOf("@media (prefers-reduced-motion"));
    expect(phone).toMatch(/\.table tr \{[^}]*flex-wrap: wrap/);
    expect(phone).toMatch(/content: attr\(data-label\)/);
    expect(phone).not.toMatch(/display: block;\s*color: var\(--gamma-muted\)/);
  });

  it("uses only defined Gamma tokens in its stylesheet", () => {
    const theme = read("../gamma/gamma-theme.module.css");
    const defined = new Set([...theme.matchAll(/(--gamma-[a-z0-9-]+)\s*:/g)].map(match => match[1]));
    const used = [...read("./slo-summary.module.css").matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map(match => match[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(name => !defined.has(name))).toEqual([]);
  });
});

describe("slo-summary decimals, no traffic and truncation", () => {
  const widgetAt = (decimals: number, extra: Partial<Widget> = {}) => widgetWith(extra, decimals);

  it("prints a burn rate of 0.3 as 0 at zero decimals, with one unit spacing", () => {
    const { container } = render(<SloSummary widget={widgetAt(0)} result={result({ default: [1000, 0.3] })} />);
    const chips = container.querySelector("[aria-label='Burn windows']");
    expect(chips).toHaveTextContent("0 × / 0 × of 14.4 ×");
    expect(chips).not.toHaveTextContent("0.3");
  });

  it("prints the burn factor at the widget's decimals, keeping its own value when rounding would hide it", () => {
    const { container } = render(<SloSummary widget={widgetAt(2)} result={result({ default: [1000, 0.3] })} />);
    const chips = container.querySelector("[aria-label='Burn windows']");
    expect(chips).toHaveTextContent("of 14.40 ×");
    expect(chips).not.toHaveTextContent("of 14.4 ×");
  });

  it("does not print float noise for a rate just above its factor of 1 at zero decimals", () => {
    const { container } = render(<SloSummary widget={widgetAt(0)} result={result({ default: [1000, 1.0004] })} />);
    const chips = container.querySelector("[aria-label='Burn windows']");
    expect(chips).toHaveTextContent("1 × / 1 × of 1 ×");
    expect(chips?.textContent).not.toMatch(/\d\.\d{3,}/);
  });

  it("reads no traffic as No traffic, not No data, in single mode", () => {
    const { container } = render(<SloSummary widget={widgetAt(2)} result={result({ default: [0, 0] })} />);
    expect(container.querySelector("header")).toHaveTextContent("No traffic");
    expect(container.querySelector("header")).not.toHaveTextContent("No data");
  });

  it("names the range end when the result is not from now, and says window when it is", () => {
    const earlier: QueryResult = { series: result({ default: [1000, 0] }).series?.map(series => ({ ...series, points: [{ timestamp: NOW - 7200_000, value: series.points[0].value }] })) };
    const past = render(<SloSummary widget={widgetWith()} result={earlier} />);
    const at = new Date(NOW - 7200_000);
    const short = `${at.getDate()} ${at.toLocaleString("en", { month: "short" })} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    expect(past.container.querySelector("header")).toHaveTextContent(`over 30d ending ${short}`);
    expect(past.container.querySelector("header")).not.toHaveTextContent(/, \d{4}/);
    expect(past.container.querySelector("header")).not.toHaveTextContent("30d window");
    past.unmount();
    const live = render(<SloSummary widget={widgetWith()} result={result({ default: [1000, 0] })} />);
    expect(live.container.querySelector("header")).toHaveTextContent("over 30d window");
    expect(live.container.querySelector("header")).not.toHaveTextContent("ending");
  });

  it("counts a truncated services result as a lower bound, not an exact total", () => {
    const groupedConfig = { ...config, groupBy: "service", maxRows: 1 };
    const a = result({ default: [1000, 0] }, { service: "a" });
    const b = result({ default: [1000, 0] }, { service: "b" });
    const { container } = render(
      <SloSummary widget={widgetWith({ config: groupedConfig })} result={{ series: [...(a.series ?? []), ...(b.series ?? [])], truncated: true }} />,
    );
    expect(container.querySelector("[data-slo-footer]")).toHaveTextContent("Showing 1 of at least 2 groups; the result is truncated");
    expect(container.querySelector("[data-slo-footer]")).not.toHaveTextContent(/Showing 1 of 2 groups/);
  });
});

describe("services rows that fit the card", () => {
  it("keeps only the leading rows that fit completely", () => {
    expect(rowsThatFit([28, 28, 28], 84)).toBe(3);
    expect(rowsThatFit([28, 28, 28], 83)).toBe(2);
    expect(rowsThatFit([28, 28, 28], 0)).toBe(0);
    expect(rowsThatFit([], 500)).toBe(0);
    // A row taller than what is left is not shown, even when a shorter row after it would fit.
    expect(rowsThatFit([40, 10], 45)).toBe(1);
  });

  it("formats a range end in the short local form with no year", () => {
    expect(shortRangeEnd(new Date(2026, 10, 19, 3, 10).getTime())).toBe("19 Nov 03:10");
  });

  it("renders whole rows only and counts the rows hidden for space in the footer", () => {
    // jsdom has no layout. Stub it: a 100px region, a 28px row (the header too), so the header and two rows fit.
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const h = this.tagName === "TR" ? 28 : 0;
      return { height: h, width: 0, top: 0, bottom: h, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const names = ["a", "b", "c", "d", "e", "f"];
      const series = names.flatMap(service => result({ default: [1000, 0] }, { service }).series!);
      const { container } = render(<SloSummary widget={widgetWith({ config: { ...config, groupBy: "service" } })} result={{ series }} />);
      expect(container.querySelectorAll("[data-slo-rows] tbody tr:not([hidden])")).toHaveLength(2);
      expect(container.querySelector("[data-slo-footer]")).toHaveTextContent("Showing 2 of 6 groups; 4 more groups not shown");
      // Each group is in the DOM once, so a text query scoped to the card finds one element per group.
      for (const name of names) expect(within(container).getAllByText(name, { exact: true })).toHaveLength(1);
    } finally {
      height.mockRestore();
      rect.mockRestore();
    }
  });
});

