import type { Metadata } from "next"
import { Suspense } from "react"

import { ObservabilityView } from "@/app/dashboard/observability/observability-view"

export const metadata: Metadata = {
  title: "Observability",
  description:
    "Observability providers known to this server and MCP tool usage reported by the observability gateway.",
}

export default function ObservabilityPage() {
  return (
    <Suspense fallback={<ObservabilityFallback />}>
      <ObservabilityView />
    </Suspense>
  )
}

function ObservabilityFallback() {
  return (
    <div className="px-5 pt-4 pb-8">
      <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
        Sources
      </p>
      <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
        Observability
      </h1>
      <p role="status" aria-live="polite" className="mt-4 text-reason text-muted-foreground">
        Loading observability.
      </p>
    </div>
  )
}
