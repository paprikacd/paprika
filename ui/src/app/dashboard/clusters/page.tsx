import type { Metadata } from "next"
import { Suspense } from "react"

import { ClustersView } from "@/app/dashboard/clusters/clusters-view"

export const metadata: Metadata = {
  title: "Clusters",
}

export default function ClustersPage() {
  return (
    <Suspense fallback={<ClustersFallback />}>
      <ClustersView />
    </Suspense>
  )
}

function ClustersFallback() {
  return (
    <div className="px-5 pt-4 pb-8">
      <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
        Sources
      </p>
      <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
        Clusters
      </h1>
      <p role="status" aria-live="polite" className="mt-4 text-reason text-muted-foreground">
        Loading clusters.
      </p>
    </div>
  )
}
