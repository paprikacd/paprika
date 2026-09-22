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
import { useMemo } from "react"
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

const NODE_WIDTH = 176
const NODE_HEIGHT = 40

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

function ResourceFlowNode({ data }: { data: ResourceNodeData }) {
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
      <StatusGlyph tone={data.tone} label={`${spec.label} health`} />
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
}

const nodeTypes: NodeTypes = { resourceNode: ResourceFlowNode }

export function ResourceGraph({
  nodes,
  onSelectNode,
  selectedId,
}: ResourceGraphProps) {
  const overBudget = nodes.length > MAX_GRAPH_NODES

  const { rfNodes, rfEdges } = useMemo(() => {
    if (nodes.length === 0 || overBudget) {
      return { rfNodes: [] as Node[], rfEdges: [] as Edge[] }
    }

    const ids = new Set(nodes.map((n) => resourceKey(n)))
    const toneById = new Map(
      nodes.map((n) => [resourceKey(n), resourceHealthTone(n.health)] as const)
    )

    const nodeList: Node[] = nodes.map((n) => {
      const id = resourceKey(n)
      const tone = resourceHealthTone(n.health)
      return {
        id,
        type: "resourceNode",
        position: { x: 0, y: 0 },
        data: {
          kind: n.kind.toUpperCase(),
          name: n.name,
          tone,
          syncTone: resourceSyncTone(n.syncStatus),
          syncLabel: resourceSyncLabel(n.syncStatus),
          badge: nodeBadge(n),
          selected: selectedId === id,
          node: n,
          onSelect: onSelectNode,
        } satisfies ResourceNodeData,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        draggable: false,
      }
    })

    const edgeList: Edge[] = []
    for (const n of nodes) {
      if (!n.parentKind || !n.parentName) continue
      const parentId = `${n.parentKind}/${n.parentName}`
      if (!ids.has(parentId)) continue
      const childId = resourceKey(n)
      // An edge landing on a failed object is the one line a reader should
      // follow first, so it alone carries weight and a dash.
      const failed = toneById.get(childId) === "failed"
      edgeList.push({
        id: `${parentId}->${childId}`,
        source: parentId,
        target: childId,
        type: "smoothstep",
        style: failed
          ? {
              stroke: STATUS_TONE_HEX.failed.text,
              strokeWidth: 1.4,
              strokeDasharray: "3 2",
            }
          : { stroke: CANVAS_COLORS.rule, strokeWidth: 1 },
      })
    }

    const g = new graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 60, marginx: 16, marginy: 16 })
    for (const n of nodeList) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    for (const e of edgeList) g.setEdge(e.source, e.target)
    layout(g)
    for (const n of nodeList) {
      const pos = g.node(n.id)
      n.position = { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }
    }

    return { rfNodes: nodeList, rfEdges: edgeList }
  }, [nodes, onSelectNode, overBudget, selectedId])

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
