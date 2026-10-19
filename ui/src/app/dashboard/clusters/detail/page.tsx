import { Suspense } from "react"

import { ClusterDetailView } from "./cluster-detail-view"

export const metadata = {
  title: "Cluster",
}

/**
 * `?namespace=` and `?name=` identify the record, so the view is a client
 * component behind a Suspense boundary — the static export has no request to
 * read them from.
 */
export default function ClusterDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-5 pt-4 pb-8">
          <p role="status" className="text-reason text-muted-foreground">
            Loading cluster
          </p>
        </div>
      }
    >
      <ClusterDetailView />
    </Suspense>
  )
}
