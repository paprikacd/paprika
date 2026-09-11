"use client"

import { useMemo } from "react"
import { ReactFlow, type Edge, type NodeTypes } from "@xyflow/react"
import { graphlib, layout } from "@dagrejs/dagre"
import "@xyflow/react/dist/style.css"

import type { Step, StepStatus } from "@/gen/paprika/v1/api_pb"
import {
  PipelineDAGNode,
  PIPELINE_NODE_HEIGHT,
  PIPELINE_NODE_WIDTH,
  type PipelineStepNode,
} from "./pipeline-dag-node"
import { formatDuration, phaseLabel, phaseTone, stepElapsedMs } from "@/app/dashboard/pipelines/pipeline-model"

/**
 * A pipeline has tens of steps, not thousands — but nothing in the API says
 * so, and one DOM node per step is only safe while that holds. The cap keeps
 * a pathological pipeline from taking the page down with it; the caller is
 * told how many were dropped.
 */
export const MAX_DAG_NODES = 200

interface PipelineDAGProps {
  steps: Step[]
  stepStatuses: StepStatus[]
  selectedStep: string | null
  onStepSelect: (stepName: string) => void
  /** Clock for the elapsed time on a running step. */
  nowMs?: number
  className?: string
}

export function PipelineDAG({
  steps,
  stepStatuses,
  selectedStep,
  onStepSelect,
  nowMs,
  className,
}: PipelineDAGProps) {
  const statusMap = useMemo(() => {
    const map = new Map<string, StepStatus>()
    for (const status of stepStatuses) {
      if (status.name) map.set(status.name, status)
    }
    return map
  }, [stepStatuses])

  const visibleSteps = useMemo(() => steps.slice(0, MAX_DAG_NODES), [steps])
  const truncated = steps.length - visibleSteps.length
  const clock = nowMs ?? 0

  const { nodes, edges } = useMemo(() => {
    const visibleNames = new Set(visibleSteps.map((step) => step.name))

    const nodeList: PipelineStepNode[] = visibleSteps.map((step) => {
      const status = statusMap.get(step.name)
      const elapsed = clock > 0 ? stepElapsedMs(status, clock) : null
      const meta = [
        shortImage(step.image),
        elapsed === null ? "" : formatDuration(elapsed),
      ]
        .filter(Boolean)
        .join(" · ")

      return {
        id: step.name,
        type: "pipelineStep",
        position: { x: 0, y: 0 },
        data: {
          label: step.name,
          tone: phaseTone(status?.phase),
          phaseLabel: phaseLabel(status?.phase),
          meta,
          selected: selectedStep === step.name,
          onSelect: onStepSelect,
        },
        width: PIPELINE_NODE_WIDTH,
        height: PIPELINE_NODE_HEIGHT,
      }
    })

    const edgeList: Edge[] = []
    for (const step of visibleSteps) {
      for (const dep of step.depends) {
        if (!visibleNames.has(dep)) continue
        edgeList.push({
          id: `${dep}->${step.name}`,
          source: dep,
          target: step.name,
          type: "bezier",
          animated: statusMap.get(dep)?.phase === "Running",
          style: { stroke: "var(--color-rule-strong)", strokeWidth: 1 },
        })
      }
    }

    const g = new graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: "TB", align: "UL", nodesep: 30, ranksep: 48 })
    for (const n of nodeList) {
      g.setNode(n.id, {
        width: PIPELINE_NODE_WIDTH,
        height: PIPELINE_NODE_HEIGHT,
      })
    }
    for (const e of edgeList) {
      g.setEdge(e.source, e.target)
    }
    layout(g)

    for (const n of nodeList) {
      const node = g.node(n.id)
      n.position = {
        x: node.x - PIPELINE_NODE_WIDTH / 2,
        y: node.y - PIPELINE_NODE_HEIGHT / 2,
      }
    }

    return { nodes: nodeList, edges: edgeList }
  }, [visibleSteps, statusMap, selectedStep, onStepSelect, clock])

  const nodeTypes: NodeTypes = useMemo(
    () => ({ pipelineStep: PipelineDAGNode }),
    []
  )

  return (
    <div className={className}>
      <div
        data-testid="pipeline-dag"
        role="group"
        aria-label="Step graph"
        className="h-[460px] w-full"
        // The 22px engineering grid. Written as a style rather than an
        // arbitrary Tailwind value so it reads the hairline token instead of
        // repeating its hex.
        style={{
          backgroundImage:
            "linear-gradient(var(--color-rule-faint) 1px, transparent 1px), linear-gradient(90deg, var(--color-rule-faint) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: false }}
          panOnDrag={false}
          zoomOnScroll={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        />
      </div>
      {truncated > 0 ? (
        <p
          role="status"
          className="border-t border-rule px-3.5 py-1.5 font-mono text-meta text-neutral-700"
        >
          {truncated} further steps not drawn
        </p>
      ) : null}
    </div>
  )
}

/** `ghcr.io/acme/test-runner:3.2` reads as `test-runner:3.2` in a 170px box. */
function shortImage(image: string): string {
  if (!image) return ""
  const lastSlash = image.lastIndexOf("/")
  return lastSlash === -1 ? image : image.slice(lastSlash + 1)
}
