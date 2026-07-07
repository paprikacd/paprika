"use client"

import type { ReactNode } from "react"
import { Activity, GitBranch, RadioTower, Route, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { Rollout } from "@/gen/paprika/v1/api_pb"

function Ratio({ ready, total }: { ready: number; total: number }) {
  return (
    <span className="font-mono text-sm tabular-nums">
      {ready} / {total}
    </span>
  )
}

function Field({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs text-foreground">{children || "—"}</span>
    </div>
  )
}

export function RolloutDebugPanel({ rollout }: { rollout: Rollout }) {
  const desiredReplicas = rollout.replicas || Math.max(rollout.stableReadyReplicas, rollout.canaryReadyReplicas)
  const router = rollout.trafficRouter
  const gateway = router?.gatewayApi
  const istio = router?.istio

  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Strategy Plan</h2>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {rollout.paused && <Badge variant="secondary">Paused</Badge>}
            {rollout.abort && <Badge variant="destructive">Aborted</Badge>}
            {rollout.mirrorPercent > 0 && <Badge variant="outline">{`${rollout.mirrorPercent}%`}</Badge>}
          </div>
        </div>

        {rollout.canarySteps.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rollout.canarySteps.map((step, index) => (
              <div
                key={`${step.setWeight}-${index}`}
                className="rounded-md border border-border/70 bg-background px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase text-muted-foreground">Step {index + 1}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums">{step.setWeight}%</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{step.duration || "manual gate"}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No explicit canary steps.</p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Activity className="size-3.5" aria-hidden="true" />
              Replica Readiness
            </div>
            <Field label="Stable"><Ratio ready={rollout.stableReadyReplicas} total={desiredReplicas} /></Field>
            <Field label="Canary"><Ratio ready={rollout.canaryReadyReplicas} total={desiredReplicas} /></Field>
          </div>
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              Debug State
            </div>
            <Field label="Current hash">{rollout.currentPodHash}</Field>
            <Field label="Previous active RS">{rollout.previousActiveRs}</Field>
            <Field label="Auto promote">{rollout.autoPromotionSeconds ? `${rollout.autoPromotionSeconds}s` : ""}</Field>
            <Field label="Scale-down delay">{rollout.scaleDownDelaySeconds ? `${rollout.scaleDownDelaySeconds}s` : ""}</Field>
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <RadioTower className="size-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Routing And Analysis</h2>
        </div>
        <div className="space-y-3">
          <div className="rounded-md border border-border/70 bg-background p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Route className="size-3.5" aria-hidden="true" />
              Traffic Router
            </div>
            <Field label="Provider">{router?.provider}</Field>
            <Field label="HTTPRoute">{gateway?.httpRoute}</Field>
            <Field label="VirtualService">{istio?.virtualService}</Field>
            <Field label="Stable service">{gateway?.stableService || istio?.stableService}</Field>
            <Field label="Canary service">{gateway?.canaryService || istio?.canaryService}</Field>
          </div>

          {rollout.analysisChecks.length > 0 && (
            <div className="rounded-md border border-border/70 bg-background p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Analysis Checks</div>
              <div className="space-y-2">
                {rollout.analysisChecks.map((check, index) => (
                  <div key={`${check.type}-${index}`} className="rounded border border-border/50 px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="secondary">{check.type}</Badge>
                      <span className="font-mono text-xs">{check.successThreshold || check.threshold || "—"}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {check.url || check.metric || "No target"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {rollout.abRoutes.length > 0 && (
            <div className="rounded-md border border-border/70 bg-background p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">A/B Routes</div>
              <div className="space-y-1.5">
                {rollout.abRoutes.map((route, index) => (
                  <div key={`${route.name}-${index}`} className="grid grid-cols-[1fr_auto] gap-3 text-xs">
                    <span className="truncate font-mono">{route.name}</span>
                    <span className="text-muted-foreground">{route.value} → {route.service}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
