"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";

// A two-axis drag over a heatmap's cells. It mirrors useTimeWindowBrush's gesture rules: a drag under six pixels is an ordinary
// click, so a click still pins; Escape cancels an active drag; a touch that moves mostly vertically scrolls. Unlike the time
// brush it never commits a dashboard range by itself. The caller decides what a region does.

export interface CellIndex { column: number; row: number }
export interface RegionBrushOptions {
  enabled: boolean;
  /** The displayed result. A drag that began on another revision is stale and never commits. */
  revision: unknown;
  /** Maps a pointer position onto a cell, or returns null outside the cells. */
  locate: (clientX: number, clientY: number) => CellIndex | null;
  /** Called on release with the two corners of the drag, in either order. */
  commit: (from: CellIndex, to: CellIndex) => void;
}

export interface RegionBrushPreview { from: CellIndex; to: CellIndex }

const DRAG_THRESHOLD = 6;

export function useRegionBrush(options: RegionBrushOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  type Drag = { id: number; owner: Element; start: CellIndex; clientX: number; clientY: number; active: boolean; revision: unknown };
  const drag = useRef<Drag | null>(null);
  const stale = (current: Drag) => !Object.is(current.revision, latest.current.revision);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<RegionBrushPreview | null>(null);
  const finish = (clear = true) => {
    const current = drag.current;
    drag.current = null;
    if (current?.active) suppressClick.current = true;
    if (current?.owner.hasPointerCapture(current.id)) current.owner.releasePointerCapture(current.id);
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
        const start = latest.current.locate(event.clientX, event.clientY);
        if (!start) return;
        suppressClick.current = false;
        const owner = (event.target as Element).closest("svg") ?? event.currentTarget;
        drag.current = { id: event.pointerId, owner, start, clientX: event.clientX, clientY: event.clientY, active: false, revision: latest.current.revision };
        owner.setPointerCapture(event.pointerId);
      },
      onPointerMoveCapture: (event: PointerEvent<Element>) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        if (!latest.current.enabled || (event.buttons & 1) === 0 || stale(current)) {
          finish();
          return;
        }
        const cell = latest.current.locate(event.clientX, event.clientY);
        if (!cell) return;
        if (!current.active) {
          const dx = Math.abs(event.clientX - current.clientX), dy = Math.abs(event.clientY - current.clientY);
          if (event.pointerType === "touch" && dy > dx && dy > DRAG_THRESHOLD) {
            finish();
            return;
          }
          if (Math.max(dx, dy) < DRAG_THRESHOLD) return;
          current.active = true;
        }
        event.preventDefault();
        event.stopPropagation();
        setPreview({ from: current.start, to: cell });
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
          const cell = latest.current.locate(event.clientX, event.clientY);
          if (cell) latest.current.commit(current.start, cell);
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
