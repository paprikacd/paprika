"use client"

import { memo } from "react"
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react"

import { StatusGlyph } from "@/components/ui/status-chip"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

export const PIPELINE_NODE_WIDTH = 170
export const PIPELINE_NODE_HEIGHT = 44

export interface PipelineDAGNodeData {
  label: string
  tone: StatusTone
  /** The control plane's own word — `Running`, `Skipped` — not a tone name. */
  phaseLabel: string
  /** `kaniko · 48s`. Empty when the pipeline has nothing to say. */
  meta: string
  selected: boolean
  onSelect: (stepName: string) => void
  [key: string]: unknown
}

export type PipelineStepNode = Node<PipelineDAGNodeData, "pipelineStep">

/**
 * A step in the graph. It is a real button: the graph is a navigation
 * surface, so every node has to be reachable and operable from the keyboard,
 * and its state has to survive without colour — the tone glyph carries it.
 *
 * The tone appears twice on purpose: as the 3px spine, which is scannable
 * down a column of nodes, and as the glyph, which is the accessible one.
 */
export const PipelineDAGNode = memo(function PipelineDAGNode({
  id,
  data,
}: NodeProps<PipelineStepNode>) {
  return (
    <button
      type="button"
      aria-pressed={data.selected}
      onClick={() => data.onSelect(id)}
      className={cn(
        "relative flex h-[44px] w-[170px] cursor-pointer items-center gap-2 border bg-card py-[7px] pr-[9px] pl-3 text-left",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        data.selected
          ? "border-primary outline-2 outline-primary/25"
          : "border-rule-strong hover:shadow-tile-hover"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[3px]",
          STATUS_TONES[data.tone].bar
        )}
      />
      <StatusGlyph tone={data.tone} label={data.phaseLabel} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-cond text-label leading-tight font-semibold tracking-[0.03em]">
          {data.label}
        </span>
        {data.meta ? (
          <span className="block truncate font-mono text-meta leading-tight text-neutral-600">
            {data.meta}
          </span>
        ) : null}
      </span>
      {/* Anchors for the dagre-routed edges. The design draws bare lines into
          the box, so the default dots are suppressed rather than restyled. */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="!size-px !min-h-0 !min-w-0 !border-0 !bg-transparent"
      />
    </button>
  )
})
