import { useRef, useState, type KeyboardEvent } from "react";

/**
 * Roving focus for a legend whose entries are buttons: one entry is in the tab order, and the arrow, Home and End keys
 * move focus among the others without activating them. A focused entry becomes the tab stop.
 */
export function useRovingLegend(count: number) {
  const [stop, setStop] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const tabStop = Math.min(stop, Math.max(0, count - 1));
  const last = count - 1;
  return {
    /** The entry in the tab order. */
    tabStop,
    /** The ref for entry `index`. */
    ref: (index: number) => (element: HTMLButtonElement | null) => {
      buttons.current[index] = element;
    },
    onFocus: (index: number) => () => setStop(index),
    onKeyDown: (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
      const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? index + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? index - 1
        : event.key === "Home" ? 0
        : event.key === "End" ? last
        : undefined;
      if (target === undefined) return;
      event.preventDefault();
      const next = Math.max(0, Math.min(last, target));
      setStop(next);
      buttons.current[next]?.focus();
    },
  };
}
