import { Suspense } from "react"

import { RolloutBoardSkeleton } from "../rollout-skeleton"
import { RolloutDetailView } from "./rollout-detail-view"

export const metadata = {
  title: "Rollout",
}

/**
 * `?namespace=` and `?name=` identify the record, so the view is a client
 * component behind a Suspense boundary — the static export has no request to
 * read them from.
 */
export default function RolloutDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-[22px] pt-[18px] pb-8">
          <RolloutBoardSkeleton label="Loading rollout" />
        </div>
      }
    >
      <RolloutDetailView />
    </Suspense>
  )
}
