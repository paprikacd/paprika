"use client"

import { useMemo } from "react"
import { ReactFlow, type Edge, type Node, type NodeTypes, Handle, Position, Background, Controls } from "@xyflow/react"
import { graphlib, layout } from "@dagrejs/dagre"
import "@xyflow/react/dist/style.css"

const NODE_WIDTH = 180
const NODE_HEIGHT = 56

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
}

interface ResourceGraphProps {
  nodes: ResourceGraphNode[]
  onSelectNode: (node: ResourceGraphNode) => void
}

const syncColors: Record<string, string> = {
  Synced: "border-emerald-500/40 bg-emerald-500/5",
  OutOfSync: "border-amber-500/40 bg-amber-500/5",
  Missing: "border-destructive/40 bg-destructive/5",
  Pruned: "border-muted-foreground/30 bg-muted/5",
}

const healthDot: Record<string, string> = {
  Healthy: "bg-emerald-500",
  Degraded: "bg-destructive",
  Progressing: "bg-amber-500",
  Unknown: "bg-muted-foreground",
  Missing: "bg-destructive",
}

const kindIcons: Record<string, string> = {
  Deployment: "\u{1F4E6}",
  StatefulSet: "\u{1F4E6}",
  DaemonSet: "\u{1F4E6}",
  ReplicaSet: "\u{1F504}",
  Pod: "\u{25C9}",
  Service: "\u{1F310}",
  ConfigMap: "\u{1F4DD}",
  Secret: "\u{1F510}",
  Ingress: "\u{1F517}",
  Job: "\u{26A1}",
  CronJob: "\u{23F0}",
  Namespace: "\u{1F3E2}",
}

function ResourceFlowNode({ data, isConnectable }: { data: Record<string, unknown>; isConnectable: boolean }) {
  const kind = data.kind as string
  const name = data.name as string
  const sync = data.syncStatus as string
  const health = data.health as string
  const managed = data.managed as boolean

  const syncClass = syncColors[sync] ?? syncColors.Pruned
  const dotClass = healthDot[health] ?? healthDot.Unknown
  const icon = kindIcons[kind] ?? "\u25A1"
  const selectNode = () => (data.onSelect as (n: unknown) => void)?.(data.node)

  return (
    <div style={{ width: NODE_WIDTH }}>
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        isConnectableStart={isConnectable}
        isConnectableEnd={isConnectable}
        className="!bg-muted-foreground/30 !w-1.5 !h-1.5 !border-0"
        style={isConnectable ? undefined : { pointerEvents: "auto" }}
        onClick={isConnectable ? undefined : selectNode}
      />
      <button
        type="button"
        aria-label={`Open ${kind} ${name} resource details`}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs ring-1 ring-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${syncClass}`}
        onClick={selectNode}
      >
        <span className="shrink-0 text-sm" aria-hidden="true">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] font-medium">{name}</span>
          <span className="flex items-center gap-1.5 mt-0.5">
            <span className={`size-1.5 rounded-full ${dotClass}`} />
            <span className="text-[9px] text-muted-foreground">{kind}</span>
            {managed && <span className="text-[9px] text-primary">managed</span>}
          </span>
        </span>
      </button>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        isConnectableStart={isConnectable}
        isConnectableEnd={isConnectable}
        className="!bg-muted-foreground/30 !w-1.5 !h-1.5 !border-0"
        style={isConnectable ? undefined : { pointerEvents: "auto" }}
        onClick={isConnectable ? undefined : selectNode}
      />
    </div>
  )
}

export function ResourceGraph({ nodes, onSelectNode }: ResourceGraphProps) {
  const { rfNodes, rfEdges } = useMemo(() => {
    if (nodes.length === 0) return { rfNodes: [] as Node[], rfEdges: [] as Edge[] }

    const nodeIds = new Set(nodes.map((n) => nodeId(n)))
    const nodeList: Node[] = nodes.map((n) => ({
      id: nodeId(n),
      type: "resourceNode",
      position: { x: 0, y: 0 },
      data: {
        kind: n.kind,
        name: n.name,
        syncStatus: n.syncStatus,
        health: n.health,
        managed: n.managed,
        node: n,
        onSelect: onSelectNode,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }))

    const edgeList: Edge[] = []
    for (const n of nodes) {
      if (n.parentKind && n.parentName) {
        const parentId = nodeId({ kind: n.parentKind, name: n.parentName } as ResourceGraphNode)
        if (nodeIds.has(parentId)) {
          edgeList.push({
            id: `${parentId}->${nodeId(n)}`,
            source: parentId,
            target: nodeId(n),
            type: "smoothstep",
          })
        }
      }
    }

    // dagre layout
    const g = new graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 50 })
    for (const n of nodeList) {
      g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
    for (const e of edgeList) {
      g.setEdge(e.source, e.target)
    }
    layout(g)

    for (const n of nodeList) {
      const pos = g.node(n.id)
      n.position = { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 }
    }

    return { rfNodes: nodeList, rfEdges: edgeList }
  }, [nodes, onSelectNode])

  const nodeTypes: NodeTypes = useMemo(() => ({ resourceNode: ResourceFlowNode }), [])

  if (nodes.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl ring-1 ring-foreground/10">
        <p className="text-sm text-muted-foreground">No resources to display.</p>
      </div>
    )
  }

  return (
    <div className="h-[500px] w-full rounded-xl ring-1 ring-foreground/10" data-testid="resource-graph">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--muted)" gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

function nodeId(n: { kind: string; name: string }): string {
  return `${n.kind}/${n.name}`
}
