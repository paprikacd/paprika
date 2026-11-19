import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "./schema";
import { Heatmap } from "./chart-renderers";
import { ObservationDetails } from "./observation-tooltip";
import { StatSparkline } from "./stat-sparkline";
import { TOOLTIP_PIN_HINT_PINNED } from "./tooltip-content";
import { MetricPie, StatusHistory } from "./plugins/metric-distributions";
import { RecordLine } from "./plugins/record-charts";
import { RecordTable, RecordTreemap } from "./plugins/records";
import { SmallMultiples } from "./plugins/small-multiples";
import { StatusGrid } from "./plugins/status-grid";
import { UptimeCalendar, UptimeTimeline } from "./plugins/uptime-views";

/*
 * One conformance suite for every observation owner, driven the way a user drives each host.
 *
 * Shared rules, asserted on every owner:
 *   1. Hovering an observation opens its panel, unpinned.
 *   2. After the pointer leaves, the panel is open at 179 ms and closed by 181 ms. A repeated leave does not extend the grace.
 *   3. Moving the pointer into the panel keeps it open past the grace; leaving the panel closes it after the grace.
 *   4. Selecting (press, or Enter where the host has a keydown handler) pins it. A pin survives a pointer leave and a hover
 *      of another observation, so a hover never replaces a pin.
 *   5. Selecting the pinned observation again releases it.
 *   6. Escape closes a pinned panel, and so does an outside pointerdown.
 *   7. Keyed owners keep a pinned panel across an equal refresh with a new result object, and follow the pinned
 *      observation when a refresh reorders the data. Revision owners close on any new result object, by design.
 *
 * Each owner's differences are data in the case table: a `differs` entry names the difference and gives its reason.
 * No owner is skipped; a difference narrows an assertion only where the entry says so.
 */

type Flag = "keyboard" | "select-again" | "refresh" | "panels" | "reorder" | "press" | "arrows" | "timestamps" | "off-point";
interface Difference { flag: Flag; reason: string }

interface OwnerCase {
  owner: string;
  host: string;
  /** Text that identifies observation i inside its panel. */
  tokens: readonly string[];
  /** Keyed owners keep their open observation by identity; revision owners close on any new result. */
  retention: "keyed" | "revision";
  result: () => QueryResult;
  mount: (result: QueryResult) => ReactElement;
  /** Hook for geometry the host reads from layout (SVG bounds). */
  prepare?: (root: HTMLElement) => void;
  hover: (root: HTMLElement, i: number) => void;
  leave: (root: HTMLElement, i: number) => void;
  press: (root: HTMLElement, i: number) => void;
  pressKey: (root: HTMLElement, i: number) => void;
  /** Pins observation 0, then moves the pin with an arrow key. Set only by hosts with arrow inspection. */
  arrowPin?: (root: HTMLElement) => void;
  /** The same observations with every timestamp moved. Set only where keys include timestamps. */
  shifted?: () => QueryResult;
  /** Moves the pointer across the plot to a place that holds no observation. Only plots with sample positions set it. */
  offObservation?: (root: HTMLElement) => void;
  /** After a reorder of the same observations, the trigger that now owns observation i. */
  reordered?: { result: () => QueryResult; trigger: (root: HTMLElement, i: number) => Element };
  differs: Difference[];
}

const at = (index: number) => Date.UTC(2026, 0, 1, 0, index);
const samples = (name: string, values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({
  name,
  labels: { service: name },
  points: values.map((value, index) => ({ timestamp: at(index), value })),
});
const widget = (pluginId: string, patch: Partial<Widget> = {}): Widget =>
  ({ id: pluginId, title: "Observations", type: "plugin", pluginId, dataKind: "metrics", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, ...patch }) as Widget;

const DAY = 86_400_000;
const dayBase = Date.UTC(2024, 1, 28);
const utcDay = (day: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(day));
const dayTokens = [0, 1, 2].map(k => `${utcDay(dayBase + k * DAY)} UTC`);
const uptimeSeries = (name: string, values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({
  name,
  labels: { service: name },
  points: values.map((value, index) => ({ timestamp: dayBase + index * DAY + 3_600_000, value })),
});

// Panels are portalled to the body. A pinned record-table panel is a region; every other panel is a tooltip.
const panels = () => [...document.querySelectorAll<HTMLElement>('[role="tooltip"], [role="region"][aria-label="Record cell details"]')];
const panelFor = (token: string) => panels().find(panel => panel.textContent?.includes(token));
const isPinned = (panel: HTMLElement) => panel.getAttribute("role") === "region" || !!panel.textContent?.includes(TOOLTIP_PIN_HINT_PINNED);

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`No element for ${selector}`);
  return found;
};
const hoverElement = (element: Element) => fireEvent.pointerEnter(element, { pointerType: "mouse" });
const leaveElement = (element: Element) => fireEvent.pointerLeave(element, { pointerType: "mouse" });
const pointerAt = (type: "pointermove" | "pointerdown", element: Element, clientX: number, clientY = 50) => {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  fireEvent(element, event);
};
const enterKey = (element: Element) => fireEvent.keyDown(element, { key: "Enter" });

// Status grid, uptime and status history: the pointer and focus are on a button, and Enter activates it through click.
const noOffPoint: Difference = { flag: "off-point", reason: "Each trigger is an element: leaving it ends the hover, with no off-point position to track." };
const noArrows: Difference = { flag: "arrows", reason: "Arrow keys move focus between cells; a pin stays where it is." };
const noTimestamps: Difference = { flag: "timestamps", reason: "Keys carry no timestamp, so a refresh that moves every timestamp is not a case for this host." };
const nativeEnter: Difference = { flag: "keyboard", reason: "Native button: Enter activates through click, which the test drives directly." };

const statusResult = (): QueryResult => ({ series: [samples("api", [1]), samples("worker", [0]), samples("db", [1])] });
const statusView = (result: QueryResult) => <StatusGrid widget={widget("status-grid", { options: { decimals: 2 } })} result={result} />;

const uptimeResult = (): QueryResult => ({ series: [uptimeSeries("api", [1, 0, null, 1]), uptimeSeries("worker", [0, 1, 1, 0])] });
const uptimeReversed = (): QueryResult => {
  const result = uptimeResult();
  return { series: [...result.series!].reverse() };
};
const uptimeTrigger = (root: HTMLElement, i: number) => q(root, `[data-uptime-key="0-${i}"]`);
const uptimeHover = (root: HTMLElement, i: number) => hoverElement(uptimeTrigger(root, i));
const uptimeLeave = (root: HTMLElement, i: number) => leaveElement(uptimeTrigger(root, i));
const uptimePress = (root: HTMLElement, i: number) => fireEvent.click(uptimeTrigger(root, i));
const uptimeKey = (root: HTMLElement, i: number) => fireEvent.click(uptimeTrigger(root, i));
const uptimeConfig = { maxSeries: 2 };

const historyResult = (): QueryResult => ({ series: [samples("api", [17.5, 18.5, 19.5]), samples("worker", [1, 0, 1])] });
const historyShifted = (): QueryResult => ({ series: historyResult().series!.map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, timestamp: point.timestamp + 20_000 })) })) });
const historyCell = (root: HTMLElement, i: number) => q(root, `[data-history-key="0-${i}"]`);

// Records and charts: geometry comes from the SVG bounds, so each test mocks them to a fixed box.
const recordFrame = (rows: [string, number][]): QueryResult => ({ records: { columns: [{ key: "service", type: "string" }, { key: "uptime", type: "number", unit: "percent" }], rows } });
const recordRows: [string, number][] = [["api", 10], ["worker", 30], ["web", 20]];
const recordLineWidget = widget("records-line", { dataKind: "records", config: { x: "service", y: ["uptime"] } });
const recordMarks = (root: HTMLElement) => [...root.querySelectorAll<SVGElement>("[data-record-mark]")];
const recordSvg = (root: HTMLElement) => q<SVGSVGElement>(root, "[data-record-chart-host] > svg");

const treemapRows: [string, number][] = [["api", 3], ["worker", 1], ["web", 2]];
// The treemap lays tiles out largest first, so the tile order is api, web, worker.
const treemapTiles = (root: HTMLElement) => [...root.querySelectorAll<SVGGElement>('g[role="button"]')];

const samplesRows = (): QueryResult => ({ series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 101 }, { timestamp: 2000, value: 202 }, { timestamp: 3000, value: 303 }] }] });
const multipleXs = [10, 300, 590];

const pieResult = (): QueryResult => ({ series: [samples("api", [3]), samples("worker", [1]), samples("db", [2])] });
const pieSlice = (root: HTMLElement, i: number) => q(root, `[data-pie-index="${i}"]`);

const heatmapResult = (): QueryResult => ({ series: [samples("api", [0.5]), samples("worker", [1.5]), samples("db", [2])] });
const heatmapCells = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-heatmap-cell]")];

const detailsResult = (): QueryResult => ({ series: [samples("api", [1]), samples("worker", [0]), samples("db", [1])] });

const OWNERS: OwnerCase[] = [
  {
    owner: "status grid",
    host: "plugins/status-grid.tsx",
    tokens: ["api", "worker", "db"],
    retention: "keyed",
    result: statusResult,
    mount: statusView,
    hover: (root, i) => hoverElement(q(root, `[data-status-index="${i}"]`)),
    leave: (root, i) => leaveElement(q(root, `[data-status-index="${i}"]`)),
    press: (root, i) => fireEvent.click(q(root, `[data-status-index="${i}"]`)),
    pressKey: (root, i) => fireEvent.click(q(root, `[data-status-index="${i}"]`)),
    reordered: {
      result: () => ({ series: [...statusResult().series!].reverse() }),
      trigger: (root, i) => q(root, `[data-status-index="${2 - i}"]`),
    },
    differs: [ noOffPoint, noArrows, noTimestamps,nativeEnter],
  },
  {
    owner: "uptime calendar",
    host: "plugins/uptime-views.tsx",
    tokens: dayTokens,
    retention: "keyed",
    result: uptimeResult,
    mount: result => <UptimeCalendar widget={widget("uptime-calendar", { config: uptimeConfig })} result={result} />,
    hover: uptimeHover,
    leave: uptimeLeave,
    press: uptimePress,
    pressKey: uptimeKey,
    reordered: { result: uptimeReversed, trigger: (root, i) => q(root, `[data-uptime-key="1-${i}"]`) },
    differs: [ noOffPoint, noArrows, noTimestamps,nativeEnter],
  },
  {
    owner: "uptime timeline",
    host: "plugins/uptime-views.tsx",
    tokens: dayTokens,
    retention: "keyed",
    result: uptimeResult,
    mount: result => <UptimeTimeline widget={widget("uptime-timeline", { config: uptimeConfig })} result={result} />,
    hover: uptimeHover,
    leave: uptimeLeave,
    press: uptimePress,
    pressKey: uptimeKey,
    reordered: { result: uptimeReversed, trigger: (root, i) => q(root, `[data-uptime-key="1-${i}"]`) },
    differs: [ noOffPoint, noArrows, noTimestamps,nativeEnter],
  },
  {
    owner: "status history",
    host: "plugins/metric-distributions.tsx",
    tokens: ["17.5", "18.5", "19.5"],
    retention: "keyed",
    result: historyResult,
    mount: result => <StatusHistory widget={widget("status-history")} result={result} />,
    hover: (root, i) => hoverElement(historyCell(root, i)),
    leave: (root, i) => leaveElement(historyCell(root, i)),
    press: (root, i) => fireEvent.click(historyCell(root, i)),
    pressKey: (root, i) => fireEvent.click(historyCell(root, i)),
    shifted: historyShifted,
    reordered: {
      result: () => ({ series: [...historyResult().series!].reverse() }),
      trigger: (root, i) => q(root, `[data-history-key="1-${i}"]`),
    },
    differs: [ noOffPoint, noArrows,nativeEnter],
  },
  {
    owner: "metric pie",
    host: "plugins/metric-distributions.tsx",
    tokens: ["api", "worker", "db"],
    retention: "revision",
    result: pieResult,
    mount: result => <MetricPie widget={widget("pie", { options: { decimals: 2 } })} result={result} />,
    hover: (root, i) => hoverElement(pieSlice(root, i)),
    leave: (root, i) => leaveElement(pieSlice(root, i)),
    press: (root, i) => fireEvent.click(pieSlice(root, i)),
    pressKey: (root, i) => enterKey(pieSlice(root, i)),
    differs: [ noOffPoint, noArrows, noTimestamps,{ flag: "refresh", reason: "Revision retention: a new result object closes the panel, as the host has always done." }],
  },
  {
    owner: "heatmap",
    host: "chart-renderers.tsx",
    tokens: ["api", "worker", "db"],
    retention: "keyed",
    result: heatmapResult,
    mount: result => <Heatmap widget={widget("heatmap", { type: "heatmap" })} series={result.series ?? []} />,
    hover: (root, i) => hoverElement(heatmapCells(root)[i]),
    leave: (root, i) => leaveElement(heatmapCells(root)[i]),
    press: (root, i) => fireEvent.click(heatmapCells(root)[i]),
    pressKey: (root, i) => fireEvent.click(heatmapCells(root)[i]),
    reordered: { result: () => ({ series: [...heatmapResult().series!].reverse() }), trigger: (root, i) => heatmapCells(root)[2 - i] },
    differs: [ noOffPoint, noArrows, noTimestamps,
      nativeEnter,
      { flag: "reorder", reason: "Cells are keyed by position as well as identity, so a reordered series closes its pinned cell (documented in the host)." },
    ],
  },
  {
    owner: "record line chart",
    host: "plugins/record-charts.tsx",
    tokens: ["api", "worker", "web"],
    retention: "revision",
    result: () => recordFrame(recordRows),
    mount: result => <RecordLine widget={recordLineWidget} result={result} />,
    prepare: root => { vi.spyOn(recordSvg(root), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 280)); },
    hover: (root, i) => {
      const mark = recordMarks(root)[i];
      pointerAt("pointermove", recordSvg(root), Number(mark.getAttribute("cx")), Number(mark.getAttribute("cy")));
    },
    leave: root => leaveElement(recordSvg(root)),
    press: (root, i) => fireEvent.click(recordMarks(root)[i]),
    pressKey: (root, i) => enterKey(recordMarks(root)[i]),
    arrowPin: root => {
      fireEvent.click(recordMarks(root)[0]);
      fireEvent.keyDown(recordSvg(root), { key: "ArrowRight" });
    },
    differs: [ { flag: "off-point", reason: "Known: the plot keeps the active point while the pointer stays on it away from marks (see record-charts tests), so leaving a mark does not close." }, noTimestamps,
      { flag: "refresh", reason: "Revision retention: a new frame object closes the panel." },
    ],
  },
  {
    owner: "records cell matrix",
    host: "plugins/records.tsx",
    tokens: ["api", "worker", "web"],
    retention: "revision",
    result: () => recordFrame(recordRows),
    mount: result => <RecordTable widget={widget("record-table", { dataKind: "records", options: { decimals: 2 } })} result={result} />,
    hover: (root, i) => hoverElement(q(root, `td[data-record-cell-row="${i}"][data-record-cell-column="0"]`)),
    leave: (root, i) => leaveElement(q(root, `td[data-record-cell-row="${i}"][data-record-cell-column="0"]`)),
    press: (root, i) => fireEvent.click(q(root, `td[data-record-cell-row="${i}"][data-record-cell-column="0"]`)),
    pressKey: (root, i) => enterKey(q(root, `td[data-record-cell-row="${i}"][data-record-cell-column="0"]`)),
    differs: [ noOffPoint, noArrows, noTimestamps,{ flag: "refresh", reason: "Revision retention: a new frame object closes the panel." }],
  },
  {
    owner: "records treemap",
    host: "plugins/records.tsx",
    tokens: ["api", "web", "worker"],
    retention: "revision",
    result: () => recordFrame(treemapRows),
    mount: result => <RecordTreemap widget={widget("record-treemap", { dataKind: "records", config: { label: "service", value: "uptime" } })} result={result} />,
    hover: (root, i) => hoverElement(treemapTiles(root)[i]),
    leave: (root, i) => leaveElement(treemapTiles(root)[i]),
    press: (root, i) => fireEvent.click(treemapTiles(root)[i]),
    pressKey: (root, i) => enterKey(treemapTiles(root)[i]),
    differs: [ noOffPoint, noArrows, noTimestamps,{ flag: "refresh", reason: "Revision retention: a new frame object closes the panel." }],
  },
  {
    owner: "small multiples",
    host: "plugins/small-multiples.tsx",
    tokens: ["101", "202", "303"],
    retention: "revision",
    result: samplesRows,
    mount: result => <SmallMultiples widget={widget("small-multiples", { config: { columns: 1, maxSeries: 1, maxPoints: 8 } })} result={result} />,
    prepare: root => { vi.spyOn(q(root, "svg[data-domain-start]"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 100)); },
    hover: (root, i) => pointerAt("pointermove", q(root, "svg[data-domain-start]"), multipleXs[i]),
    leave: root => leaveElement(q(root, "svg[data-domain-start]")),
    press: (root, i) => fireEvent.click(q(root, "svg[data-domain-start]"), { clientX: multipleXs[i], clientY: 50 }),
    pressKey: (root, i) => {
      // Focus previews the latest sample; arrow keys walk to observation i; Enter pins it.
      const plot = q(root, "svg[data-domain-start]");
      fireEvent.focus(plot);
      for (let step = 2 - i; step > 0; step--) fireEvent.keyDown(plot, { key: "ArrowLeft" });
      fireEvent.keyDown(plot, { key: "Enter" });
    },
    offObservation: root => pointerAt("pointermove", q(root, "svg[data-domain-start]"), 1),
    arrowPin: root => {
      const plot = q(root, "svg[data-domain-start]");
      fireEvent.click(plot, { clientX: multipleXs[0], clientY: 50 });
      fireEvent.keyDown(plot, { key: "ArrowRight" });
    },
    differs: [ noTimestamps,{ flag: "refresh", reason: "Revision retention: a new result object closes the panel, as the host has always done." }],
  },
  {
    owner: "stat sparkline",
    host: "stat-sparkline.tsx",
    tokens: ["101", "202", "303"],
    retention: "revision",
    result: samplesRows,
    mount: result => <StatSparkline widget={widget("stat", { type: "stat", options: { showSparkline: true } })} series={result.series![0]} name="api" unit="" />,
    prepare: root => { vi.spyOn(q(root, "svg[data-stat-sparkline]"), "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 240, 64)); },
    hover: (root, i) => pointerAt("pointermove", q(root, "svg[data-stat-sparkline]"), [101, 220, 339][i]),
    leave: root => leaveElement(q(root, "svg[data-stat-sparkline]")),
    // A sparkline selects on pointer down, not click.
    press: (root, i) => pointerAt("pointerdown", q(root, "svg[data-stat-sparkline]"), [101, 220, 339][i]),
    pressKey: (root, i) => {
      // Focus previews the latest sample; arrow keys walk to observation i; Enter pins it.
      const plot = q(root, "svg[data-stat-sparkline]");
      fireEvent.focus(plot);
      for (let step = 2 - i; step > 0; step--) fireEvent.keyDown(plot, { key: "ArrowLeft" });
      fireEvent.keyDown(plot, { key: "Enter" });
    },
    differs: [ { flag: "off-point", reason: "Always selects the nearest sample across the whole plot, so no position is off every sample." }, noTimestamps,
      { flag: "press", reason: "Selects on pointer down (touch: pointer up with no drag), not click." },
      { flag: "select-again", reason: "Enter releases the pin and keeps the sample previewed, rather than closing the panel." },
      { flag: "keyboard", reason: "Keyboard focus previews the latest sample and holds it while focused; Enter pins." },
      { flag: "refresh", reason: "Revision retention: a new series closes the panel." },
    ],
    arrowPin: root => {
      pointerAt("pointerdown", q(root, "svg[data-stat-sparkline]"), 101);
      fireEvent.keyDown(q(root, "svg[data-stat-sparkline]"), { key: "ArrowRight" });
    },
  },
  {
    owner: "observation details",
    host: "observation-tooltip.tsx",
    tokens: ["api", "worker", "db"],
    retention: "keyed",
    result: detailsResult,
    mount: result => (
      <>
        {(result.series ?? []).map(entry => (
          <ObservationDetails key={entry.name} label={`Inspect ${entry.name}`} observationKey={entry.name} revision={1} details={<p>Reading {entry.name} {String(entry.points[0].value)}</p>}>
            <span>{entry.name} cell</span>
          </ObservationDetails>
        ))}
      </>
    ),
    hover: (root, i) => hoverElement(screen.getByRole("button", { name: `Inspect ${["api", "worker", "db"][i]}` })),
    leave: (root, i) => leaveElement(screen.getByRole("button", { name: `Inspect ${["api", "worker", "db"][i]}` })),
    press: (root, i) => fireEvent.click(screen.getByRole("button", { name: `Inspect ${["api", "worker", "db"][i]}` })),
    pressKey: (root, i) => fireEvent.click(screen.getByRole("button", { name: `Inspect ${["api", "worker", "db"][i]}` })),
    reordered: undefined,
    differs: [ noOffPoint, noArrows, noTimestamps,
      nativeEnter,
      { flag: "panels", reason: "One owner per instance: a pin cannot be replaced by another instance's hover, but both panels can be open at once." },
      { flag: "reorder", reason: "Each instance owns one key, so there is no reorder to follow." },
    ],
  },
];

describe.each(OWNERS)("observation owner conformance: $owner ($host)", owner => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const mount = () => {
    const view = render(owner.mount(owner.result()));
    owner.prepare?.(view.container);
    return view;
  };
  const panelAt = (i: number) => panelFor(owner.tokens[i]);
  const pinnedAt = (i: number) => {
    const panel = panelAt(i);
    return !!panel && isPinned(panel);
  };
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const differs = (flag: Flag) => owner.differs.some(entry => entry.flag === flag);

  it("1. hovering an observation opens its panel, unpinned", () => {
    const { container } = mount();
    owner.hover(container, 0);
    expect(panelAt(0)).toBeDefined();
    expect(pinnedAt(0)).toBe(false);
  });

  it("2. closes after the pointer leaves: open at 179 ms, closed by 181 ms, and a repeated leave does not extend it", () => {
    const { container } = mount();
    owner.hover(container, 0);
    owner.leave(container, 0);
    advance(100);
    owner.leave(container, 0);
    advance(79);
    expect(panelAt(0)).toBeDefined();
    advance(2);
    expect(panelAt(0)).toBeUndefined();
  });

  it("2b. moving off every observation while still on the plot ends the hover", () => {
    if (!owner.offObservation) {
      expect(differs("off-point")).toBe(true);
      return;
    }
    const { container } = mount();
    owner.hover(container, 0);
    owner.offObservation(container);
    advance(179);
    expect(panelAt(0)).toBeDefined();
    advance(2);
    expect(panelAt(0)).toBeUndefined();
  });

  it("3. the pointer in the panel keeps it open past the grace, and leaving the panel closes it after the grace", () => {
    const { container } = mount();
    owner.hover(container, 0);
    owner.leave(container, 0);
    const panel = panelAt(0)!;
    fireEvent.pointerEnter(panel, { pointerType: "mouse" });
    advance(1000);
    expect(panelAt(0)).toBeDefined();
    fireEvent.pointerLeave(panel, { pointerType: "mouse" });
    advance(179);
    expect(panelAt(0)).toBeDefined();
    advance(2);
    expect(panelAt(0)).toBeUndefined();
  });

  it("4. selecting pins; the pin survives a pointer leave and a hover of another observation", () => {
    const { container } = mount();
    owner.press(container, 0);
    expect(pinnedAt(0)).toBe(true);
    owner.leave(container, 0);
    advance(1000);
    expect(pinnedAt(0)).toBe(true);
    owner.hover(container, 1);
    advance(1000);
    expect(pinnedAt(0)).toBe(true);
    if (!differs("panels")) expect(panelAt(1)).toBeUndefined();
  });

  it("4b. Enter pins, and the pin survives a pointer leave", () => {
    const { container } = mount();
    owner.pressKey(container, 1);
    expect(pinnedAt(1)).toBe(true);
    owner.leave(container, 1);
    advance(1000);
    expect(pinnedAt(1)).toBe(true);
  });

  it("4c. arrow keys move a pin to the sample they reach (hosts with arrow inspection)", () => {
    if (!owner.arrowPin) {
      expect(differs("arrows")).toBe(true);
      return;
    }
    const { container } = mount();
    owner.arrowPin(container);
    expect(pinnedAt(1)).toBe(true);
    expect(panelAt(0)).toBeUndefined();
  });

  it("5. selecting the pinned observation again releases it", () => {
    const { container } = mount();
    owner.press(container, 0);
    expect(pinnedAt(0)).toBe(true);
    owner.press(container, 0);
    expect(pinnedAt(0)).toBe(false);
    owner.leave(container, 0);
    advance(181);
    expect(panelAt(0)).toBeUndefined();
  });

  it("6a. Escape closes a pinned panel", () => {
    const { container } = mount();
    owner.press(container, 0);
    expect(pinnedAt(0)).toBe(true);
    fireEvent.keyDown(container, { key: "Escape" });
    expect(panelAt(0)).toBeUndefined();
  });

  it("6b. an outside pointerdown closes a pinned panel", () => {
    const { container } = mount();
    owner.press(container, 1);
    expect(pinnedAt(1)).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(panelAt(1)).toBeUndefined();
  });

  it(owner.retention === "keyed" ? "7a. keyed: a pinned panel survives an equal refresh with a new result object" : "7a. revision: a new result object closes the panel, by design", () => {
    const view = mount();
    owner.press(view.container, 0);
    expect(pinnedAt(0)).toBe(true);
    view.rerender(owner.mount(owner.result()));
    if (owner.retention === "keyed") {
      expect(panelAt(0)).toBeDefined();
      expect(pinnedAt(0)).toBe(true);
    } else {
      expect(panelAt(0)).toBeUndefined();
    }
  });

  it("7b. keyed: a reorder keeps the pin on its observation and anchors it to the new trigger", () => {
    if (!owner.reordered) {
      expect(owner.retention === "revision" || owner.differs.some(entry => entry.flag === "panels" || entry.flag === "reorder")).toBe(true);
      return;
    }
    const view = mount();
    owner.press(view.container, 0);
    expect(pinnedAt(0)).toBe(true);
    view.rerender(owner.mount(owner.reordered.result()));
    const closes = owner.differs.some(entry => entry.flag === "reorder" && entry.reason.includes("closes"));
    if (closes) {
      expect(panelAt(0)).toBeUndefined();
      return;
    }
    expect(pinnedAt(0)).toBe(true);
    const moved = owner.reordered.trigger(view.container, 0);
    expect(moved.getAttribute("aria-pressed")).toBe("true");
    // The panel must be anchored to the moved trigger: a pointer down on it is inside the anchor, not an outside dismissal.
    fireEvent.pointerDown(moved);
    expect(pinnedAt(0)).toBe(true);
  });

  it("7c. keyed: a refresh that moves every timestamp keeps the pinned sample (only history keys include timestamps)", () => {
    if (!owner.shifted) {
      expect(differs("timestamps")).toBe(true);
      return;
    }
    const view = mount();
    owner.press(view.container, 0);
    expect(pinnedAt(0)).toBe(true);
    view.rerender(owner.mount(owner.shifted()));
    expect(panelAt(0)).toBeDefined();
    expect(pinnedAt(0)).toBe(true);
  });
});
