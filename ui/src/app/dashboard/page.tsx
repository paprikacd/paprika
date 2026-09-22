"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useMemo } from "react"

import { ToastStack } from "@/components/notifications/toast-stack"
import { OverviewView } from "@/components/overview/overview-view"
import { parseFleetQuery } from "@/lib/fleet-query"

export default function DashboardPage() {
  return (
    <>
      <Suspense
        fallback={
          <p
            role="status"
            className="px-5 py-8 text-note text-muted-foreground"
          >
            Loading the operations overview…
          </p>
        }
      >
        <OverviewRoute />
      </Suspense>
      <ToastStack />
    </>
  )
}

/**
 * Scope lives in the URL so it can be shared, which means reading it needs a
 * `Suspense` boundary under static export.
 */
function OverviewRoute() {
  const searchParams = useSearchParams()
  const raw = searchParams.toString()
  const state = useMemo(() => parseFleetQuery(raw).state, [raw])
  return <OverviewView state={state} />
}
