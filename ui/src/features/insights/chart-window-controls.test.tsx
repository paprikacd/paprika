import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import {
  ChartWindowControls,
  useChartTimeWindow,
  useChartWindowSelection,
  useTimeWindowBrush,
  type BrushPoint,
  type ChartWindowState,
} from "./chart-window-controls";
import type { Series } from "./chart-data";
import type { ChartTimeWindow } from "./time-window";

const extent: ChartTimeWindow = { start: 0, end: 10_000 };

afterEach(cleanup);

describe("chart window state", () => {
  it("starts at the full extent, with no zoom and nothing to undo", () => {
    const { result } = renderHook(() => useChartTimeWindow(extent, "r1", 100));
    expect(result.current.window).toEqual(extent);
    expect(result.current.zoomed).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.enabled).toBe(true);
    expect(result.current.step).toBe(100);
  });

  it("commits a zoom, normalized to the extent, and undoes it", () => {
    const { result } = renderHook(() => useChartTimeWindow(extent, "r1", 100));
    let accepted = false;
    act(() => { accepted = result.current.commit({ start: 8000.4, end: 2000 }); });
    expect(accepted).toBe(true);
    expect(result.current.window).toEqual({ start: 2000, end: 8000 });
    expect(result.current.zoomed).toBe(true);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.window).toEqual(extent);
    expect(result.current.zoomed).toBe(false);
  });

  it("refuses an unchanged window and a window narrower than the minimum span", () => {
    const { result } = renderHook(() => useChartTimeWindow(extent, "r1", 500));
    let outcome: boolean[] = [];
    act(() => { outcome = [result.current.commit(extent), result.current.commit({ start: 4000, end: 4200 })]; });
    expect(outcome).toEqual([false, false]);
    expect(result.current.zoomed).toBe(false);
  });

  it("returns to the full view on reset", () => {
    const { result } = renderHook(() => useChartTimeWindow(extent, "r1", 100));
    act(() => { result.current.commit({ start: 1000, end: 3000 }); });
    act(() => result.current.reset());
    expect(result.current.window).toEqual(extent);
    expect(result.current.canUndo).toBe(false);
  });

  it("discards a zoom when the revision or the extent changes, so old zooms never apply to new data", () => {
    const { result, rerender } = renderHook(({ revision, bounds }) => useChartTimeWindow(bounds, revision, 100), {
      initialProps: { revision: "r1" as unknown, bounds: extent },
    });
    act(() => { result.current.commit({ start: 1000, end: 3000 }); });
    rerender({ revision: "r2", bounds: extent });
    expect(result.current.window).toEqual(extent);
    act(() => { result.current.commit({ start: 1000, end: 3000 }); });
    rerender({ revision: "r2", bounds: { start: 0, end: 20_000 } });
    expect(result.current.window).toEqual({ start: 0, end: 20_000 });
  });

  it("keeps twelve undo steps", () => {
    const { result } = renderHook(() => useChartTimeWindow(extent, "r1", 10));
    for (let step = 0; step < 14; step++) act(() => { result.current.commit({ start: 100 * step, end: 10_000 - step }); });
    let undone = 0;
    while (result.current.canUndo) {
      act(() => result.current.undo());
      undone++;
    }
    expect(undone).toBe(12);
  });

  it("is not enabled when the extent is narrower than the minimum span", () => {
    const { result } = renderHook(() => useChartTimeWindow({ start: 0, end: 50 }, "r1", 100));
    expect(result.current.enabled).toBe(false);
  });
});

describe("pending selection", () => {
  function setup() {
    const state = renderHook(() => useChartTimeWindow(extent, "r1", 100));
    const selection = renderHook(() => useChartWindowSelection(state.result.current));
    return { state, selection };
  }

  it("keeps edits pending until they are applied", () => {
    const { state, selection } = setup();
    act(() => selection.result.current.moveEdge("start", 4000));
    expect(selection.result.current.pending).toBe(true);
    expect(selection.result.current.selection).toEqual({ start: 4000, end: 10_000 });
    expect(state.result.current.window).toEqual(extent);
    act(() => { selection.result.current.apply(); });
    expect(state.result.current.window).toEqual({ start: 4000, end: 10_000 });
    expect(selection.result.current.pending).toBe(false);
  });

  it("nudges an edge by keyboard steps of one percent of the extent", () => {
    const { selection } = setup();
    act(() => selection.result.current.nudgeEdge("end", -3));
    expect(selection.result.current.selection).toEqual({ start: 0, end: 9700 });
    act(() => selection.result.current.nudgeEdge("start", 2));
    expect(selection.result.current.selection).toEqual({ start: 200, end: 9700 });
  });

  it("keeps the opposite edge a minimum span away, and never leaves the extent", () => {
    const { selection } = setup();
    act(() => selection.result.current.moveEdge("end", -5000));
    expect(selection.result.current.selection).toEqual({ start: 0, end: 100 });
    act(() => selection.result.current.cancel());
    act(() => selection.result.current.moveEdge("start", 99_999));
    expect(selection.result.current.selection).toEqual({ start: 9900, end: 10_000 });
  });

  it("discards a pending selection without committing it", () => {
    const { state, selection } = setup();
    act(() => selection.result.current.moveEdge("start", 6000));
    act(() => selection.result.current.cancel());
    expect(selection.result.current.pending).toBe(false);
    expect(state.result.current.window).toEqual(extent);
    expect(selection.result.current.apply()).toBe(false);
  });
});

describe("pointer brush", () => {
  const owner = { setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn() };
  // A press on a control matches the control selector; a press on the plot's svg owns the gesture.
  const control = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
  const plot = { closest: (selector: string) => (selector === "svg" ? owner : null) };
  // requestAnimationFrame is queued, so a test decides when the preview paints.
  let frames: FrameRequestCallback[] = [];
  const flush = () => act(() => { frames.splice(0).forEach((callback) => callback(0)); });
  const point = (x: number, y: number): BrushPoint | null => ({ x, y, timestamp: x * 10, inPlot: true });

  function event(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      clientX: 100,
      clientY: 20,
      target: plot,
      currentTarget: plot,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    };
  }
  const asPointer = (value: object) => value as unknown as ReactPointerEvent<Element>;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    owner.setPointerCapture.mockClear();
    owner.releasePointerCapture.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function brush(overrides: Partial<Parameters<typeof useTimeWindowBrush>[0]> = {}) {
    const commit = vi.fn(() => true);
    const onStart = vi.fn();
    const hook = renderHook(() => useTimeWindowBrush({ enabled: true, revision: "r1", window: extent, point, commit, onStart, ...overrides }));
    return { hook, commit, onStart };
  }

  it("treats a movement under six pixels as an ordinary click", () => {
    const { hook, commit } = brush();
    act(() => { hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 104 }))); });
    act(() => { hook.result.current.handlers.onPointerUpCapture(asPointer(event({ clientX: 104 }))); });
    expect(commit).not.toHaveBeenCalled();
    expect(hook.result.current.preview).toBeNull();
  });

  it("previews a drag past the threshold and commits its interval on release", () => {
    const { hook, commit, onStart } = brush();
    act(() => { hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 180 }))); });
    flush();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(hook.result.current.preview).toMatchObject({ start: 1000, end: 1800 });
    act(() => { hook.result.current.handlers.onPointerUpCapture(asPointer(event({ clientX: 180 }))); });
    expect(commit).toHaveBeenCalledWith({ start: 1000, end: 1800 });
    expect(owner.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("suppresses the click that ends a committed drag", () => {
    const { hook } = brush();
    act(() => { hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 200 }))); });
    act(() => { hook.result.current.handlers.onPointerUpCapture(asPointer(event({ clientX: 200 }))); });
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    hook.result.current.handlers.onClickCapture(click as unknown as ReactMouseEvent<Element>);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(click.stopPropagation).toHaveBeenCalled();
  });

  it("cancels an active drag with Escape, so release commits nothing", () => {
    const { hook, commit } = brush();
    act(() => { hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 180 }))); });
    flush();
    expect(hook.result.current.preview).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); });
    expect(hook.result.current.preview).toBeNull();
    act(() => { hook.result.current.handlers.onPointerUpCapture(asPointer(event({ clientX: 180 }))); });
    expect(commit).not.toHaveBeenCalled();
  });

  it("drops a drag that began before the revision changed, so it never commits against new data", () => {
    const commit = vi.fn(() => true);
    const { result, rerender } = renderHook(({ revision }) => useTimeWindowBrush({ enabled: true, revision, window: extent, point, commit, onStart: vi.fn() }), {
      initialProps: { revision: "r1" as unknown },
    });
    act(() => { result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 180 }))); });
    flush();
    expect(result.current.preview).not.toBeNull();
    rerender({ revision: "r2" });
    act(() => { result.current.handlers.onPointerUpCapture(asPointer(event({ clientX: 180 }))); });
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
  });

  it("ignores presses outside the plot, on controls, and while the brush is disabled", () => {
    const outside = brush({ point: () => ({ x: 0, y: 0, timestamp: 0, inPlot: false }) });
    act(() => { outside.hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { outside.hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 200 }))); });
    expect(outside.hook.result.current.preview).toBeNull();

    const onControl = brush();
    act(() => { onControl.hook.result.current.handlers.onPointerDownCapture(asPointer(event({ target: control }))); });
    act(() => { onControl.hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 200 }))); });
    expect(onControl.hook.result.current.preview).toBeNull();

    const disabled = brush({ enabled: false });
    act(() => { disabled.hook.result.current.handlers.onPointerDownCapture(asPointer(event())); });
    act(() => { disabled.hook.result.current.handlers.onPointerMoveCapture(asPointer(event({ clientX: 200 }))); });
    expect(disabled.hook.result.current.preview).toBeNull();
  });
});

describe("window controls", () => {
  const series: Series[] = [{ name: "cpu", labels: {}, points: [{ timestamp: 0, value: 1 }, { timestamp: 5000, value: 2 }, { timestamp: 10_000, value: 3 }] }];

  function Harness({ bounds = extent, compare }: { bounds?: ChartTimeWindow | null; compare?: boolean }) {
    const state: ChartWindowState = useChartTimeWindow(bounds, "r1", 100);
    const selection = useChartWindowSelection(state);
    return <DashboardTimeZoneProvider timeZone="UTC">
      <ChartWindowControls state={state} selection={selection} compare={compare ? { title: "CPU", series, unit: "%" } : undefined} />
    </DashboardTimeZoneProvider>;
  }

  it("exposes the start and end selection as keyboard-adjustable sliders", () => {
    render(<Harness />);
    const start = screen.getByRole("slider", { name: "Window start" });
    const end = screen.getByRole("slider", { name: "Window end" });
    expect(start).toHaveAttribute("aria-valuenow", "0");
    expect(start).toHaveAttribute("aria-valuemin", "0");
    expect(start).toHaveAttribute("aria-valuemax", "9900");
    expect(end).toHaveAttribute("aria-valuenow", "10000");
    expect(end).toHaveAttribute("aria-valuetext", expect.stringContaining("UTC"));
  });

  it("applies a pending keyboard selection on Enter, and shows the chart as zoomed", () => {
    const { container } = render(<Harness />);
    const end = screen.getByRole("slider", { name: "Window end" });
    fireEvent.keyDown(end, { key: "ArrowLeft", shiftKey: true });
    expect(end).toHaveAttribute("aria-valuenow", "9000");
    expect(screen.getByRole("button", { name: "Apply window" })).toBeInTheDocument();
    expect(container.querySelector("[data-chart-window-zoomed]")).toBeNull();
    fireEvent.keyDown(end, { key: "Enter" });
    expect(container.querySelector("[data-chart-window-zoomed]")).not.toBeNull();
    expect(container.querySelector("[data-chart-window-end]")).toHaveAttribute("data-chart-window-end", "9000");
    expect(screen.getByRole("button", { name: "Undo zoom" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply window" })).toBeNull();
  });

  it("discards a pending keyboard selection on Escape, and jumps to the limits with Home and End", () => {
    const { container } = render(<Harness />);
    const start = screen.getByRole("slider", { name: "Window start" });
    fireEvent.keyDown(start, { key: "PageUp" });
    expect(start).toHaveAttribute("aria-valuenow", "1000");
    fireEvent.keyDown(start, { key: "Escape" });
    expect(start).toHaveAttribute("aria-valuenow", "0");
    fireEvent.keyDown(start, { key: "End" });
    expect(start).toHaveAttribute("aria-valuenow", "9900");
    fireEvent.keyDown(start, { key: "Home" });
    expect(start).toHaveAttribute("aria-valuenow", "0");
    expect(container.querySelector("[data-chart-window-zoomed]")).toBeNull();
  });

  it("keeps the Compare window dialog as the non-drag path", () => {
    render(<Harness compare />);
    expect(screen.getByRole("button", { name: "Compare window for CPU" })).toBeInTheDocument();
  });

  it("offers a reset instead of the dialog where no comparison applies", () => {
    render(<Harness />);
    const end = screen.getByRole("slider", { name: "Window end" });
    fireEvent.keyDown(end, { key: "ArrowLeft" });
    fireEvent.keyDown(end, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare window for CPU" })).toBeNull();
  });

  it("explains, rather than offering handles, when the extent is too narrow to zoom", () => {
    render(<Harness bounds={{ start: 0, end: 50 }} />);
    expect(screen.getByText("Not enough distinct times to zoom into.")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
