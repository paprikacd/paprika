"use client"

import Link from "next/link"
import { useApplicationDashboards } from "@/lib/insights-coverage"
import { insightsDashboardHref } from "@/lib/insights-link"

/** The header link to the most specific Insights dashboard covering the application. Renders nothing when none does. */
export function ApplicationMetricsLink({ namespace, name }: { namespace: string; name: string }) {
  const query = useApplicationDashboards(namespace, name)
  const top = query.data?.[0]
  if (!top) return null
  return (
    <Link
      href={insightsDashboardHref(top.id, top.variables)}
      className="inline-flex h-[30px] items-center border border-rule bg-card px-3 font-cond text-label font-semibold no-underline hover:bg-inset"
    >
      Open metrics
    </Link>
  )
}

/** The Health tab's list of dashboards covering the application. An unhealthy application names the first one to check. */
export function ApplicationDashboards({ namespace, name, unhealthy }: { namespace: string; name: string; unhealthy: boolean }) {
  const query = useApplicationDashboards(namespace, name)
  const dashboards = query.data ?? []
  const top = dashboards[0]
  if (!top) return null
  return (
    <section aria-labelledby="application-dashboards-heading" className="mb-6 border border-rule bg-card p-4">
      <h3 id="application-dashboards-heading" className="font-cond text-label font-semibold">
        Dashboards for this application
      </h3>
      {unhealthy ? (
        <p className="mt-2 text-sm">
          Check its metrics:{" "}
          <Link href={insightsDashboardHref(top.id, top.variables)} className="underline">
            {top.title}
          </Link>
        </p>
      ) : null}
      <ul className="mt-2 space-y-1 text-sm">
        {dashboards.map((dashboard) => (
          <li key={dashboard.id}>
            <Link href={insightsDashboardHref(dashboard.id, dashboard.variables)} className="underline">
              {dashboard.title}
            </Link>
            {dashboard.folder ? <span className="ml-2 text-muted-foreground">{dashboard.folder}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
