"use client"

import { graphlib, layout } from "@dagrejs/dagre"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react"
import { memo, useMemo } from "react"
import "@xyflow/react/dist/style.css"

import {
  resourceHealthTone,
  resourceSyncTone,
  resourceSyncLabel,
  resourceKey,
} from "@/components/dashboard/resource-list-table"
import { StatusGlyph } from "@/components/ui/status-chip"
import {
  CANVAS_COLORS,
  STATUS_TONES,
  STATUS_TONE_HEX,
  type StatusTone,
} from "@/lib/status-tone"
import { cn } from "@/lib/utils"
import { ResourceKindIcon } from "@/components/dashboard/resource-kind-icon"

const NODE_WIDTH = 216
const NODE_HEIGHT = 48

/**
 * The graph draws one box per resource, so it is only safe while the resource
 * count is an application's, not a fleet's. Past this the tree — which is
 * virtualisable and bounded — is the honest view, and the graph says so.
 */
export const MAX_GRAPH_NODES = 300

const LEGEND_TONES: readonly StatusTone[] = [
  "healthy",
  "progressing",
  "degraded",
  "failed",
]

export interface ResourceGraphNode {
  kind: string
  name: string
  namespace: string
  syncStatus: string
  health: string
  healthMessage: string
  parentKind: string
  parentName: string
  uid: string
  managed: boolean
  /** From GetResourceTreeDetailed. Absent means the server did not report it. */
  ready?: number
  total?: number
}

interface ResourceGraphProps {
  nodes: ResourceGraphNode[]
  onSelectNode: (node: ResourceGraphNode) => void
  selectedId?: string | null
}

interface ResourceNodeData extends Record<string, unknown> {
  kind: string
  name: string
  tone: StatusTone
  syncTone: StatusTone
  syncLabel: string
  badge: string
  selected: boolean
  node: ResourceGraphNode
  onSelect: (node: ResourceGraphNode) => void
}

/** Only a reading the server actually sent becomes a badge. */
function nodeBadge(n: ResourceGraphNode): string {
  if (typeof n.total === "number" && n.total > 0) return `${n.ready ?? 0}/${n.total}`
  if (resourceSyncTone(n.syncStatus) === "degraded") return "drift"
  return ""
}

const ResourceFlowNode = memo(function ResourceFlowNode({ data }: { data: ResourceNodeData }) {
  const spec = STATUS_TONES[data.tone]
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${data.kind} ${data.name}, ${spec.label}, ${data.syncLabel}`}
      aria-pressed={data.selected}
      onClick={() => data.onSelect(data.node)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        data.onSelect(data.node)
      }}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "flex items-center gap-2 border bg-card px-2 py-1.5",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        data.selected
          ? "border-status-failed-text outline-2 outline-status-failed-line"
          : "border-rule-strong"
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!size-1 !border-0 !bg-rule-strong"
      />
      <span className="relative shrink-0">
        <ResourceKindIcon kind={data.node.kind} />
        <StatusGlyph tone={data.tone} label={`${spec.label} health`} className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-card" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-meta tracking-[0.08em] text-neutral-600">
          {data.kind}
        </span>
        <span className="block truncate font-cond text-console font-semibold tracking-[0.02em]">
          {data.name}
        </span>
      </span>
      {data.badge ? (
        <span
          className={cn(
            "flex-none rounded-[2px] border px-[5px] py-px font-mono text-kicker",
            spec.line,
            spec.fill,
            spec.text
          )}
        >
          {data.badge}
        </span>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!size-1 !border-0 !bg-rule-strong"
      />
    </div>
  )
})

const nodeTypes: NodeTypes = { resourceNode: ResourceFlowNode }

export function ResourceGraph({
  nodes,
  onSelectNode,
  selectedId,
}: ResourceGraphProps) {
  const overBudget = nodes.length > MAX_GRAPH_NODES

  // Selection and inspector callbacks must not repeat the Dagre layout.
  const { positions, rfEdges } = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>()
    if (nodes.length === 0 || overBudget) return { positions, rfEdges: [] as Edge[] }
    const ids = new Set(nodes.map(resourceKey))
    const edges: Edge[] = []
    const graph = new graphlib.Graph()
    graph.setDefaultEdgeLabel(() => ({}))
    graph.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 60, marginx: 16, marginy: 16 })
    for (const node of nodes) graph.setNode(resourceKey(node), { width: NODE_WIDTH, height: NODE_HEIGHT })
    for (const node of nodes) {
      if (!node.parentKind || !node.parentName) continue
      const parent = `${node.parentKind}/${node.parentName}`
      if (!ids.has(parent)) continue
      const child = resourceKey(node)
      const failed = resourceHealthTone(node.health) === "failed"
      edges.push({
        id: `${parent}->${child}`, source: parent, target: child, type: "smoothstep",
        style: failed
          ? { stroke: STATUS_TONE_HEX.failed.text, strokeWidth: 1.4, strokeDasharray: "3 2" }
          : { stroke: CANVAS_COLORS.rule, strokeWidth: 1 },
      })
      graph.setEdge(parent, child)
    }
    layout(graph)
    for (const node of nodes) {
      const id = resourceKey(node)
      const position = graph.node(id)
      positions.set(id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 })
    }
    return { positions, rfEdges: edges }
  }, [nodes, overBudget])

  const rfNodes = useMemo<Node[]>(() => overBudget ? [] : nodes.map((node) => {
    const id = resourceKey(node)
    return {
      id, type: "resourceNode", position: positions.get(id) ?? { x: 0, y: 0 },
      data: {
        kind: node.kind.toUpperCase(), name: node.name,
        tone: resourceHealthTone(node.health), syncTone: resourceSyncTone(node.syncStatus),
        syncLabel: resourceSyncLabel(node.syncStatus), badge: nodeBadge(node),
        selected: selectedId === id, node, onSelect: onSelectNode,
      } satisfies ResourceNodeData,
      width: NODE_WIDTH, height: NODE_HEIGHT, draggable: false,
    }
  }), [nodes, positions, overBudget, selectedId, onSelectNode])

  if (overBudget) {
    return (
      <p
        role="status"
        className="px-3.5 py-8 text-center text-chip text-muted-foreground"
      >
        {nodes.length} resources is past the {MAX_GRAPH_NODES} the graph can draw
        without flooding the page. Switch to Tree.
      </p>
    )
  }

  if (nodes.length === 0) {
    return (
      <p className="px-3.5 py-8 text-center text-chip text-muted-foreground">
        No managed resources reported for this application.
      </p>
    )
  }

  return (
    <div className="relative h-[372px] w-full" data-testid="resource-graph">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        zoomOnScroll={false}
        panOnScroll
        aria-label="Resource graph"
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={22}
          lineWidth={1}
          color={CANVAS_COLORS.rule}
        />
        <Controls showInteractive={false} position="top-right" />
      </ReactFlow>
      <ul className="absolute bottom-3 left-3 z-10 flex list-none gap-2.5 border border-rule bg-background/90 px-2.5 py-1">
        {LEGEND_TONES.map((tone) => (
          <li key={tone} className="inline-flex items-center gap-1 text-meta text-muted-foreground">
            <StatusGlyph tone={tone} label="" aria-hidden />
            {STATUS_TONES[tone].label}
          </li>
        ))}
      </ul>
    </div>
  )
}
