"use client"

import { useMemo } from "react"
import { ReactFlow, type Edge, type NodeTypes } from "@xyflow/react"
import { graphlib, layout } from "@dagrejs/dagre"
import "@xyflow/react/dist/style.css"

import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import { PipelineDAGNode, type PipelineStepNode } from "./pipeline-dag-node"

const NODE_WIDTH = 160
const NODE_HEIGHT = 44

interface PipelineDAGProps {
  steps: Step[]
  stepStatuses: StepStatus[]
  selectedStep: string | null
  onStepSelect: (stepName: string) => void
}

export function PipelineDAG({ steps, stepStatuses, selectedStep, onStepSelect }: PipelineDAGProps) {
  const statusMap = useMemo(() => {
    const map = new Map<string, StepStatus>()
    for (const status of stepStatuses) {
      if (status.name) {
        map.set(status.name, status)
      }
    }
    return map
  }, [stepStatuses])

  const { nodes, edges } = useMemo(() => {
    const nodeList: PipelineStepNode[] = steps.map((step) => ({
      id: step.name,
      type: "pipelineStep",
      position: { x: 0, y: 0 },
      data: {
        label: step.name,
        phase: statusMap.get(step.name)?.phase ?? "",
        selected: selectedStep === step.name,
        onSelect: onStepSelect,
      },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }))

    const edgeList: Edge[] = []
    for (const step of steps) {
      for (const dep of step.depends) {
        edgeList.push({
          id: `${dep}->${step.name}`,
          source: dep,
          target: step.name,
          type: "smoothstep",
          animated: statusMap.get(dep)?.phase === "Running",
        })
      }
    }

    const g = new graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", align: "UL", nodesep: 30, ranksep: 60 })
    for (const n of nodeList) {
      g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
    for (const e of edgeList) {
      g.setEdge(e.source, e.target)
    }
    layout(g)

    for (const n of nodeList) {
      const node = g.node(n.id)
      n.position = { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 }
    }

    return { nodes: nodeList, edges: edgeList }
  }, [steps, statusMap, selectedStep, onStepSelect])

  const nodeTypes: NodeTypes = useMemo(() => ({ pipelineStep: PipelineDAGNode }), [])

  return (
    <div className="h-[600px] w-full" data-testid="pipeline-dag">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        panOnDrag={false}
        zoomOnScroll={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      />
    </div>
  )
}
