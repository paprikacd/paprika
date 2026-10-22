"use client"

import { useEffect } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"

/**
 * The console's failure surface.
 *
 * A component that throws must not take the page with it: the operator keeps
 * the shell, the navigation and the other boards, and this board says plainly
 * what failed and offers the one action that can help — rendering again.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="px-[22px] pt-[18px] pb-8">
      <Blueprint>
        <BoardHeader title="This view failed to render" />
        <div className="px-3.5 py-4">
          <p
            role="alert"
            className="text-reason text-status-failed-text"
          >
            {error.message || "The view raised an error."}
          </p>
          <p className="mt-1.5 text-note text-muted-foreground">
            Nothing else on this page is affected. Rendering again usually
            clears it.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-3 inline-flex h-[26px] cursor-pointer items-center border border-rule bg-card px-2.5 font-cond text-label font-medium text-foreground hover:bg-inset focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring pointer-coarse:h-11"
          >
            Render again
          </button>
        </div>
      </Blueprint>
    </div>
  )
}
