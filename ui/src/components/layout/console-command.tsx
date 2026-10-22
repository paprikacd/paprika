"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { QuickCommand, type QuickCommandItem } from "@/components/ui/quick-command"
import { applicationURL } from "@/lib/application-url"
import { queryApplications } from "@/lib/fleet-client"
import { DEFAULT_FLEET_QUERY } from "@/lib/fleet-query"
import type { NamespacedKey } from "@/lib/fleet-query"

/**
 * The console's own destinations. They are always available, even when the
 * fleet index is not configured, so the palette never opens empty-handed.
 */
interface Destination extends QuickCommandItem {
  href: string
}

const DESTINATIONS: readonly Destination[] = [
  {
    id: "destination:overview",
    label: "Overview",
    group: "Go to",
    description: "Fleet posture, attention and in-flight work",
    href: "/dashboard/",
  },
  {
    id: "destination:applications",
    label: "Applications",
    group: "Go to",
    description: "The indexed fleet inventory",
    href: "/dashboard/applications/",
  },
  {
    id: "destination:map",
    label: "Fleet map",
    group: "Go to",
    description: "Every target, drawn by weight",
    href: "/dashboard/map/",
  },
  {
    id: "destination:rollouts",
    label: "Rollouts",
    group: "Go to",
    description: "The rollouts the control plane is reconciling",
    href: "/dashboard/rollouts/",
  },
  {
    id: "destination:pipelines",
    label: "Pipelines",
    group: "Go to",
    description: "Pipeline runs and their steps",
    href: "/dashboard/pipelines/",
  },
  {
    id: "destination:clusters",
    label: "Clusters",
    group: "Go to",
    description: "Registered clusters and their capacity",
    href: "/dashboard/clusters/",
  },
  {
    id: "destination:observability",
    label: "Observability",
    group: "Go to",
    description: "Provider library and query surfaces",
    href: "/dashboard/observability/",
  },
  {
    id: "destination:diff",
    label: "Sync & diff",
    group: "Go to",
    description: "Compare what is live against what is wanted",
    href: "/dashboard/diff/",
  },
]

function matches(item: QuickCommandItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [item.label, item.group, item.description ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle)
}

/** The palette lists commands; the destination it opens stays with the host. */
function asCommand(destination: Destination): QuickCommandItem {
  return {
    id: destination.id,
    label: destination.label,
    group: destination.group,
    description: destination.description,
  }
}

/**
 * The console's command palette.
 *
 * One search field, two kinds of result: the console's own destinations, and
 * the applications the fleet index knows about. The index search is
 * typo-tolerant and server-counted, so the palette asks the index rather than
 * filtering a list it does not have; the destinations are filtered here.
 */
export function ConsoleCommand({ className }: { className?: string }) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [applications, setApplications] = useState<
    (QuickCommandItem & { identity: NamespacedKey })[]
  >([])
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const runSearch = useCallback((text: string) => {
    window.clearTimeout(timer.current)
    if (!text.trim()) {
      setApplications([])
      return
    }
    timer.current = window.setTimeout(() => {
      void queryApplications(
        { ...DEFAULT_FLEET_QUERY, q: text.trim() },
        { pageSize: 6 },
      )
        .then((page) => {
          setApplications(
            page.applications
              .filter((application) => application.identity)
              .map((application) => ({
                id: `application:${application.identity?.namespace}/${application.identity?.name}`,
                label: application.identity?.name ?? "",
                group: "Applications",
                description: [
                  application.identity?.namespace,
                  application.attentionLabel,
                ]
                  .filter(Boolean)
                  .join(" · "),
                keywords: [application.attentionDetail ?? ""],
                identity: application.identity as NamespacedKey,
              })),
          )
        })
        .catch(() => {
          // A palette that cannot reach the index still offers destinations.
          setApplications([])
        })
    }, 180)
  }, [])

  const items = useMemo<QuickCommandItem[]>(() => {
    const destinations = DESTINATIONS.filter((item) => matches(item, query)).map(
      asCommand,
    )
    return [...destinations, ...applications]
  }, [applications, query])

  const choose = (item: QuickCommandItem) => {
    if (item.id.startsWith("application:")) {
      const identity = applications.find((entry) => entry.id === item.id)?.identity
      if (identity) {
        router.push(applicationURL(identity))
      }
      return
    }
    const destination = DESTINATIONS.find((entry) => entry.id === item.id)
    if (destination) router.push(destination.href)
  }

  return (
    <QuickCommand
      items={items}
      filterItems={false}
      shortcut
      label="Search commands"
      placeholder="Search applications and pages…"
      onQueryChange={(text) => {
        setQuery(text)
        runSearch(text)
      }}
      onSelect={choose}
      className={className}
    />
  )
}
