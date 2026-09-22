"use client"

import { Blueprint } from "@/components/ui/blueprint"

/**
 * A placeholder frame, not placeholder data. The bars carry no numbers and no
 * row count, so nothing here can be mistaken for a reading that arrived.
 */
export function RolloutBoardSkeleton({ label }: { label: string }) {
  return (
    <Blueprint>
      <div role="status" aria-live="polite" className="p-3.5">
        <span className="sr-only">{label}</span>
        <div className="h-4 w-40 animate-pulse bg-inset" aria-hidden="true" />
        <div
          className="mt-4 h-26 w-full animate-pulse bg-inset"
          aria-hidden="true"
        />
        <div
          className="mt-4 h-4 w-2/3 animate-pulse bg-inset"
          aria-hidden="true"
        />
      </div>
    </Blueprint>
  )
}
