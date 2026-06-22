"use client"

import { memo } from "react"
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"

export interface PipelineDAGNodeData {
  label: string
  phase: string
  selected: boolean
  onSelect: (stepName: string) => void
  [key: string]: unknown
}

export type PipelineStepNode = Node<PipelineDAGNodeData, "pipelineStep">

function phaseColor(phase: string): string {
  switch (phase) {
    case "Running":
      return "#3b82f6"
    case "Succeeded":
      return "#22c55e"
    case "Failed":
      return "#ef4444"
    case "Skipped":
      return "#eab308"
    case "Cancelled":
      return "#6b7280"
    default:
      return "#94a3b8"
  }
}

export const PipelineDAGNode = memo(function PipelineDAGNode({ id, data }: NodeProps<PipelineStepNode>) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => data.onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          data.onSelect(id)
        }
      }}
      className={`
        flex min-w-[140px] cursor-pointer items-center justify-center rounded-md border bg-card px-4 py-2 text-sm font-medium shadow-sm transition-all
        ${data.selected ? "ring-2 ring-primary ring-offset-2" : ""}
      `}
      style={{ borderLeftWidth: 4, borderLeftColor: phaseColor(data.phase) }}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <span className="truncate">{data.label}</span>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
})
