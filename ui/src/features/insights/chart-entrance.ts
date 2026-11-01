import { createContext, useContext, useEffect, useLayoutEffect, useState, type RefObject } from "react";
// The reveal rules for TanStack's mark groups are global selectors, so this module must load them with the hook.
import "./chart-entrance.module.css";

/**
 * The one-time draw-in of a chart's marks, on its first render only. While it plays, the plot carries
 * `data-chart-entering`, and chart-entrance.module.css clips the mark groups in from the left.
 * `CHART_REVEAL_MS` must equal `--gamma-duration-reveal` in gamma/gamma-theme.module.css.
 */
export const CHART_REVEAL_MS = 600;
// The flag outlives the animation by a margin, so the last frame is painted before the attribute is removed.
const ENTERING_MS = CHART_REVEAL_MS + 100;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Where a widget's draw-in is recorded. A canvas provides one per widget, so the draw-in plays once for the widget's
 * life on that canvas, not once per mounted chart. A remounted tile (a breakpoint swap, a return to the view) therefore
 * starts settled, without a clip or `data-chart-entering`.
 */
export interface ChartEntranceSlot {
  /** True once a chart of this widget has drawn in, or the draw-in was skipped for it. */
  entered: () => boolean;
  /** Records that this widget's own chart has been drawn. Idempotent. */
  markEntered: () => void;
}
export const ChartEntranceContext = createContext<ChartEntranceSlot | null>(null);

/** The OS asks for reduced motion. A host without matchMedia has no such preference. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY)?.matches === true;
}

/**
 * True from mount for CHART_REVEAL_MS + 100 ms, then false for the rest of this chart's life. The timer is set
 * once, on mount, so data refreshes, resizes and re-renders never restart it. The result starts false when
 * `disabled` (embedded sub-widgets), when reduced motion is requested, when the widget's slot says it has already
 * entered, or when `anchor` sits inside a `data-motion="reduced"` scope. Pass the plot element as `anchor` so that
 * scope check can read the DOM.
 */
export function useChartEntrance({ disabled = false, anchor }: { disabled?: boolean; anchor?: RefObject<Element | null> } = {}): boolean {
  const slot = useContext(ChartEntranceContext);
  const [entering, setEntering] = useState(() => !disabled && !prefersReducedMotion() && !slot?.entered());
  useLayoutEffect(() => {
    // The scope lives in the DOM, which exists only after commit. Syncing with it here, before paint, avoids a frame of reveal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (anchor?.current?.closest('[data-motion="reduced"]')) setEntering(false);
  }, [anchor]);
  useEffect(() => {
    // An embedded sub-widget is never the widget's own chart, so it leaves the widget's record alone.
    if (!disabled) slot?.markEntered();
  }, [disabled, slot]);
  useEffect(() => {
    const timer = setTimeout(() => setEntering(false), ENTERING_MS);
    return () => clearTimeout(timer);
  }, []);
  return entering && !disabled;
}
