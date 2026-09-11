"use client"

import { Code, ConnectError } from "@connectrpc/connect"
import { useCallback, useId, useState } from "react"

import type { Rollout } from "@/gen/paprika/v1/api_pb"
import { cn } from "@/lib/utils"

import { ConsoleButton } from "./rollout-chrome"
import { nextStepWeight } from "./rollout-model"
import type { RolloutConsoleClient } from "./rollout-queries"

export interface ActionReport {
  text: string
  kind: "ok" | "unsupported" | "error"
}

export interface RolloutActionRunner {
  pending: string | null
  report: ActionReport | null
  unsupported: Readonly<Record<string, boolean>>
  run: (key: string, label: string, call: () => Promise<unknown>) => Promise<void>
}

/** Phases in which nothing is left to promote or abort. */
const SETTLED = new Set(["Healthy", "RolledBack", "Aborted"])

/**
 * Runs one control-plane mutation at a time and remembers what came back.
 *
 * `Unimplemented` is handled as its own outcome rather than folded into
 * "failed", because the two mean different things to an operator: one is a
 * request the control plane refused, the other is a capability it does not
 * have. Neither is ever reported as success, and neither leaves the control
 * looking as though it worked.
 */
export function useRolloutAction(
  onCompleted?: () => void | Promise<unknown>,
): RolloutActionRunner {
  const [pending, setPending] = useState<string | null>(null)
  const [report, setReport] = useState<ActionReport | null>(null)
  const [unsupported, setUnsupported] = useState<Record<string, boolean>>({})

  const run = useCallback(
    async (key: string, label: string, call: () => Promise<unknown>) => {
      setPending(key)
      setReport(null)
      try {
        await call()
        setReport({
          text: `${label} accepted by the control plane.`,
          kind: "ok",
        })
        await onCompleted?.()
      } catch (error) {
        const failure = ConnectError.from(error)
        if (failure.code === Code.Unimplemented) {
          setUnsupported((previous) => ({ ...previous, [key]: true }))
          setReport({
            text: `${label} is not available on this control plane yet. No change was made.`,
            kind: "unsupported",
          })
          return
        }
        setReport({
          text: `${label} failed. ${failure.rawMessage || "The control plane rejected the request."}`,
          kind: "error",
        })
      } finally {
        setPending(null)
      }
    },
    [onCompleted],
  )

  return { pending, report, unsupported, run }
}

/** The live region every action reports into. */
export function ActionStatus({
  id,
  report,
  className,
}: {
  id: string
  report: ActionReport | null
  className?: string
}) {
  return (
    <p
      id={id}
      role="status"
      aria-live="polite"
      className={cn(
        "text-reason",
        report?.kind === "error" && "text-status-failed-text",
        report?.kind === "unsupported" && "text-status-degraded-text",
        report?.kind === "ok" && "text-status-healthy-text",
        !report && "sr-only",
        className,
      )}
    >
      {report?.text ?? ""}
    </p>
  )
}

/**
 * Promote and Abort are implemented. Hold and Resume are not — the control
 * plane answers `Unimplemented`. The controls still exist, because hiding them
 * would misrepresent the product's shape, but activating one says plainly that
 * nothing happened, and the button then carries that fact permanently.
 */
export function RolloutActions({
  client,
  rollout,
  onCompleted,
}: {
  client: RolloutConsoleClient
  rollout: Rollout
  onCompleted?: () => void | Promise<unknown>
}) {
  const statusId = useId()
  const { pending, report, unsupported, run } = useRolloutAction(onCompleted)

  const target = { namespace: rollout.namespace, name: rollout.name }
  const settled = SETTLED.has(rollout.phase)
  const nextWeight = nextStepWeight(rollout)
  const promoteLabel =
    nextWeight === undefined ? "Promote" : `Promote to ${nextWeight}%`
  const holdKey = rollout.paused ? "resume" : "hold"
  const holdLabel = rollout.paused ? "Resume" : "Hold"

  return (
    <>
      <ConsoleButton
        tone="destructive"
        disabled={pending !== null || settled}
        aria-describedby={report ? statusId : undefined}
        onClick={() =>
          run("abort", "Abort & roll back", () => client.abortRollout(target))
        }
      >
        Abort &amp; roll back
      </ConsoleButton>
      <ConsoleButton
        disabled={pending !== null}
        aria-describedby={unsupported[holdKey] || report ? statusId : undefined}
        onClick={() =>
          run(holdKey, holdLabel, () =>
            rollout.paused
              ? client.resumeRollout(target)
              : client.holdRollout(target),
          )
        }
      >
        {holdLabel}
        {unsupported[holdKey] ? (
          <span className="font-mono text-meta tracking-[0.06em] text-neutral-600">
            UNAVAILABLE
          </span>
        ) : null}
      </ConsoleButton>
      <ConsoleButton
        tone="primary"
        disabled={pending !== null || settled}
        aria-describedby={report ? statusId : undefined}
        onClick={() =>
          run("promote", promoteLabel, () => client.promoteRollout(target))
        }
      >
        {promoteLabel}
      </ConsoleButton>
      <ActionStatus id={statusId} report={report} className="w-full" />
    </>
  )
}

export { SETTLED as SETTLED_PHASES }
