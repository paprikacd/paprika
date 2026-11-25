"use client"

import dynamic from "next/dynamic"
import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { applicationURL } from "@/lib/application-url"
import { consoleInsightsClient as client } from "@/lib/insights-console-client"
import { getServerSessionSnapshot, getSessionSnapshot, subscribeSession } from "@/lib/browser-session"
import { readEmbedRequest, type EmbedRequest } from "@/features/insights/embed-request"

const InsightsApp = dynamic(() => import("@/features/insights/insights-app"), {
  ssr: false,
  loading: () => <p className="p-10 text-sm text-muted-foreground">Opening Insights…</p>,
})

export default function InsightsPage() {
  const router = useRouter()
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot)
  const [start, setStart] = useState<{ example: boolean; embed: EmbedRequest | null } | null>(null)
  useEffect(() => {
    queueMicrotask(() => {
      const search = window.location.search
      setStart({ example: new URLSearchParams(search).get("example") === "1", embed: readEmbedRequest(search) })
    })
  }, [])
  if (start === null) return null
  return (
    <InsightsApp
      key={JSON.stringify([session.identityKey, session.identityEpoch])}
      client={client}
      initialExample={start.example}
      // An application page frames one widget: the workspace around it does not load.
      embed={start.embed}
      onOpenApplication={(ref) => router.push(applicationURL(ref))}
      // A renewed token is a new revision: a banner waiting on sign-in reloads its sources.
      sessionRevision={session.revision}
      // Stable across token renewals; variable values are cached per principal.
      principal={JSON.stringify([session.identityKey, session.identityEpoch])}
      onBack={() => router.push("/dashboard/")}
    />
  )
}
