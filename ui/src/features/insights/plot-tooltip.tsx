"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChartPoint,
  ChartRenderContext,
  ChartTooltipExtension,
  ChartValue,
} from "@tanstack/charts";
import { MetricDetails, ObservationTooltip } from "./chart-renderers";
import { TooltipSubWidget } from "./tooltip-widgets";
import type { Point, Series } from "./chart-data";
import type { Widget } from "./schema";
import styles from "./chart-styles.module.css";

export interface PlotDatum extends Point {
  seriesIndex: number;
}
type PlotPoint = ChartPoint<PlotDatum>;
interface PlotScene {
  svg: SVGSVGElement;
  width: number;
  height: number;
  points: readonly PlotPoint[];
  clear: () => void;
}
interface ActivePoint {
  point: PlotPoint;
  anchor: SVGSVGElement;
  pinned: boolean;
  revision: unknown;
}

/** TanStack owns hit testing/navigation; this adapter only presents its exact datum. */
export function usePlotTooltip(
  widget: Widget,
  series: Series[],
  enabled: boolean,
) {
  const id = useId();
  const revision = useMemo(
    () => ({ series, view: widget.options?.tooltipView, unit: widget.unit }),
    [series, widget.options?.tooltipView, widget.unit],
  );
  const scene = useRef<PlotScene | null>(null);
  const armedRevision = useRef<unknown>(null);
  const [active, setActive] = useState<ActivePoint | null>(null);
  const interaction = useRef({ panel: false, focused: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHide = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => {
    clearHide();
    interaction.current.panel = false;
    setActive(null);
    scene.current?.clear();
  }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    timer.current = setTimeout(() => {
      if (!interaction.current.panel && !interaction.current.focused)
        setActive((current) => (current?.pinned ? current : null));
    }, 180);
  }, [clearHide]);
  useEffect(() => {
    // A pinned observation belongs to its exact result/configuration, never a refresh.
    scene.current?.clear();
    return clearHide;
  }, [revision, enabled, clearHide]);
  const onRender = useCallback(
    <T extends PlotDatum, X extends ChartValue, Y extends ChartValue>(
      context: ChartRenderContext<T, X, Y>,
    ) => {
      scene.current = {
        svg: context.svg,
        width: context.scene.width,
        height: context.scene.height,
        points: context.scene.points,
        clear: () => context.interaction.setControlledFocus(null),
      };
    },
    [],
  );
  const onFocusChange = useCallback(
    (point: PlotPoint | null) => {
      if (!enabled || armedRevision.current !== revision) return;
      if (!point) {
        scheduleHide();
        return;
      }
      const anchor = scene.current?.svg;
      if (!anchor || !series[point.datum.seriesIndex]) return;
      clearHide();
      setActive((current) => ({
        point,
        anchor,
        pinned: current?.revision === revision && current.pinned,
        revision,
      }));
    },
    [enabled, series, revision, clearHide, scheduleHide],
  );
  const onSelect = useCallback(
    (point: PlotPoint | null) => {
      if (!enabled) return;
      if (!point || (active?.pinned && active.revision === revision)) {
        dismiss();
        return;
      }
      const anchor = scene.current?.svg;
      if (!anchor || !series[point.datum.seriesIndex]) return;
      clearHide();
      setActive({ point, anchor, pinned: true, revision });
    },
    [enabled, active, revision, series, dismiss, clearHide],
  );
  const current = enabled && active?.revision === revision ? active : null;
  const anchorRect = useCallback(() => {
    if (!current) return new DOMRect();
    const chart = scene.current;
    const point =
      chart?.points.find((candidate) => candidate.key === current.point.key) ??
      current.point;
    const box = current.anchor.getBoundingClientRect();
    const x =
      box.left + (point.x * box.width) / Math.max(1, chart?.width ?? box.width);
    const y =
      box.top +
      (point.y * box.height) / Math.max(1, chart?.height ?? box.height);
    return new DOMRect(x - 3, y - 3, 6, 6);
  }, [current]);
  // The public tooltip extension preserves native click/Enter pinning and teaches
  // the chart that our external portal is inside its interaction boundary.
  const extension = useMemo<ChartTooltipExtension>(
    () => ({
      id: "paprika-observation",
      __chartExtensionType: "tooltip",
      __chartTooltipHost: "dom",
      create: ({ container }) => ({
        update() {},
        paint() {},
        hide() {},
        destroy() {},
        contains: (target) =>
          target instanceof Node &&
          !!container.ownerDocument.getElementById(id)?.contains(target),
      }),
    }),
    [id],
  );
  useEffect(() => {
    if (!current) return;
    const anchor = current.anchor;
    const previous = anchor.getAttribute("aria-describedby");
    anchor.setAttribute(
      "aria-describedby",
      [previous, id].filter(Boolean).join(" "),
    );
    return () => {
      if (previous) anchor.setAttribute("aria-describedby", previous);
      else anchor.removeAttribute("aria-describedby");
    };
  }, [current, id]);
  const entry = current ? series[current.point.datum.seriesIndex] : undefined;
  const point = current
    ? {
        timestamp: current.point.datum.timestamp,
        value: current.point.datum.value,
      }
    : undefined;
  return {
    extension,
    onRender,
    onFocusChange,
    onSelect,
    onInteract: () => {
      armedRevision.current = revision;
    },
    onFocus: () => {
      armedRevision.current = revision;
      interaction.current.focused = true;
      clearHide();
    },
    onBlur: () => {
      interaction.current.focused = false;
      scheduleHide();
    },
    panel:
      current && entry && point && widget.options?.tooltipView ? (
        <ObservationTooltip
          id={id}
          anchor={current.anchor}
          anchorRect={anchorRect}
          preferSide
          onDismiss={dismiss}
          onEnter={() => {
            interaction.current.panel = true;
            clearHide();
          }}
          onLeave={() => {
            interaction.current.panel = false;
            scheduleHide();
          }}
        >
          <div
            data-observation-value={
              point.value === null ? "missing" : String(point.value)
            }
            data-observation-timestamp={String(point.timestamp)}
            data-observation-series={entry.name}
          >
            <MetricDetails
              series={entry}
              index={current.point.datum.seriesIndex}
              point={point}
              unit={widget.unit}
              decimals={widget.options?.decimals}
              description={
                widget.type === "bar"
                  ? "Latest valid sample"
                  : "Selected observation"
              }
            />
            <TooltipSubWidget
              view={widget.options.tooltipView}
              series={entry}
              seriesIndex={current.point.datum.seriesIndex}
              point={point}
              unit={widget.unit}
              color={current.point.color || widget.color}
            />
            <div className={styles.tooltipFooter}>
              <small>Page Up/Down to scroll · Esc to close</small>
              <small>
                {current.pinned
                  ? "Pinned · select again to close"
                  : "Click, tap or press Enter to keep open"}
              </small>
            </div>
          </div>
        </ObservationTooltip>
      ) : null,
  };
}
