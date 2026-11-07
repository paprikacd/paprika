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
import { MetricDetails } from "./metric-tooltip-content";
import { ObservationTooltip } from "./observation-tooltip";
import { installTooltipPointerTracking } from "./tooltip-pointer";
import { TooltipSubWidget } from "./tooltip-widgets";
import { TooltipInstructions } from "./tooltip-instructions";
import { formatMetricDetails, seriesName, type Point, type Series } from "./chart-data";
import type { Widget } from "./schema";
import styles from "./chart-styles.module.css";
import { useChartCursorPublisher } from "./chart-cursor";
import { GammaButton } from "./gamma/button";
import type { DrilldownContext } from "./drilldown";
import { drilldownContextReason } from "./widget-context";
import { useWidgetDrilldown } from "./widget-drilldown";

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
  peers: PlotPoint[];
}

function coincidentPoints(points: readonly PlotPoint[], selected: PlotPoint, series: Series[]) {
  const peers = new Map<number, PlotPoint>();
  const ambiguous = new Set<number>();
  for (const candidate of points) {
    const datum = candidate.datum;
    if (datum.seriesIndex !== selected.datum.seriesIndex &&
        datum.timestamp === selected.datum.timestamp &&
        typeof datum.value === "number" && Number.isFinite(datum.value) &&
        series[datum.seriesIndex]) {
      if (peers.has(datum.seriesIndex)) {
        peers.delete(datum.seriesIndex);
        ambiguous.add(datum.seriesIndex);
      } else if (!ambiguous.has(datum.seriesIndex)) {
        peers.set(datum.seriesIndex, candidate);
      }
    }
  }
  return [...peers.values()];
}

/** TanStack owns hit testing/navigation; this adapter only presents its exact datum. */
export function usePlotTooltip(
  widget: Widget,
  series: Series[],
  enabled: boolean,
  onContextChange?: (context: DrilldownContext) => void,
) {
  const id = useId();
  useEffect(() => enabled ? installTooltipPointerTracking() : undefined, [enabled]);
  const cursor = useChartCursorPublisher();
  const openDrilldown = useWidgetDrilldown();
  const revision = useMemo(
    () => ({ series, view: widget.options?.tooltipView, unit: widget.unit, color: widget.color, seriesColors: widget.options?.seriesColors, options: widget.options, title: widget.title }),
    [series, widget.options, widget.title, widget.unit, widget.color],
  );
  const scene = useRef<PlotScene | null>(null);
  const armedRevision = useRef<unknown>(null);
  const [active, setActive] = useState<ActivePoint | null>(null);
  const [showAllPeers, setShowAllPeers] = useState(false);
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
      const peers = widget.type === "timeseries" ? coincidentPoints(scene.current?.points ?? [], point, series) : [];
      setActive((current) => ({
        point,
        anchor,
        pinned: current?.revision === revision && current.pinned,
        revision,
        peers,
      }));
    },
    [enabled, series, revision, clearHide, scheduleHide, widget.type],
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
      setActive({ point, anchor, pinned: true, revision, peers: widget.type === "timeseries" ? coincidentPoints(scene.current?.points ?? [], point, series) : [] });
    },
    [enabled, active, revision, series, dismiss, clearHide, widget.type],
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
  // Only compare plotted observations with exactly the same timestamp; do not
  // interpolate or substitute the latest value from a different series.
  const peersAtTime = current?.peers ?? [];
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
      current && entry && point ? (
        <ObservationTooltip
          id={id}
          anchor={current.anchor}
          anchorRect={anchorRect}
          preferSide
          avoidWidget
          pinned={current.pinned}
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
            <MetricDetails widget={widget} series={entry} index={current.point.datum.seriesIndex} point={point} unit={widget.unit} decimals={widget.options?.decimals} description="Selected observation" timestampFirst />
            {widget.type === "timeseries" && peersAtTime.length > 0 && <div className={styles.plotTooltipValues}>
              <span className={styles.plotTooltipCaption}>Other plotted series at this time</span>
              <ul>{(showAllPeers ? peersAtTime : peersAtTime.slice(0, 5)).map(candidate => {
                const peer = series[candidate.datum.seriesIndex];
                const name = seriesName(peer, candidate.datum.seriesIndex);
                return <li key={candidate.datum.seriesIndex} data-peer-series={name} data-peer-value={candidate.datum.value} data-peer-timestamp={candidate.datum.timestamp}>
                  <i aria-hidden="true" style={{ background: candidate.color }} />
                  <details className={styles.tooltipSource}><summary>Series {candidate.datum.seriesIndex + 1}</summary><span className={styles.tooltipSourceIdentity}>{name}</span></details>
                  <strong>{formatMetricDetails(candidate.datum.value!, widget.options?.tooltipShowUnit === false ? "" : widget.unit, widget.options?.tooltipDecimals ?? widget.options?.decimals)}</strong>
                </li>;
              })}</ul>
              {peersAtTime.length > 5 && <button type="button" className={styles.plotTooltipExpand} aria-expanded={showAllPeers} onClick={() => setShowAllPeers(value => !value)}>
                {showAllPeers ? "Show fewer plotted series" : `Show ${peersAtTime.length - 5} more plotted series`}
              </button>}
            </div>}
            {current.pinned && widget.type === "timeseries" && !!widget.drilldowns?.length && (openDrilldown || onContextChange) && <div className={styles.tooltipActions}>
              {openDrilldown && widget.drilldowns.map(link => {
                const selected = { series: seriesName(entry, current.point.datum.seriesIndex), labels: entry.labels, value: point.value, timestamp: point.timestamp };
                const reason = drilldownContextReason(link, selected);
                return <div key={link.id}>
                  <GammaButton size="sm" variant="secondary" disabled={!!reason} onClick={() => openDrilldown(link, selected)}>{link.title}</GammaButton>
                  {reason && <p className={styles.tooltipActionReason}>{reason}</p>}
                </div>;
              })}
              {onContextChange && <GammaButton size="sm" variant="secondary" onClick={() => onContextChange({ series: seriesName(entry, current.point.datum.seriesIndex), labels: entry.labels, value: point.value, timestamp: point.timestamp })}>
                Use sample for dashboard links
              </GammaButton>}
            </div>}
            {widget.options?.tooltipView && <TooltipSubWidget
              view={widget.options.tooltipView}
              series={entry}
              seriesIndex={current.point.datum.seriesIndex}
              point={point}
              unit={widget.unit}
              color={current.point.color || widget.color}
            />}
            <div className={styles.tooltipFooter}>
              <small><TooltipInstructions /></small>
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
