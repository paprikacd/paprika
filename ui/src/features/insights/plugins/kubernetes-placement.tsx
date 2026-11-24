"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { hierarchy, treemap, type HierarchyRectangularNode } from "d3-hierarchy";
import { EmptyState } from "../chart-renderers";
import { formatMetricDetails } from "../chart-data";
import { seriesSlot } from "../series-palette";
import { statusToken } from "../status";
import { truncationNote } from "../truncation";
import type { WidgetRendererProps } from "../widget-registry";
import { placementConfigSchema, placementModel, type PlacementNode, type PlacementPod } from "./kubernetes-data";
import type { TriggerEvent } from "../observation-owner";
import { RESOURCE_UNIT, sampleTime, text, useObservations, useRoving, type Observation, type Observed } from "./kubernetes-observations";

/**
 * Node → pod placement treemap. A node's box is its allocatable capacity; its pods are tiles sized by their requests,
 * and the unrequested rest is an open tile. Pending and outside pods are grouped on their own. Zone groups appear only
 * when nodes carry a zone label. The layout is d3-hierarchy's treemap, as in the record treemap.
 */

const HEIGHT = 300;

/** A tree node: a group, a node, a pod request or the unrequested rest of a node. */
interface Tile {
  name: string;
  zone?: string;
  node?: string;
  pod?: PlacementPod;
  free?: boolean;
  value?: number;
  children?: Tile[];
}

const leafKey = (tile: Tile) => `${tile.node ?? "pending"}|${tile.pod?.key ?? tile.name}`;

/** Drilldown labels for a pod. The namespace is left out when the result does not carry it. */
const podLabels = (pod: PlacementPod, node: string | undefined): Record<string, string> => ({
  ...(node ? { node } : {}),
  ...(pod.namespace ? { namespace: pod.namespace } : {}),
  pod: pod.pod,
});

export function KubernetesPlacement({ widget, result, embedded, onActivate, onContextChange }: WidgetRendererProps) {
  const config = placementConfigSchema.parse(widget.config ?? {});
  const { model } = placementModel(result, config);
  const interactive = !embedded;
  const decimals = widget.options?.decimals;
  const resource = model.resource;
  const unit = RESOURCE_UNIT[resource];
  const requestOf = (pod: PlacementPod) => (resource === "cpu" ? pod.cpuRequest : pod.memoryRequest);
  const allocatableOf = (node: PlacementNode) => (resource === "cpu" ? node.cpuAllocatable : node.memoryAllocatable);
  const at = sampleTime(result.series);
  const podTile = (pod: PlacementPod, node: string | undefined, value: number): Tile => ({ name: pod.pod, node, pod, value });

  const nodeTiles = model.nodes.flatMap((node): Tile[] => {
    const allocatable = allocatableOf(node);
    const pods = node.pods.flatMap((pod) => {
      const request = requestOf(pod);
      return request !== null && request > 0 ? [podTile(pod, node.node, request)] : [];
    });
    const requested = pods.reduce((sum, tile) => sum + (tile.value ?? 0), 0);
    const free = allocatable !== null && allocatable > requested ? allocatable - requested : 0;
    const children = [...pods, ...(free > 0 ? [{ name: "Unrequested", node: node.node, free: true, value: free }] : [])];
    if (!children.length) return [];
    return [{ name: node.node, node: node.node, zone: node.zone ?? undefined, children }];
  });
  const pendingTiles = model.pending.flatMap((pod) => {
    const request = requestOf(pod);
    return request !== null && request > 0 ? [podTile(pod, undefined, request)] : [];
  });
  const outsideTiles = model.outside.flatMap((pod) => {
    const request = requestOf(pod);
    return request !== null && request > 0 ? [podTile(pod, undefined, request)] : [];
  });
  const groups: Tile[] = [];
  if (nodeTiles.some(node => node.zone)) {
    const zones = new Map<string, Tile[]>();
    for (const node of nodeTiles) {
      const zone = node.zone ?? "No zone";
      zones.set(zone, [...(zones.get(zone) ?? []), node]);
    }
    for (const [zone, children] of zones) groups.push({ name: zone, zone, children });
  } else {
    groups.push(...nodeTiles);
  }
  if (pendingTiles.length) groups.push({ name: "Pending", children: pendingTiles });
  if (outsideTiles.length) groups.push({ name: "Outside returned nodes", children: outsideTiles });

  const root = hierarchy<Tile>({ name: "root", children: groups }).sum(tile => tile.free || tile.pod ? tile.value ?? 0 : 0);
  const leaves = root.leaves().filter(leaf => leaf.data.pod || leaf.data.free);
  const observations: Observation[] = leaves.filter(leaf => leaf.data.pod).map((leaf) => {
    const tile = leaf.data, pod = tile.pod!, request = tile.value ?? 0;
    const node = model.nodes.find(candidate => candidate.node === tile.node);
    const allocatable = node ? allocatableOf(node) : null;
    const labels = podLabels(pod, tile.node);
    const readiness = node?.ready === false ? " The node is not ready." : "";
    return {
      key: leafKey(tile), subject: pod.pod, unit, description: `${resource === "cpu" ? "CPU" : "Memory"} request on ${tile.node ?? "no node"}`,
      series: { name: pod.pod, labels, points: [{ timestamp: at, value: request }] }, point: { timestamp: at, value: request },
      detail: allocatable
        ? <span>{text((request / allocatable) * 100, "%", decimals)} of {text(allocatable, unit, decimals)} allocatable on this node.{readiness}</span>
        : <span>{tile.node ? "Node capacity unavailable." : "Not scheduled to a node."}{readiness}</span>,
      context: { series: pod.pod, labels },
    };
  });
  const { root: rootRef, observe, popover } = useObservations(observations, widget, interactive && widget.options?.showTooltip !== false);
  const roving = useRoving(rootRef, observations.length);
  const svgRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const measure = () => {
      const measured = Math.round(element.getBoundingClientRect().width);
      if (measured > 0) setWidth(previous => (previous === measured ? previous : measured));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [result]);

  if (!model.nodes.length && !model.pending.length && !model.outside.length) return <EmptyState />;
  const total = root.value ?? 0;
  if (!total) return <div className="text-xs text-[var(--gamma-muted)]">No requests or allocatable capacity to size the placement treemap.</div>;
  const layout = treemap<Tile>().size([width, HEIGHT]).paddingOuter(3).paddingInner(2)
    .paddingTop(node => (node.children && (node.data.node !== undefined || node.data.zone !== undefined) ? 16 : 0))(root);
  const nodeFrames = layout.descendants().filter((node): node is HierarchyRectangularNode<Tile> & { children: NonNullable<Tile["children"]> } => node.depth >= 1 && !!node.children && node.data.node !== undefined);
  // Zone, pending and outside groups carry no node; each is labelled with its name.
  const groupFrames = layout.descendants().filter(node => node.depth >= 1 && !!node.children && node.data.node === undefined);
  const pressureOf = (name: string | undefined) => model.nodes.find(node => node.node === name)?.pressure ?? null;
  const toneOf = (pressure: number | null) => pressure === null ? "var(--gamma-chart-grid)" : pressure > 1 ? statusToken("critical") : pressure >= model.pressureThreshold ? statusToken("warning") : "var(--gamma-chart-grid)";
  const showPods = config.showPods !== false;
  const notReadyNodes = model.nodes.filter(node => node.ready === false).length;
  const podIndex = new Map(leaves.filter(leaf => leaf.data.pod).map((leaf, index) => [leafKey(leaf.data), index]));
  const maxChars = (size: number) => Math.max(0, Math.floor((size - 10) / 7));
  const clip = (value: string, size: number) => {
    const max = maxChars(size);
    return value.length > max && max > 1 ? `${value.slice(0, max - 1)}…` : value;
  };

  const tile = (leaf: HierarchyRectangularNode<Tile>) => {
    const data = leaf.data, x = leaf.x0, y = leaf.y0, w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
    if (data.free) {
      return <g key={`free-${data.node}`} role="img" aria-label={`${data.node}: ${text(data.value ?? null, unit, decimals)} unrequested`}>
        <rect x={x} y={y} width={w} height={h} fill="none" stroke="var(--gamma-chart-grid)" strokeDasharray="3 3" />
        {w >= 60 && h >= 18 && <text x={x + 5} y={y + 13} fontSize="11" fill="var(--gamma-muted)" pointerEvents="none">Unrequested</text>}
      </g>;
    }
    const index = podIndex.get(leafKey(data)) ?? 0;
    const observed: Observed | undefined = observe(leafKey(data));
    const label = `${data.pod!.pod}: ${text(data.value ?? null, unit, decimals)}${data.node ? ` on ${data.node}` : " (pending)"}`;
    const shape = <>
      <rect x={x} y={y} width={w} height={h} rx={2} style={{ fill: seriesSlot(index) }} stroke="var(--gamma-chart-empty)" strokeWidth={1} />
      {showPods && w >= 48 && h >= 18 && <text x={x + 5} y={y + 13} fontSize="11" fill="var(--gamma-ink)" pointerEvents="none">{clip(data.pod!.pod, w)}</text>}
    </>;
    if (!interactive) return <g key={leafKey(data)} role="img" aria-label={label}>{shape}</g>;
    const trigger = observed?.trigger;
    const context = { series: data.pod!.pod, labels: podLabels(data.pod!, data.node) };
    const activate = (event: TriggerEvent) => { (onActivate ?? onContextChange)?.(context); trigger?.onClick(event); };
    const keys = roving(index, activate);
    return <g key={leafKey(data)} role="button" aria-label={label} data-observation={observed?.index}
      tabIndex={keys.tabIndex} data-roving={keys["data-roving"]} onKeyDown={keys.onKeyDown}
      onPointerEnter={trigger?.onPointerEnter} onPointerLeave={trigger?.onPointerLeave}
      onFocus={event => { keys.onFocus(); onContextChange?.(context); trigger?.onFocus(event); }}
      onBlur={trigger?.onBlur}
      onClick={activate}>
      {shape}
    </g>;
  };

  const frameStyle: CSSProperties = { fill: "none" };
  return (
    <div ref={svgRef} className="flex h-full min-h-0 flex-col gap-2 text-xs" data-kubernetes="placement">
      <div ref={rootRef} className="relative w-full">
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="group" aria-label={`${widget.title} placement`} className="block max-w-full">
          {groupFrames.map(group => (group.x1 - group.x0 >= 60 ? <text key={`group-${group.data.name}`} x={group.x0 + 4} y={group.y0 + 12} fontSize="11" fontWeight={600} fill="var(--gamma-ink)" pointerEvents="none">{clip(group.data.zone ?? group.data.name, group.x1 - group.x0)}</text> : null))}
          {nodeFrames.map(node => {
            const pressure = pressureOf(node.data.node);
            const notReady = model.nodes.find(candidate => candidate.node === node.data.node)?.ready === false;
            const w = node.x1 - node.x0;
            return <g key={`node-${node.data.node}`}>
              <rect x={node.x0} y={node.y0} width={node.x1 - node.x0} height={node.y1 - node.y0} style={frameStyle} stroke={toneOf(pressure)} strokeWidth={pressure !== null && pressure >= model.pressureThreshold ? 1.5 : 1} strokeDasharray={notReady ? "4 2" : undefined} rx={2} pointerEvents="none" />
              {w >= 60 && <text x={node.x0 + 4} y={node.y0 + 12} fontSize="11" fill="var(--gamma-ink)" pointerEvents="none">
                {clip(`${node.data.node}${pressure === null ? "" : ` · ${formatMetricDetails(pressure * 100, "%", decimals)}`}${notReady ? " · not ready" : ""}`, w)}
              </text>}
            </g>;
          })}
          {layout.leaves().map(leaf => tile(leaf))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--gamma-muted)]">
        {model.hiddenNodes > 0 && <span>Showing {model.nodes.length} of {model.totalNodes} nodes</span>}
        <span>{model.pending.length} pending {model.pending.length === 1 ? "pod" : "pods"}</span>
        {notReadyNodes > 0 && <span>{notReadyNodes} {notReadyNodes === 1 ? "node" : "nodes"} not ready</span>}
        {model.outside.length > 0 && <span>{model.outside.length} outside returned nodes</span>}
        {truncationNote(result) && <span>{truncationNote(result)}</span>}
      </div>
      {popover}
    </div>
  );
}
