import type { Metadata } from "next"
import { Suspense } from "react"

import { TemplatesView } from "@/app/dashboard/templates/templates-view"

export const metadata: Metadata = {
  title: "Templates",
}

export default function TemplatesPage() {
  return (
    <Suspense fallback={<TemplatesFallback />}>
      <TemplatesView />
    </Suspense>
  )
}

function TemplatesFallback() {
  return (
    <div className="px-5 pt-4 pb-8">
      <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
        Sources
      </p>
      <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
        Templates
      </h1>
      <p role="status" aria-live="polite" className="mt-4 text-reason text-muted-foreground">
        Loading ApplicationSets.
      </p>
    </div>
  )
}
