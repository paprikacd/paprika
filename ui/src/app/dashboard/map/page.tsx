import type { Metadata } from "next"
import { Suspense } from "react"

import { FleetMapView } from "@/app/dashboard/map/fleet-map-view"

export const metadata: Metadata = {
  title: "Fleet map",
}

export default function FleetMapPage() {
  return (
    <Suspense fallback={<FleetMapFallback />}>
      <FleetMapView />
    </Suspense>
  )
}

/**
 * The view reads its axes from the URL, so it is client-rendered. The
 * fallback holds the header block at its final size to stop the page
 * jumping when the grid arrives.
 */
function FleetMapFallback() {
  return (
    <div className="px-5 pt-4 pb-8">
      <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
        Topology
      </p>
      <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
        Cluster &amp; fleet map
      </h1>
      <p role="status" aria-live="polite" className="mt-4 text-reason text-muted-foreground">
        Loading the fleet matrix.
      </p>
    </div>
  )
}
