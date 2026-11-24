"use client"

import dynamic from "next/dynamic"
import { consoleInsightsClient } from "@/lib/insights-console-client"

// The embedded widget brings Insights' CSS and charts, so it loads only when an application page shows it.
const EmbeddedWidget = dynamic(() => import("@/features/insights/embedded-widget"), {
  ssr: false,
  loading: () => <p className="text-note text-muted-foreground">Loading metrics…</p>,
})

/** The summary widget of a dashboard that covers the application, read-only, with a link to the whole dashboard. */
export function ApplicationInsightsWidget({
  dashboardId,
  widgetId,
  variables,
  href,
}: {
  dashboardId: string
  widgetId: string
  variables: Record<string, string>
  href: string
}) {
  return (
    <EmbeddedWidget
      client={consoleInsightsClient}
      dashboardId={dashboardId}
      widgetId={widgetId}
      variables={variables}
      href={href}
      // The console has one, light appearance; the tile matches it, not the Insights preference.
      theme="light"
    />
  )
}
