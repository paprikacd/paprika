import { useQuery } from "@tanstack/react-query"
import { sessionFetch } from "./session-request"

/** One dashboard that covers an application, as GET /api/insights/application-dashboards returns it. */
export type ApplicationDashboard = {
  id: string
  title: string
  folder?: string
  variables: Record<string, string>
  summaryWidgetId?: string
  /** The summary widget's saved height in dashboard grid rows. */
  summaryWidgetRows?: number
  specificity: number
}

type ApplicationDashboardList = {
  dashboards?: ApplicationDashboard[]
  truncated?: boolean
}

export function applicationDashboardsURL(namespace: string, name: string): string {
  return `/api/insights/application-dashboards?${new URLSearchParams({ namespace, name })}`
}

/** The dashboards covering an application, most specific first. Insights off, a denied read or a failure gives none. */
export async function fetchApplicationDashboards(namespace: string, name: string, signal?: AbortSignal): Promise<ApplicationDashboard[]> {
  const response = await sessionFetch(applicationDashboardsURL(namespace, name), { signal }, true)
  if (!response.ok) return []
  const body = (await response.json()) as ApplicationDashboardList
  return body.dashboards ?? []
}

export function useApplicationDashboards(namespace: string, name: string) {
  return useQuery({
    queryKey: ["insights", "application-dashboards", namespace, name],
    queryFn: ({ signal }) => fetchApplicationDashboards(namespace, name, signal),
    enabled: namespace !== "" && name !== "",
    retry: false,
    staleTime: 60_000,
  })
}
