import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Compactor, Layout, LayoutItem } from "react-grid-layout";
import { DashboardCanvas } from "./canvas";
import { visibleTileControl } from "./tile-controls";
import { exampleDashboard, exampleProviders } from "./example";
import { useDashboardHistory } from "./history";
import type { Dashboard } from "./schema";

const rgl = vi.hoisted(() => ({ width: 1100, props: undefined as unknown as GridProps }));
interface GridProps {
  layout: Layout;
  compactor: Compactor;
  onDragStart: (layout: Layout, oldItem: LayoutItem | null) => void;
  onDragStop: (layout: Layout) => void;
}
vi.mock("react-grid-layout", async () => {
  const core = await import("react-grid-layout/core");
  return {
    default: (props: { children: ReactNode }) => {
      rgl.props = props as unknown as GridProps;
      return <div data-testid="saved-grid">{props.children}</div>;
    },
    useContainerWidth: () => ({ width: rgl.width, containerRef: { current: null }, mounted: true }),
    verticalCompactor: core.verticalCompactor,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rgl.width = 1100;
});

// Two widgets stacked in the same columns: Requests above Errors.
function stackedDashboard(): Dashboard {
  const template = exampleDashboard.widgets[0];
  return structuredClone({
    ...exampleDashboard,
    widgets: [
      { ...template, id: "requests", title: "Requests", layout: { x: 0, y: 0, w: 6, h: 4 } },
      { ...template, id: "errors", title: "Errors", layout: { x: 0, y: 4, w: 6, h: 4 } },
    ],
  });
}
const positions = (layout: Layout) => Object.fromEntries(layout.map(({ i, x, y, w, h }) => [i, [x, y, w, h]]));
// Scoped to the canvas: the attention strip above it also has a polite region.
const liveText = () => document.querySelector('[data-testid="dashboard-canvas"] [aria-live="polite"]')?.textContent;
const fetcher = () => vi.fn().mockResolvedValue({ series: [{ name: "primary", labels: {}, points: [{ timestamp: 3500000, value: 42 }] }] });

function renderCanvas(dashboard: Dashboard) {
  vi.stubGlobal("IntersectionObserver", undefined);
  const onLayout = vi.fn();
  render(
    <DashboardCanvas
      dashboard={dashboard}
      providers={exampleProviders}
      fetcher={fetcher()}
      end={3600}
      editing
      onSelect={vi.fn()}
      onLayout={onLayout}
    />,
  );
  return { onLayout };
}

it("Alt+ArrowDown on a focused widget swaps it with the widget below and announces its new place", () => {
  const { onLayout } = renderCanvas(stackedDashboard());
  const requests = screen.getByRole("article", { name: "Requests" });
  expect(requests).toHaveAttribute("tabindex", "0");
  expect(requests.getAttribute("aria-keyshortcuts")).toContain("Alt+ArrowDown");
  fireEvent.keyDown(requests, { key: "ArrowDown", altKey: true });
  expect(onLayout).toHaveBeenCalledTimes(1);
  expect(positions(onLayout.mock.calls[0][0])).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
  expect(liveText()).toBe("Moved Requests down, below Errors: row 5, columns 1 to 6.");
});

function widgetAt(id: string, title: string, layout: { x: number; y: number; w: number; h: number }): Dashboard["widgets"][number] {
  return { ...exampleDashboard.widgets[0], id, title, layout };
}

it("announces the other widgets a move carries past, in the singular for one", () => {
  const { onLayout } = renderCanvas(structuredClone({
    ...exampleDashboard,
    widgets: [
      widgetAt("requests", "Requests", { x: 0, y: 0, w: 12, h: 4 }),
      widgetAt("errors", "Errors", { x: 0, y: 4, w: 3, h: 2 }),
      widgetAt("latency", "Latency", { x: 3, y: 4, w: 9, h: 6 }),
    ],
  }));
  fireEvent.keyDown(screen.getByRole("article", { name: "Requests" }), { key: "ArrowDown", altKey: true });
  expect(positions(onLayout.mock.calls[0][0])).toEqual({ requests: [0, 6, 12, 4], errors: [0, 0, 3, 2], latency: [3, 0, 9, 6] });
  expect(liveText()).toBe("Moved Requests down, below Errors and 1 other widget: row 7, columns 1 to 12.");
});

it("announces every stat a full-width widget moves past, in the plural for several", () => {
  const { onLayout } = renderCanvas(structuredClone({
    ...exampleDashboard,
    widgets: [
      widgetAt("requests", "Requests", { x: 0, y: 0, w: 12, h: 4 }),
      widgetAt("stat-one", "Stat one", { x: 0, y: 4, w: 3, h: 2 }),
      widgetAt("stat-two", "Stat two", { x: 3, y: 4, w: 3, h: 2 }),
      widgetAt("stat-three", "Stat three", { x: 6, y: 4, w: 3, h: 2 }),
      widgetAt("stat-four", "Stat four", { x: 9, y: 4, w: 3, h: 2 }),
    ],
  }));
  fireEvent.keyDown(screen.getByRole("article", { name: "Requests" }), { key: "ArrowDown", altKey: true });
  expect(positions(onLayout.mock.calls[0][0])).toEqual({
    requests: [0, 2, 12, 4],
    "stat-one": [0, 0, 3, 2],
    "stat-two": [3, 0, 3, 2],
    "stat-three": [6, 0, 3, 2],
    "stat-four": [9, 0, 3, 2],
  });
  expect(liveText()).toBe("Moved Requests down, below Stat one and 3 other widgets: row 3, columns 1 to 12.");
});

it("leaves plain arrow keys to the page and never edits the layout with them", () => {
  const { onLayout } = renderCanvas(stackedDashboard());
  const requests = screen.getByRole("article", { name: "Requests" });
  expect(fireEvent.keyDown(requests, { key: "ArrowDown" })).toBe(true);
  expect(onLayout).not.toHaveBeenCalled();
});

it("Alt+Shift+ArrowRight widens the widget by one column and announces its size", () => {
  const { onLayout } = renderCanvas(stackedDashboard());
  fireEvent.keyDown(screen.getByRole("article", { name: "Requests" }), { key: "ArrowRight", altKey: true, shiftKey: true });
  expect(positions(onLayout.mock.calls[0][0]).requests).toEqual([0, 0, 7, 4]);
  expect(liveText()).toBe("Resized Requests to 7 columns by 4 rows.");
});

it("announces why a move is unavailable instead of doing nothing silently", () => {
  const { onLayout } = renderCanvas(stackedDashboard());
  fireEvent.keyDown(screen.getByRole("article", { name: "Errors" }), { key: "ArrowDown", altKey: true });
  expect(onLayout).not.toHaveBeenCalled();
  expect(liveText()).toBe("Errors: Nothing below this widget in its columns.");
});

it.each([700, 400])("offers no keyboard layout edits at %dpx, off the wide canvas", (width) => {
  rgl.width = width;
  const { onLayout } = renderCanvas(stackedDashboard());
  const requests = screen.getByRole("article", { name: "Requests" });
  expect(requests).not.toHaveAttribute("tabindex");
  expect(fireEvent.keyDown(requests, { key: "ArrowDown", altKey: true })).toBe(true);
  expect(onLayout).not.toHaveBeenCalled();
});

it("names the keyboard shortcuts in the widget's edit affordance", () => {
  renderCanvas(stackedDashboard());
  const grip = screen.getByRole("article", { name: "Requests" }).querySelector(".insights-drag-handle");
  expect(grip).toHaveAttribute("title", "Drag to move widget. Alt+Arrow keys move it; Alt+Shift+Arrow keys resize it.");
});

it("settles a drag past the widget below through the grid's compactor, for the preview and the drop", () => {
  const { onLayout } = renderCanvas(stackedDashboard());
  rgl.props.onDragStart(rgl.props.layout, { i: "requests", x: 0, y: 0, w: 6, h: 4 });
  const preview = rgl.props.compactor.compact([{ i: "requests", x: 0, y: 6, w: 6, h: 4 }, { i: "errors", x: 0, y: 4, w: 6, h: 4 }], 12);
  expect(positions(preview)).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
  rgl.props.onDragStop(preview);
  expect(onLayout).toHaveBeenCalledWith(preview);
});

it("shows a drop into empty space compacted to the top as the drag target", () => {
  renderCanvas(stackedDashboard());
  rgl.props.onDragStart(rgl.props.layout, { i: "requests", x: 0, y: 0, w: 6, h: 4 });
  const preview = rgl.props.compactor.compact([{ i: "requests", x: 6, y: 30, w: 6, h: 4 }, { i: "errors", x: 0, y: 4, w: 6, h: 4 }], 12);
  expect(positions(preview)).toEqual({ requests: [6, 0, 6, 4], errors: [0, 0, 6, 4] });
});

it("records a keyboard move as one document edit that Undo restores", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  const withLayout = (current: Dashboard, layout: Layout): Dashboard => ({
    ...current,
    widgets: current.widgets.map((widget) => {
      const position = layout.find((item) => item.i === widget.id);
      return position ? { ...widget, layout: { x: position.x, y: position.y, w: position.w, h: position.h } } : widget;
    }),
  });
  const initial = stackedDashboard();
  const queries = fetcher();
  function History() {
    const history = useDashboardHistory(initial);
    return (
      <>
        <button type="button" onClick={history.undo}>Undo</button>
        <DashboardCanvas
          dashboard={history.dashboard}
          providers={exampleProviders}
          fetcher={queries}
          end={3600}
          editing
          onSelect={vi.fn()}
          onLayout={(layout) => history.update((current) => withLayout(current, layout))}
        />
      </>
    );
  }
  render(<History />);
  fireEvent.keyDown(screen.getByRole("article", { name: "Requests" }), { key: "ArrowDown", altKey: true });
  expect(positions(rgl.props.layout)).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(positions(rgl.props.layout)).toEqual({ requests: [0, 0, 6, 4], errors: [0, 4, 6, 4] });
  // A stable keyboard callback must read the restored layout, not its first
  // render or the layout before Undo.
  fireEvent.keyDown(screen.getByRole("article", { name: "Requests" }), { key: "ArrowDown", altKey: true });
  expect(positions(rgl.props.layout)).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
});

// The tile actions menu: the same steps as the keys, offered at every width in edit mode.
function renderEdit(dashboard: Dashboard, props: Partial<Parameters<typeof DashboardCanvas>[0]> = {}) {
  vi.stubGlobal("IntersectionObserver", undefined);
  const onLayout = vi.fn();
  render(
    <DashboardCanvas
      dashboard={dashboard}
      providers={exampleProviders}
      fetcher={fetcher()}
      end={3600}
      editing
      onSelect={vi.fn()}
      onLayout={onLayout}
      {...props}
    />,
  );
  return { onLayout };
}
const menuLabels = () => screen.getAllByRole("menuitem").map((item) => item.getAttribute("data-label"));

it("offers no tile actions menu in view mode", () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  render(<DashboardCanvas dashboard={stackedDashboard()} providers={exampleProviders} fetcher={fetcher()} end={3600} editing={false} onSelect={vi.fn()} onLayout={vi.fn()} />);
  expect(document.querySelector("[data-widget-actions]")).toBeNull();
});

it("lists every wide-canvas step, Duplicate and Remove under the tile's actions menu", () => {
  renderEdit(stackedDashboard(), { onDuplicate: vi.fn(), onRemove: vi.fn() });
  const trigger = screen.getByRole("button", { name: "Actions for Requests" });
  expect(trigger).toHaveAttribute("data-widget-actions", "requests");
  fireEvent.click(trigger);
  expect(menuLabels()).toEqual(["Edit chart", "Duplicate", "Move up", "Move down", "Move left", "Move right", "Taller", "Shorter", "Wider", "Narrower", "Remove"]);
});

it("hides the wide-only Left, Right, Wider and Narrower steps below the wide canvas", () => {
  rgl.width = 700;
  renderEdit(stackedDashboard());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  expect(menuLabels()).toEqual(["Edit chart", "Move up", "Move down", "Taller", "Shorter"]);
});

it("Move down from the menu settles the same layout as the key and announces it", () => {
  const { onLayout } = renderEdit(stackedDashboard());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
  expect(onLayout).toHaveBeenCalledTimes(1);
  expect(positions(onLayout.mock.calls[0][0])).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
  expect(liveText()).toBe("Moved Requests down, below Errors: row 5, columns 1 to 6.");
});

it("below wide, a menu move edits the saved grid and announces the reading-order place", () => {
  rgl.width = 700;
  const { onLayout } = renderEdit(stackedDashboard());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
  expect(positions(onLayout.mock.calls[0][0])).toEqual({ requests: [0, 4, 6, 4], errors: [0, 0, 6, 4] });
  expect(liveText()).toBe("Moved Requests down: 2nd of 2.");
});

it("Edit chart, Duplicate and Remove from the menu call the canvas's handlers for that tile", () => {
  const onSelect = vi.fn();
  const onDuplicate = vi.fn();
  const onRemove = vi.fn();
  renderEdit(stackedDashboard(), { onSelect, onDuplicate, onRemove });
  fireEvent.click(screen.getByRole("button", { name: "Actions for Errors" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit chart" }));
  expect(onSelect).toHaveBeenCalledWith("errors");
  fireEvent.click(screen.getByRole("button", { name: "Actions for Errors" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Duplicate/ }));
  expect(onDuplicate).toHaveBeenCalledWith("errors");
  fireEvent.click(screen.getByRole("button", { name: "Actions for Errors" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  expect(onRemove).toHaveBeenCalledWith("errors");
});

it("disables Duplicate with its reason at the widget limit and does not call it", () => {
  const onDuplicate = vi.fn();
  renderEdit(stackedDashboard(), { onDuplicate, duplicateBlocked: "A dashboard supports up to 48 widgets." });
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  const duplicate = screen.getByRole("menuitem", { name: /Duplicate/ });
  expect(duplicate).toHaveAttribute("aria-disabled", "true");
  expect(duplicate).toHaveTextContent("A dashboard supports up to 48 widgets.");
  fireEvent.click(duplicate);
  expect(onDuplicate).not.toHaveBeenCalled();
});

it("leaves Duplicate and Remove out when the host does not pass them", () => {
  renderEdit(stackedDashboard());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  expect(menuLabels()).not.toContain("Duplicate");
  expect(menuLabels()).not.toContain("Remove");
});

it("focus falls back past a hidden Edit chip to the visible actions trigger", () => {
  document.body.innerHTML = '<div id="tile"><button data-widget-edit="a"></button><button data-widget-actions="a"></button></div>';
  const tile = document.getElementById("tile")!;
  const gear = tile.querySelector<HTMLElement>("[data-widget-edit]")!;
  gear.checkVisibility = () => false;
  expect(visibleTileControl(tile, "[data-widget-edit], [data-widget-actions]")).toBe(tile.querySelector("[data-widget-actions]"));
  document.body.innerHTML = "";
});

it("disables a step that would change nothing, with its reason, and does not run it", () => {
  const { onLayout } = renderEdit(stackedDashboard());
  // Requests is the top row, so Move up has nowhere to go.
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  const up = screen.getByRole("menuitem", { name: /Move up/ });
  expect(up).toHaveAttribute("aria-disabled", "true");
  expect(up).toHaveTextContent("Nothing above this widget in its columns");
  fireEvent.click(up);
  expect(onLayout).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: /Move down/ })).not.toHaveAttribute("aria-disabled");
});

it("a menu's own Alt+Arrow keys do not also move the tile they are portalled from", () => {
  const { onLayout } = renderEdit(stackedDashboard());
  fireEvent.click(screen.getByRole("button", { name: "Actions for Requests" }));
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Move down" }), { key: "ArrowDown", altKey: true });
  expect(onLayout).not.toHaveBeenCalled();
});

it("the context-menu key and Shift+F10 on a focused tile open its actions menu, as a right-click would", () => {
  renderCanvas(stackedDashboard());
  const requests = screen.getByRole("article", { name: "Requests" });
  fireEvent.keyDown(requests, { key: "ContextMenu" });
  expect(screen.getByRole("menuitem", { name: "Edit chart" })).toBeInTheDocument();
  // The native contextmenu event that follows the key is cancelled, so the browser menu does not open over it.
  expect(fireEvent.contextMenu(requests)).toBe(false);
  // A later right-click is left to the browser.
  expect(fireEvent.contextMenu(requests)).toBe(true);
  fireEvent.keyDown(document.activeElement ?? requests, { key: "Escape" });
  fireEvent.keyDown(requests, { key: "F10", shiftKey: true });
  expect(screen.getByRole("menuitem", { name: "Edit chart" })).toBeInTheDocument();
  // F10 without Shift is left to the browser and the page.
  fireEvent.keyDown(document.activeElement ?? requests, { key: "Escape" });
  expect(fireEvent.keyDown(requests, { key: "F10" })).toBe(true);
  expect(screen.queryByRole("menuitem", { name: "Edit chart" })).toBeNull();
});
