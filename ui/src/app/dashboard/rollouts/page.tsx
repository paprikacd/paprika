import { Suspense } from "react"

import { RolloutBoardSkeleton } from "./rollout-skeleton"
import { RolloutsView } from "./rollouts-view"

export const metadata = {
  title: "Rollouts",
}

/**
 * The view reads scope from the query string, so it sits behind a Suspense
 * boundary: with `output: "export"` the shell is prerendered and only this
 * subtree waits for the URL.
 */
export default function RolloutsPage() {
  return (
    <Suspense
      fallback={
        <div className="px-[22px] pt-[18px] pb-8">
          <RolloutBoardSkeleton label="Loading rollouts" />
        </div>
      }
    >
      <RolloutsView />
    </Suspense>
  )
}
