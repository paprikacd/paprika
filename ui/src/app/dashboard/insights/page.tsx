"use client"

import dynamic from "next/dynamic"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { createInsightsClient } from "@/features/insights/client"

const InsightsApp = dynamic(() => import("@/features/insights/insights-app"), {
  ssr: false,
  loading: () => <p className="p-10 text-sm text-muted-foreground">Opening Insights…</p>,
})
const client = createInsightsClient("/api/insights", () => localStorage.getItem("paprika_id_token"))

export default function InsightsPage() {
  const router = useRouter()
  const [example, setExample] = useState<boolean | null>(null)
  useEffect(() => {
    queueMicrotask(() =>
      setExample(new URLSearchParams(window.location.search).get("example") === "1"),
    )
  }, [])
  if (example === null) return null
  return (
    <InsightsApp
      client={client}
      initialExample={example}
      onBack={() => router.push("/dashboard/")}
    />
  )
}
