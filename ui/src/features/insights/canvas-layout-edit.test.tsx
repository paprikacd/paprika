import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Compactor, Layout, LayoutItem } from "react-grid-layout";
import { DashboardCanvas } from "./canvas";
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
const liveText = () => document.querySelector('[aria-live="polite"]')?.textContent;
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
});
