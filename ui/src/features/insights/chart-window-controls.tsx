"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Series } from "./chart-data";
import { calendarDateTime } from "./chart-presentation";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import { TimeWindowLens } from "./time-window-lens";
import {
  formatWindowDuration,
  moveTimeWindowEdge,
  normalizeTimeWindow,
  sameTimeWindow,
  timeWindowStep,
  type ChartTimeWindow,
} from "./time-window";
import styles from "./chart-window-controls.module.css";

/* ---------- Displayed window ---------- */

export interface ChartWindowState {
  /** The window the chart draws: the full extent unless a zoom is committed for this revision. */
  window: ChartTimeWindow;
  /** The extent the chart can zoom into. */
  full: ChartTimeWindow;
  zoomed: boolean;
  canUndo: boolean;
  /** Whether the extent is wide enough to zoom into at all. */
  enabled: boolean;
  minimumSpan: number;
  /** Keyboard step for a handle: one percent of the extent, never below the minimum span. */
  step: number;
  /** Commits a zoom. Returns false when the window is unchanged, or narrower than the minimum span. */
  commit: (candidate: ChartTimeWindow) => boolean;
  reset: () => void;
  undo: () => void;
}

interface WindowHistoryState {
  revision: unknown;
  start: number | null;
  end: number | null;
  /** Null shows the full extent. */
  window: ChartTimeWindow | null;
  history: ChartTimeWindow[];
}

/**
 * A chart-local window over immutable observations. A new revision or extent starts from the full view, so an old
 * zoom never applies to new data. Undo keeps twelve steps.
 */
export function useChartTimeWindow(extent: ChartTimeWindow | null, revision: unknown, minimumSpan: number): ChartWindowState {
  const start = extent?.start ?? null;
  const end = extent?.end ?? null;
  const full: ChartTimeWindow = extent ?? { start: 0, end: 1 };
  const belongsHere = (previous: WindowHistoryState) => Object.is(previous.revision, revision) && previous.start === start && previous.end === end;
  const fresh = (): WindowHistoryState => ({ revision, start, end, window: null, history: [] });
  const [state, setState] = useState<WindowHistoryState>(fresh);
  const live = belongsHere(state) ? state : fresh();
  const current = live.window ?? full;
  const commit = (candidate: ChartTimeWindow) => {
    if (!extent) return false;
    const accepted = normalizeTimeWindow(candidate, extent, minimumSpan);
    if (!accepted || sameTimeWindow(accepted, current)) return false;
    setState((previous) => {
      const base = belongsHere(previous) ? previous : fresh();
      return { revision, start, end, window: accepted, history: [...base.history, base.window ?? full].slice(-12) };
    });
    return true;
  };
  const reset = () => {
    if (extent) setState(fresh());
  };
  const undo = () => setState((previous) => {
    if (!belongsHere(previous) || previous.history.length === 0) return previous;
    return { ...previous, window: previous.history[previous.history.length - 1], history: previous.history.slice(0, -1) };
  });
  return {
    window: current,
    full,
    zoomed: !sameTimeWindow(current, full),
    canUndo: live.history.length > 0,
    enabled: !!extent && extent.end - extent.start > minimumSpan,
    minimumSpan,
    step: timeWindowStep(full, minimumSpan),
    commit,
    reset,
    undo,
  };
}

/* ---------- Pending selection with keyboard-adjustable edges ---------- */

export type WindowEdge = "start" | "end";

export interface ChartWindowSelection {
  /** The pending selection, or the displayed window when nothing is pending. */
  selection: ChartTimeWindow;
  pending: boolean;
  /** Moves one edge to a time. The opposite edge stays fixed, and the result is normalized. */
  moveEdge: (edge: WindowEdge, time: number) => void;
  /** Moves an edge by a number of keyboard steps. Negative values move it earlier. */
  nudgeEdge: (edge: WindowEdge, steps: number) => void;
  /** Commits the pending selection as the chart's window. */
  apply: () => boolean;
  /** Discards the pending selection and returns the handles to the displayed window. */
  cancel: () => void;
}

/** A selection is pending until it is applied, so keyboard edits never zoom the chart on every key press. */
export function useChartWindowSelection(state: ChartWindowState): ChartWindowSelection {
  const [draft, setDraft] = useState<{ base: ChartTimeWindow; window: ChartTimeWindow } | null>(null);
  const pendingWindow = draft && sameTimeWindow(draft.base, state.window) && !sameTimeWindow(draft.window, state.window) ? draft.window : null;
  const selection = pendingWindow ?? state.window;
  const moveEdge = (edge: WindowEdge, time: number) => {
    const next = moveTimeWindowEdge(selection, state.full, edge, time, state.minimumSpan);
    if (next) setDraft({ base: state.window, window: next });
  };
  const nudgeEdge = (edge: WindowEdge, steps: number) => {
    moveEdge(edge, (edge === "start" ? selection.start : selection.end) + steps * state.step);
  };
  const apply = () => {
    if (!pendingWindow) return false;
    const committed = state.commit(pendingWindow);
    setDraft(null);
    return committed;
  };
  return {
    selection,
    pending: pendingWindow !== null,
    moveEdge,
    nudgeEdge,
    apply,
    cancel: () => setDraft(null),
  };
}

/* ---------- Pointer brush (state only; the plot wires the handlers in) ---------- */

export interface BrushPoint { x: number; y: number; timestamp: number; inPlot: boolean }
export interface TimeBrushPreview { start: number; end: number; x1: number; x2: number }

export interface TimeWindowBrushOptions {
  enabled: boolean;
  revision: unknown;
  window: ChartTimeWindow;
  /** Maps a pointer position onto the plot, or returns null outside it. The plot owns the geometry. */
  point: (clientX: number, clientY: number) => BrushPoint | null;
  commit: (window: ChartTimeWindow) => boolean;
  /** Called once a drag crosses its threshold, so the host can close competing popups. */
  onStart: () => void;
}

const DRAG_THRESHOLD = 6;

/**
 * One pointer owner arbitrates a horizontal drag across the plot. A drag under six pixels is an ordinary click.
 * Escape cancels an active drag. A release commits the drag's interval, and the click that follows is suppressed.
 */
export function useTimeWindowBrush(options: TimeWindowBrushOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  type Drag = { id: number; owner: Element; start: BrushPoint; clientX: number; clientY: number; active: boolean; revision: unknown; window: ChartTimeWindow };
  const drag = useRef<Drag | null>(null);
  // A drag that began on another revision or window is stale. It never previews or commits against new data.
  const stale = (current: Drag) => !Object.is(current.revision, latest.current.revision) || !sameTimeWindow(current.window, latest.current.window);
  const suppressClick = useRef(false);
  const previewRef = useRef<TimeBrushPreview | null>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<TimeBrushPreview | null>(null);
  const paint = (next: TimeBrushPreview) => {
    previewRef.current = next;
    if (frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setPreview(previewRef.current);
      });
  };
  const finish = (clear = true) => {
    const current = drag.current;
    drag.current = null;
    if (current?.active) suppressClick.current = true;
    if (current?.owner.hasPointerCapture(current.id)) current.owner.releasePointerCapture(current.id);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    previewRef.current = null;
    if (clear) setPreview(null);
  };
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    const blur = () => finish();
    document.addEventListener("keydown", escape, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", blur);
      finish(false);
    };
  }, []);
  return {
    preview,
    get active() {
      return !!drag.current?.active;
    },
    handlers: {
      onPointerDownCapture: (event: PointerEvent<Element>) => {
        if (!latest.current.enabled || event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button,input,select,summary,a,[role=slider]")) return;
        const point = latest.current.point(event.clientX, event.clientY);
        if (!point?.inPlot) return;
        suppressClick.current = false;
        // Keep the gesture from a newly opened inspection until it crosses the drag threshold.
        const owner = (event.target as Element).closest("svg") ?? event.currentTarget;
        drag.current = { id: event.pointerId, owner, start: point, clientX: event.clientX, clientY: event.clientY, active: false, revision: latest.current.revision, window: latest.current.window };
        owner.setPointerCapture(event.pointerId);
      },
      onPointerMoveCapture: (event: PointerEvent<Element>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!latest.current.enabled || (event.buttons & 1) === 0 || stale(current)) {
          finish();
          return;
        }
        const point = latest.current.point(event.clientX, event.clientY);
        if (!point) return;
        if (!current.active) {
          const dx = Math.abs(event.clientX - current.clientX), dy = Math.abs(event.clientY - current.clientY);
          // A touch that moves mostly vertically is a scroll, not a brush.
          if (event.pointerType === "touch" && dy > dx && dy > DRAG_THRESHOLD) {
            finish();
            return;
          }
          if (dx < DRAG_THRESHOLD) return;
          current.active = true;
          latest.current.onStart();
        }
        event.preventDefault();
        event.stopPropagation();
        paint({ start: current.start.timestamp, end: point.timestamp, x1: current.start.x, x2: point.x });
      },
      onPointerUpCapture: (event: PointerEvent<Element>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!latest.current.enabled || stale(current)) {
          finish();
          return;
        }
        if (current.active) {
          event.preventDefault();
          event.stopPropagation();
          const point = latest.current.point(event.clientX, event.clientY);
          if (point) latest.current.commit({ start: current.start.timestamp, end: point.timestamp });
        }
        finish();
      },
      onPointerLeave: () => {
        if (drag.current && !drag.current.active) finish();
      },
      onPointerCancelCapture: () => finish(),
      onLostPointerCapture: (event: PointerEvent<Element>) => {
        if (drag.current?.id === event.pointerId) finish();
      },
      // Native dragging of text or images would otherwise cancel a pointer brush.
      onDragStartCapture: (event: DragEvent<Element>) => event.preventDefault(),
      onMouseMoveCapture: (event: MouseEvent<Element>) => {
        if (drag.current?.active) event.stopPropagation();
      },
      onClickCapture: (event: MouseEvent<Element>) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}

/* ---------- Controls ---------- */

type CompareProps = {
  title: string;
  series: Series[];
  unit: string;
  decimals?: number;
  maxSeries?: number;
  seriesUnits?: readonly string[];
};

/**
 * The window controls beside a chart. Two keyboard-adjustable handles edit a pending selection, which applies only on
 * Enter or Apply. The Compare window dialog stays as the non-drag path, and is shown when `compare` is supplied.
 */
export function ChartWindowControls({ state, selection, compare, label = "Chart window" }: {
  state: ChartWindowState;
  selection: ChartWindowSelection;
  compare?: CompareProps;
  label?: string;
}) {
  const timeZone = useDashboardTimeZone();
  const { start, end } = selection.selection;
  return <div className={styles.controls} role="group" aria-label={label} data-chart-window-controls=""
    data-chart-window-start={state.window.start} data-chart-window-end={state.window.end} data-chart-window-zoomed={state.zoomed || undefined}>
    {state.enabled
      ? <SelectionTrack state={state} selection={selection} timeZone={timeZone} />
      : <p className={styles.note}>Not enough distinct times to zoom into.</p>}
    <p className={styles.summary} data-chart-window-summary="">
      {state.zoomed ? "Chart window" : "Full range"}: {calendarDateTime(start, timeZone)} – {calendarDateTime(end, timeZone)} · {formatWindowDuration(end - start)}
      {selection.pending && <span className={styles.pending}> · Pending selection</span>}
    </p>
    <div className={styles.actions}>
      {selection.pending && <button type="button" onClick={() => selection.apply()}>Apply window</button>}
      {selection.pending && <button type="button" onClick={selection.cancel}>Discard selection</button>}
      {state.canUndo && <button type="button" onClick={state.undo}>Undo zoom</button>}
      {!compare && state.zoomed && <button type="button" onClick={state.reset}>Reset zoom</button>}
      {compare && <TimeWindowLens
        title={compare.title}
        series={compare.series}
        unit={compare.unit}
        decimals={compare.decimals}
        maxSeries={compare.maxSeries}
        seriesUnits={compare.seriesUnits}
        zoom={state.zoomed ? state.window : undefined}
        onZoom={(window) => { state.commit(window); }}
        onReset={state.reset}
      />}
    </div>
  </div>;
}

function SelectionTrack({ state, selection, timeZone }: { state: ChartWindowState; selection: ChartWindowSelection; timeZone: string }) {
  const { full, minimumSpan } = state;
  const span = Math.max(1, full.end - full.start);
  const at = (time: number) => ((time - full.start) / span) * 100;
  const { start, end } = selection.selection;

  const onKeyDown = (edge: WindowEdge) => (event: KeyboardEvent<HTMLSpanElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        selection.nudgeEdge(edge, -step);
        return handled();
      case "ArrowRight":
      case "ArrowUp":
        selection.nudgeEdge(edge, step);
        return handled();
      case "PageDown":
        selection.nudgeEdge(edge, -10);
        return handled();
      case "PageUp":
        selection.nudgeEdge(edge, 10);
        return handled();
      case "Home":
        selection.moveEdge(edge, edge === "start" ? full.start : start + minimumSpan);
        return handled();
      case "End":
        selection.moveEdge(edge, edge === "start" ? end - minimumSpan : full.end);
        return handled();
      case "Enter":
        if (selection.pending) {
          selection.apply();
          return handled();
        }
        return;
      case "Escape":
        if (selection.pending) {
          selection.cancel();
          return handled();
        }
        return;
      default:
        return;
    }
  };

  const handle = (edge: WindowEdge) => {
    const value = edge === "start" ? start : end;
    const low = edge === "start" ? full.start : start + minimumSpan;
    const high = edge === "start" ? end - minimumSpan : full.end;
    return <span
      role="slider"
      tabIndex={0}
      aria-label={edge === "start" ? "Window start" : "Window end"}
      aria-valuemin={low}
      aria-valuemax={high}
      aria-valuenow={value}
      aria-valuetext={calendarDateTime(value, timeZone)}
      data-window-handle={edge}
      className={styles.handle}
      style={{ left: `${at(value)}%` }}
      onKeyDown={onKeyDown(edge)}
    />;
  };

  return <div className={styles.track} data-window-track="">
    <span className={styles.trackFill} style={{ left: `${at(start)}%`, width: `${Math.max(0, at(end) - at(start))}%` }} aria-hidden="true" />
    {handle("start")}
    {handle("end")}
  </div>;
}
