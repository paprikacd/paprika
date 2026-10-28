"use client"

import dynamic from "next/dynamic"
import { useEffect, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { createInsightsClient } from "@/features/insights/client"
import { redirectInsightsToLogin } from "./auth"
import { clearRejectedSession, ensureValidSession, getServerSessionSnapshot, getSessionSnapshot, recoverUnauthorized, subscribeSession } from "@/lib/browser-session"

const InsightsApp = dynamic(() => import("@/features/insights/insights-app"), {
  ssr: false,
  loading: () => <p className="p-10 text-sm text-muted-foreground">Opening Insights…</p>,
})
const client = createInsightsClient(
  "/api/insights",
  () => getSessionSnapshot().idToken,
  redirectInsightsToLogin,
  {
    ensureToken: ensureValidSession,
    recoverUnauthorized,
    clearRejectedSession,
    identity: () => JSON.stringify([getSessionSnapshot().identityKey, getSessionSnapshot().identityEpoch]),
  },
)

export default function InsightsPage() {
  const router = useRouter()
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot)
  const [example, setExample] = useState<boolean | null>(null)
  useEffect(() => {
    queueMicrotask(() =>
      setExample(new URLSearchParams(window.location.search).get("example") === "1"),
    )
  }, [])
  if (example === null) return null
  return (
    <InsightsApp
      key={JSON.stringify([session.identityKey, session.identityEpoch])}
      client={client}
      initialExample={example}
      onBack={() => router.push("/dashboard/")}
    />
  )
}
