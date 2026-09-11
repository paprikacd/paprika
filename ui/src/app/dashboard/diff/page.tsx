import { Suspense } from "react"

import { SyncDiffWorkbench } from "@/components/dashboard/sync-diff-workbench"

export const metadata = {
  title: "Sync & diff",
}

export default function DiffPage() {
  return (
    <Suspense fallback={<DiffFallback />}>
      <SyncDiffWorkbench />
    </Suspense>
  )
}

/**
 * The workbench reads the selected application and the fleet scope from the
 * URL, so it renders on the client. The fallback holds the header band's
 * shape to stop the page jumping when it hydrates.
 */
function DiffFallback() {
  return (
    <div aria-busy="true" className="flex min-w-0 flex-col">
      <div className="border-b border-rule bg-card px-5 py-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Drift control
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Sync &amp; diff workbench
        </h1>
      </div>
      <p role="status" className="px-5 py-6 text-note text-neutral-700">
        Loading the drift queue…
      </p>
    </div>
  )
}
