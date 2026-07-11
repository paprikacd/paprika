import { Suspense } from "react"

import { FleetView } from "@/components/fleet/fleet-view"

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<ApplicationsFallback />}>
      <FleetView />
    </Suspense>
  )
}

function ApplicationsFallback() {
  return (
    <section aria-labelledby="applications-loading-title" aria-busy="true" className="bg-background">
      <header className="border-b border-border px-4 py-7 sm:px-6">
        <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-primary">
          Fleet inventory
        </p>
        <h1
          id="applications-loading-title"
          className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          Applications
        </h1>
      </header>
      <p role="status" aria-live="polite" className="mx-4 my-8 border border-border bg-card px-5 py-8 text-sm text-muted-foreground sm:mx-6">
        Loading fleet query controls…
      </p>
    </section>
  )
}
