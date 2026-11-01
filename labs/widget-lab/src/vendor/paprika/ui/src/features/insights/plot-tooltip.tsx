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
import { type Point, type Series } from "./chart-data";
import { RichObservationInspector } from "./observation-inspector";
import type { InspectionWindow } from "./observation-inspector-data";
import type { Widget } from "./schema";
import styles from "./chart-styles.module.css";
import { useChartCursorPublisher } from "./chart-cursor";
import { restoreTooltipFocus } from "./tooltip-focus";
import { useTooltipHandoff } from "./tooltip-interaction";

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
  pin: (point: PlotPoint, pinned: boolean) => void;
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
  inspectionRevision?: unknown,
  inspectionWindow?: InspectionWindow,
) {
  const id = useId();
  const cursor = useChartCursorPublisher();
  const revision = useMemo(
    () => ({ series, view: widget.options?.tooltipView, unit: widget.unit, inspectionRevision, start: inspectionWindow?.start, end: inspectionWindow?.end }),
    [series, widget.options?.tooltipView, widget.unit, inspectionRevision, inspectionWindow?.start, inspectionWindow?.end],
  );
  const scene = useRef<PlotScene | null>(null);
  const armedRevision = useRef<unknown>(null);
  const restoringFocus = useRef(false);
  const [active, setActive] = useState<ActivePoint | null>(null);
  const activeAnchor = useRef<SVGSVGElement | null>(null);
  activeAnchor.current = active?.anchor ?? null;
  const interaction = useRef({ panel: false, focused: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handoff = useTooltipHandoff();
  const clearHide = useCallback(() => { clearTimeout(timer.current); timer.current = undefined; handoff.release(); }, [handoff]);
  const dismiss = useCallback(() => {
    clearHide();
    const restoreFocus = document.getElementById(id)?.contains(document.activeElement);
    interaction.current.panel = false;
    armedRevision.current = null;
    restoringFocus.current = true;
    setActive(null);
    scene.current?.clear();
    if (restoreFocus) restoreTooltipFocus(scene.current?.svg);
    restoringFocus.current = false;
  }, [clearHide, id]);
  const scheduleHide = useCallback(() => {
    if (!activeAnchor.current) return;
    handoff.hold(activeAnchor.current);
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!interaction.current.panel && !interaction.current.focused)
        setActive((current) => (current?.pinned ? current : null));
      handoff.release();
    }, 180);
  }, [handoff]);
  useEffect(() => {
    // A pinned observation belongs to its exact result/configuration, never a refresh.
    armedRevision.current = null;
    interaction.current.panel = false;
    setActive(null);
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
        pin: (point, pinned) => {
          const target = context.scene.points.find(candidate => candidate.key === point.key);
          if (target) context.interaction.setControlledFocus(target, { pinned, source: "programmatic" });
        },
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
      setActive((current) => current?.pinned && current.revision === revision ? current : ({
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
  const selectedTimestamp = current?.point.datum.timestamp;
  const pinned = current?.pinned ?? false;
  useEffect(() => {
    if (widget.type !== "timeseries") return;
    if (selectedTimestamp !== undefined) cursor.publish(widget.id, selectedTimestamp, pinned);
    else cursor.clear(widget.id);
    return () => cursor.clear(widget.id);
  }, [cursor, widget.id, widget.type, selectedTimestamp, pinned]);
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
  const entry = current ? series[current.point.datum.seriesIndex] : undefined;
  const point = current
    ? {
        timestamp: current.point.datum.timestamp,
        value: current.point.datum.value,
      }
    : undefined;
  return {
    dismiss,
    extension,
    onRender,
    onFocusChange,
    onSelect,
    onInteract: () => {
      armedRevision.current = revision;
    },
    onFocus: () => {
      if (restoringFocus.current) return;
      armedRevision.current = revision;
      interaction.current.focused = true;
      clearHide();
    },
    onBlur: () => {
      interaction.current.focused = false;
      scheduleHide();
    },
    panel:
      current && entry && point ? (
        <ObservationTooltip
          id={id}
          anchor={current.anchor}
          pinned={current.pinned}
          options={widget.options}
          anchorRect={anchorRect}
          preferSide
          compact={widget.options?.inspectorDensity === "compact"}
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
            {widget.type === "timeseries" ? <RichObservationInspector
              title={widget.title}
              series={series}
              selectedSeriesIndex={current.point.datum.seriesIndex}
              timestamp={point.timestamp}
              unit={widget.unit}
              decimals={widget.options?.decimals}
              pinned={current.pinned}
              window={inspectionWindow}
              colors={series.map((_, index) => index === 0 && widget.color ? widget.color : `var(--gamma-chart-${index % 8 + 1})`)}
              onClose={dismiss}
              onPin={() => { scene.current?.pin(current.point, !current.pinned); setActive({ ...current, pinned: !current.pinned }); }}
            >{widget.options?.tooltipView && <TooltipSubWidget
              view={widget.options.tooltipView}
              series={entry}
              seriesIndex={current.point.datum.seriesIndex}
              point={point}
              unit={widget.unit}
              color={current.point.color || widget.color}
            />}</RichObservationInspector> : <MetricDetails
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
            />}
            {widget.type !== "timeseries" && widget.options?.tooltipView && <TooltipSubWidget
              view={widget.options.tooltipView}
              series={entry}
              seriesIndex={current.point.datum.seriesIndex}
              point={point}
              unit={widget.unit}
              color={current.point.color || widget.color}
            />}
            {widget.type !== "timeseries" && <div className={styles.tooltipFooter} data-pinned={current.pinned || undefined}>
              {widget.options?.inspectorDensity !== "compact" && <small>Page Up/Down to scroll · Esc to close</small>}
              <small>
                {current.pinned
                  ? "Pinned · Esc to close"
                  : "Click or Enter to pin · Esc to close"}
              </small>
            </div>}
          </div>
        </ObservationTooltip>
      ) : null,
  };
}
