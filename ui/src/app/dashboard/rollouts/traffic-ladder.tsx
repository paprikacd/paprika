"use client"

import { useId } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusGlyph } from "@/components/ui/status-chip"
import type { Rollout } from "@/gen/paprika/v1/api_pb"
import { STATUS_TONES } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { EmptyNote } from "./rollout-chrome"
import {
  buildTrafficLadder,
  buildTrafficSplit,
  trafficRouterLabel,
  type LadderStep,
} from "./rollout-model"

/**
 * The traffic ladder is `Rollout.canarySteps` drawn against `currentStep` and
 * `currentWeight` — one bar per declared step, no more and no fewer. A rollout
 * with no canary steps has no ladder, so the board reports that instead of
 * drawing an empty rail.
 */
export function TrafficLadder({ rollout }: { rollout: Rollout }) {
  const splitLabelId = useId()
  const steps = buildTrafficLadder(rollout)
  const split = buildTrafficSplit(rollout)
  const router = trafficRouterLabel(rollout)

  return (
    <Blueprint>
      <BoardHeader title="Traffic ladder" meta={router || undefined} />
      {steps.length === 0 ? (
        <EmptyNote>
          This rollout declares no canary steps, so it has no traffic ladder.
        </EmptyNote>
      ) : (
        <div className="overflow-x-auto px-3.5 pt-[18px] pb-3.5">
          <ol aria-label="Canary steps" className="flex min-w-0 gap-2">
            {steps.map((step) => (
              <LadderColumn key={step.n} step={step} />
            ))}
          </ol>
        </div>
      )}
      {split ? (
        <div className="border-t border-rule px-3.5 py-3">
          <div className="flex items-center gap-3">
            <span
              id={splitLabelId}
              className="w-14 flex-none font-mono text-meta tracking-[0.12em] text-neutral-600"
            >
              TRAFFIC
            </span>
            <div
              role="group"
              aria-labelledby={splitLabelId}
              className="flex h-6.5 min-w-0 flex-1 border border-rule-strong"
            >
              <div
                style={{ width: `${split.stablePercent}%` }}
                className="flex min-w-0 items-center overflow-hidden bg-neutral-200 pl-[9px]"
              >
                <span className="font-cond text-console font-semibold tracking-[0.05em] whitespace-nowrap">
                  {`STABLE ${split.stablePercent}%`}
                  {split.stableRs ? ` · ${split.stableRs}` : ""}
                  {` · ${pods(split.stableReadyReplicas)}`}
                </span>
              </div>
              <div
                style={{ width: `${split.canaryPercent}%` }}
                className="flex min-w-0 items-center overflow-hidden bg-primary pl-[9px]"
              >
                <span className="font-cond text-console font-semibold tracking-[0.05em] whitespace-nowrap text-primary-foreground">
                  {`CANARY ${split.canaryPercent}%`}
                </span>
              </div>
            </div>
          </div>
          <p className="mt-1.5 pl-[68px] font-mono text-meta text-neutral-600">
            {["canary", split.canaryRs, pods(split.canaryReadyReplicas)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      ) : null}
    </Blueprint>
  )
}

function LadderColumn({ step }: { step: LadderStep }) {
  const tone = STATUS_TONES[step.tone]
  const queued = step.state === "queued"
  return (
    <li className="min-w-18 flex-1 basis-0">
      <div className="flex h-26 items-end" aria-hidden="true">
        <div
          style={{ height: `${step.barPercent}%` }}
          className={cn(
            "w-full border",
            tone.line,
            queued ? "border-dashed bg-transparent" : tone.fill,
          )}
        />
      </div>
      <div className="mt-[9px] flex items-center justify-between gap-1.5">
        <span
          className={cn(
            "font-cond text-weight font-semibold tabular-nums",
            tone.text,
          )}
        >
          {step.weight}%
        </span>
        <StatusGlyph
          tone={step.tone}
          label={`Step ${step.n}: ${tone.label}`}
        />
      </div>
      <div className="mt-[3px] font-mono text-meta tracking-[0.1em] text-status-pending-text">
        STEP {step.n}
      </div>
      <div className="mt-0.5 text-note text-muted-foreground">{step.note}</div>
    </li>
  )
}

function pods(count: number): string {
  return `${count} ${count === 1 ? "pod" : "pods"}`
}
