"use client"

import type { ReactNode } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { Rollout } from "@/gen/paprika/v1/api_pb"

/**
 * The rollout's mechanical state: how many pods each side has, which objects
 * the controller is steering, and the timers it is counting down. The ladder,
 * the analysis table and the log above it answer "what is happening"; this
 * board answers "what is it actually pointed at", which is the first thing
 * anyone asks when a rollout is not moving.
 *
 * Every value here is a field on `Rollout`. A field the object left empty is
 * left empty on screen — the `Field` below renders nothing rather than a zero,
 * because `0s` and "no delay configured" are different facts.
 */
export function RolloutDebugPanel({ rollout }: { rollout: Rollout }) {
  const desiredReplicas =
    rollout.replicas ||
    Math.max(rollout.stableReadyReplicas, rollout.canaryReadyReplicas)
  const router = rollout.trafficRouter
  const gateway = router?.gatewayApi
  const istio = router?.istio
  const hasRouting = Boolean(
    router?.provider ||
      gateway?.httpRoute ||
      istio?.virtualService ||
      gateway?.stableService ||
      istio?.stableService,
  )

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Blueprint>
        <BoardHeader
          title="Workload"
          meta={rollout.currentPodHash || undefined}
          actions={
            <span className="flex flex-wrap justify-end gap-1.5">
              {rollout.paused ? (
                <StatusPill tone="pending" label="Paused" />
              ) : null}
              {rollout.abort ? (
                <StatusPill tone="failed" label="Aborted" />
              ) : null}
              {rollout.mirrorPercent > 0 ? (
                <StatusPill
                  tone="progressing"
                  label={`Mirror ${rollout.mirrorPercent}%`}
                />
              ) : null}
            </span>
          }
        />
        <dl className="px-3.5 py-1">
          <Field label="Stable replicas ready">
            <Ratio
              ready={rollout.stableReadyReplicas}
              total={desiredReplicas}
              name="stable"
            />
          </Field>
          <Field label="Canary replicas ready">
            <Ratio
              ready={rollout.canaryReadyReplicas}
              total={desiredReplicas}
              name="canary"
            />
          </Field>
          <Field label="Stable ReplicaSet">{rollout.stableRs}</Field>
          <Field label="Canary ReplicaSet">{rollout.canaryRs}</Field>
          <Field label="Previous active ReplicaSet">
            {rollout.previousActiveRs}
          </Field>
          <Field label="Auto promote after">
            {rollout.autoPromotionSeconds
              ? `${rollout.autoPromotionSeconds}s`
              : ""}
          </Field>
          <Field label="Scale-down delay">
            {rollout.scaleDownDelaySeconds
              ? `${rollout.scaleDownDelaySeconds}s`
              : ""}
          </Field>
          <Field label="Observed generation">
            {rollout.observedGeneration
              ? rollout.observedGeneration.toString()
              : ""}
          </Field>
        </dl>
      </Blueprint>

      <Blueprint>
        <BoardHeader title="Traffic routing" meta={router?.provider || undefined} />
        {hasRouting ? (
          <dl className="px-3.5 py-1">
            <Field label="HTTPRoute">{gateway?.httpRoute}</Field>
            <Field label="VirtualService">{istio?.virtualService}</Field>
            <Field label="Stable service">
              {gateway?.stableService || istio?.stableService}
            </Field>
            <Field label="Canary service">
              {gateway?.canaryService || istio?.canaryService}
            </Field>
            <Field label="Active service">{rollout.activeService}</Field>
            <Field label="Preview service">{rollout.previewService}</Field>
          </dl>
        ) : (
          <p className="px-3.5 py-4 text-reason text-muted-foreground">
            This rollout declares no traffic router, so weight is applied by
            replica count alone.
          </p>
        )}

        {rollout.abRoutes.length > 0 ? (
          <div className="border-t border-rule">
            <h3 className="px-3.5 pt-2.5 font-cond text-label font-semibold tracking-[0.06em] uppercase">
              A/B routes
            </h3>
            <ul className="px-3.5 pt-1 pb-2">
              {rollout.abRoutes.map((route, index) => (
                <li
                  key={`${route.name}-${index}`}
                  className="flex items-baseline justify-between gap-3 border-b border-rule-faint py-1.5 last:border-b-0"
                >
                  <span className="truncate font-mono text-note">
                    {route.type ? `${route.type} ` : ""}
                    {route.name}
                  </span>
                  <span className="font-mono text-meta whitespace-nowrap text-muted-foreground">
                    {route.value}
                    {route.service ? ` → ${route.service}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Blueprint>
    </div>
  )
}

/**
 * `ready / total` as one accessible phrase. Read as two numbers in separate
 * elements it announces as "4 4", which is not what it says.
 *
 * Returns nothing when the total is zero. These are bare proto3 int32s with no
 * field presence, so a rollout that never reported replica counts is
 * indistinguishable from one reporting zero — and "0 / 0" reads as a
 * measurement. `0 / 4` is real information and still renders; the enclosing
 * `Field` drops the row entirely when this yields nothing.
 */
function Ratio({
  ready,
  total,
  name,
}: {
  ready: number
  total: number
  name: string
}) {
  if (total === 0) return null

  return (
    <span className="font-mono text-note tabular-nums">
      <span aria-hidden="true">{`${ready} / ${total}`}</span>
      <span className="sr-only">{`${ready} of ${total} ${name} replicas ready`}</span>
    </span>
  )
}

/**
 * A row that removes itself when the object did not carry the field. An empty
 * row would say "the control plane reports nothing here", which is a claim the
 * console cannot make about a field it simply was not sent.
 */
function Field({ label, children }: { label: string; children?: ReactNode }) {
  if (children === undefined || children === null || children === "") {
    return null
  }
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-rule-faint py-1.5 last:border-b-0">
      <dt className="text-note whitespace-nowrap text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-mono text-note">{children}</dd>
    </div>
  )
}
