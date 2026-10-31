import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from 'react';
import { formatWindowDuration, normalizeTimeWindow, sameTimeWindow, type ChartTimeWindow } from './time-window';
import styles from './time-window.module.css';

export function useChartTimeWindow(extent: ChartTimeWindow | null, revision: unknown, minimumSpan: number) {
  const fallback = extent ?? { start: 0, end: 1 };
  const [state, setState] = useState<{ revision: unknown; window: ChartTimeWindow; history: ChartTimeWindow[] }>({ revision, window: fallback, history: [] });
  const current = state.revision === revision && extent ? state.window : fallback;
  useEffect(() => { setState({ revision, window: fallback, history: [] }); }, [revision, extent?.start, extent?.end]);
  const commit = useCallback((candidate: ChartTimeWindow) => {
    if (!extent) return false;
    const accepted = normalizeTimeWindow(candidate, extent, minimumSpan);
    if (!accepted || sameTimeWindow(accepted, current)) return false;
    setState(previous => ({ revision, window: accepted, history: [...(previous.revision === revision ? previous.history : []), current].slice(-12) }));
    return true;
  }, [extent?.start, extent?.end, minimumSpan, current.start, current.end, revision]);
  const reset = () => { if (extent) setState({ revision, window: extent, history: [] }); };
  const undo = () => setState(previous => previous.revision !== revision || !previous.history.length ? previous : { revision, window: previous.history.at(-1)!, history: previous.history.slice(0, -1) });
  return { window: current, full: fallback, commit, reset, undo, zoomed: !!extent && !sameTimeWindow(current, extent), canUndo: state.revision === revision && state.history.length > 0, minimumSpan, enabled: !!extent && extent.end - extent.start > minimumSpan };
}

interface BrushPoint { x: number; y: number; timestamp: number; inPlot: boolean }
export interface TimeBrushPreview { start: number; end: number; x1: number; x2: number }

/** One pointer owner arbitrates brushing with existing hover/pin behavior. */
export function useTimeWindowBrush(options: {
  enabled: boolean; revision: unknown; window: ChartTimeWindow;
  point: (clientX: number, clientY: number) => BrushPoint | null;
  commit: (window: ChartTimeWindow) => boolean; onStart: () => void;
}) {
  const latest = useRef(options); latest.current = options;
  const drag = useRef<{ id: number; owner: Element; start: BrushPoint; clientX: number; clientY: number; active: boolean } | null>(null);
  const suppressClick = useRef(false), previewRef = useRef<TimeBrushPreview | null>(null), frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<TimeBrushPreview | null>(null);
  const paint = (next: TimeBrushPreview) => {
    previewRef.current = next;
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; setPreview(previewRef.current); });
  };
  const finish = useCallback((clear = true) => {
    const current = drag.current; drag.current = null;
    if (current?.active) suppressClick.current = true;
    if (current?.owner.hasPointerCapture(current.id)) current.owner.releasePointerCapture(current.id);
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    previewRef.current = null;
    if (clear) setPreview(null);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(); } };
    const blur = () => finish();
    document.addEventListener('keydown', escape, true); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('keydown', escape, true); window.removeEventListener('blur', blur); finish(false); };
  }, [finish]);
  useEffect(() => { finish(); }, [options.revision, options.window.start, options.window.end, finish]);
  useEffect(() => { if (!options.enabled) finish(); }, [options.enabled, finish]);
  return {
    preview,
    get active() { return !!drag.current?.active; },
    handlers: {
      onPointerDownCapture: (event: PointerEvent<Element>) => {
        if (!latest.current.enabled || event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button,input,select,summary,a,[role=slider]')) return;
        const point = latest.current.point(event.clientX, event.clientY);
        if (!point?.inPlot) return;
        suppressClick.current = false;
        // Keep a newly opened inspection portal from stealing the gesture before
        // it crosses the drag threshold. The SVG retains native chart click
        // bubbling; capturing the outer wrapper would bypass that click owner.
        const owner = (event.target as Element).closest('svg') ?? event.currentTarget;
        drag.current = { id: event.pointerId, owner, start: point, clientX: event.clientX, clientY: event.clientY, active: false };
        owner.setPointerCapture(event.pointerId);
      },
      onPointerMoveCapture: (event: PointerEvent<Element>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!latest.current.enabled || (event.buttons & 1) === 0) { finish(); return; }
        const point = latest.current.point(event.clientX, event.clientY);
        if (!point) return;
        if (!current.active) {
          const dx = Math.abs(event.clientX - current.clientX), dy = Math.abs(event.clientY - current.clientY);
          if (event.pointerType === 'touch' && dy > dx && dy > 6) { finish(); return; }
          if (dx < 6) return;
          current.active = true; latest.current.onStart();
        }
        event.preventDefault(); event.stopPropagation();
        paint({ start: current.start.timestamp, end: point.timestamp, x1: current.start.x, x2: point.x });
      },
      onPointerUpCapture: (event: PointerEvent<Element>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!latest.current.enabled) { finish(); return; }
        if (current.active) {
          event.preventDefault(); event.stopPropagation();
          const point = latest.current.point(event.clientX, event.clientY);
          if (point) latest.current.commit({ start: current.start.timestamp, end: point.timestamp });
        }
        finish();
      },
      onPointerLeave: () => { if (drag.current && !drag.current.active) finish(); },
      onPointerCancelCapture: () => finish(),
      onLostPointerCapture: (event: PointerEvent<Element>) => { if (drag.current?.id === event.pointerId) finish(); },
      // Native HTML/text dragging otherwise cancels a repeated pointer brush.
      onDragStartCapture: (event: DragEvent<Element>) => event.preventDefault(),
      onMouseMoveCapture: (event: MouseEvent<Element>) => { if (drag.current?.active) event.stopPropagation(); },
      onClickCapture: (event: MouseEvent<Element>) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } },
    },
  };
}

function inputTime(value: number) { return new Date(value).toISOString().slice(0, 23); }
function parseInput(value: string) { return Date.parse(`${value}Z`); }
function shortTime(value: number, long: boolean) { const iso = new Date(value).toISOString(); return long ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 19); }

export function TimeWindowControls({ state, compact = false, description = 'Only this plot changes. Dashboard time, summaries and source observations stay unchanged.' }: { state: ReturnType<typeof useChartTimeWindow>; compact?: boolean; description?: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  const [start, setStart] = useState(inputTime(state.window.start)), [end, setEnd] = useState(inputTime(state.window.end)), [error, setError] = useState('');
  useEffect(() => { setStart(inputTime(state.window.start)); setEnd(inputTime(state.window.end)); setError(''); }, [state.window.start, state.window.end]);
  const long = state.full.end - state.full.start > 86400000;
  const close = () => { if (details.current) { details.current.open = false; details.current.querySelector('summary')?.focus(); } };
  return <div className={`paprika-time-window ${styles.controls} ${compact ? styles.compact : ''}`} data-time-window-start={state.window.start} data-time-window-end={state.window.end} data-time-window-zoomed={state.zoomed}>
    <span className={styles.hint}>{state.zoomed ? 'Chart window' : 'Drag across the plot to zoom'}</span>
    {state.zoomed && <span className={styles.bounds}>{shortTime(state.window.start, long)} – {shortTime(state.window.end, long)} UTC</span>}
    {state.canUndo && <button type="button" onClick={state.undo}>Undo zoom</button>}
    {state.zoomed && <button type="button" onClick={state.reset}>Reset zoom</button>}
    <details ref={details} className={styles.editor} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <summary aria-label="Edit chart time window">{compact && !state.zoomed ? 'Zoom' : 'Time window'}</summary>
      <form className={styles.form} onSubmit={event => {
        event.preventDefault();
        // Native controls are the submission authority, including autofill and
        // date-picker changes that may precede React's next draft-state render.
        const submitted = new FormData(event.currentTarget);
        const requested = { start: parseInput(String(submitted.get('start') ?? '')), end: parseInput(String(submitted.get('end') ?? '')) };
        if (requested.end <= requested.start) { setError('End must be after start.'); return; }
        if (requested.start < state.full.start || requested.end > state.full.end) { setError('Choose a window within the available source data.'); return; }
        if (!normalizeTimeWindow(requested, state.full, state.minimumSpan)) { setError(`Select at least ${formatWindowDuration(state.minimumSpan)}.`); return; }
        state.commit(requested); close();
      }}>
        <strong>Chart time window</strong>
        <p>{description}</p>
        <label>Start (UTC)<input name="start" aria-label="Chart window start UTC" type="datetime-local" step="0.001" value={start} min={inputTime(state.full.start)} max={inputTime(state.full.end)} onChange={event => setStart(event.target.value)}/></label>
        <label>End (UTC)<input name="end" aria-label="Chart window end UTC" type="datetime-local" step="0.001" value={end} min={inputTime(state.full.start)} max={inputTime(state.full.end)} onChange={event => setEnd(event.target.value)}/></label>
        <span>Minimum {formatWindowDuration(state.minimumSpan)} · displayed {formatWindowDuration(state.window.end - state.window.start)}</span>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <footer><button type="button" onClick={() => { state.reset(); close(); }}>Full range</button><button type="submit">Apply window</button></footer>
      </form>
    </details>
  </div>;
}

export function TimeBrushOverlay({ preview, top, height, width }: { preview: TimeBrushPreview | null; top: number; height: number; width: number }) {
  if (!preview) return null;
  const left = Math.min(preview.x1, preview.x2), brushWidth = Math.abs(preview.x2 - preview.x1);
  return <div className={styles.overlay} style={{ left, top, width: brushWidth, height }} data-time-brush-selection aria-hidden="true"><span style={{ left: Math.max(0, Math.min(brushWidth / 2, width - left - 110)) }}>{formatWindowDuration(Math.abs(preview.end - preview.start))}</span></div>;
}
