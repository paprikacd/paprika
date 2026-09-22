import { Suspense } from "react"

import { FleetView } from "@/components/fleet/fleet-view"

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<ApplicationsFallback />}>
      <FleetView />
    </Suspense>
  )
}

/**
 * The view reads its whole state from the URL, so it cannot prerender. The
 * fallback holds the header's shape to stop the page jumping when the client
 * takes over.
 */
function ApplicationsFallback() {
  return (
    <section
      aria-labelledby="applications-loading-title"
      aria-busy="true"
      className="bg-background"
    >
      <header className="px-5.5 pt-4.5 pb-3.5">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600">
          FLEET INVENTORY
        </p>
        <h1
          id="applications-loading-title"
          className="mt-1 font-cond text-title font-semibold tracking-[0.01em]"
        >
          Applications
        </h1>
      </header>
      <p
        role="status"
        aria-live="polite"
        className="border-y border-rule bg-card px-5.5 py-8 text-console text-muted-foreground"
      >
        Loading fleet query controls…
      </p>
    </section>
  )
}
