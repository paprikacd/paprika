"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useMemo } from "react"

import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { useConnection } from "@/lib/connection-context"
import type { FleetFacetBucket } from "@/lib/fleet-client"
import {
  FLEET_SOURCE_VALUES,
  mergeFleetQuery,
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
  type FleetSource,
} from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import { useFleetData } from "@/lib/use-fleet-data"

/**
 * Repositories, honestly scoped.
 *
 * There is no repository inventory on this API. A repository exists on the
 * wire only as a field of an application, and the index publishes facets by
 * *source type*, not by repository — so the fleet-wide question this page can
 * answer is "what kind of source does the fleet deploy from, and how much of
 * it", not "here are your 41 repositories". Counting distinct repositories
 * from a page of applications would produce a number that changes with the
 * page size, which is exactly the sort of figure this console does not print.
 *
 * So the board reports the source-type facets, which are exact and fleet-wide,
 * each one a way into the application list; and the page says plainly what it
 * cannot tell you.
 */

const counter = new Intl.NumberFormat("en-US")

const SOURCE_LABELS: Record<FleetSource, string> = {
  git: "Git",
  helm: "Helm",
  kustomize: "Kustomize",
  s3: "S3",
  oci: "OCI",
  inline: "Inline",
}

export function RepositoriesView() {
  const searchParams = useSearchParams()
  const { reportRequestOutcome } = useConnection()

  const raw = searchParams.toString()
  const state = useMemo(
    () =>
      mergeFleetQuery(parseFleetQuery(raw).state, {
        view: "matrix",
        rows: "project",
        columns: "cluster",
      }),
    [raw]
  )
  const fleet = useFleetData(state)
  useFleetRefresh(fleet.refresh, {
    onRequestOutcome: reportRequestOutcome,
    refreshOnMount: false,
  })

  const result =
    fleet.displayData?.kind === "matrix" ? fleet.displayData.result : undefined
  usePublishConsoleScope({
    facets: result?.facets,
    indexGeneration: result?.indexGeneration,
    // No `refreshedAt`: `useFleetData` does not surface the moment its query
    // resolved, and reading the clock during render would make the age a
    // property of the paint rather than of the data. The header falls back to
    // reporting the poll cadence, which is true either way.
    isRefreshing: fleet.isLoading || fleet.isStale,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const sources = useMemo(
    () =>
      fleet.applicationFacets.filter(
        (facet) => facet.dimension === "source_type"
      ),
    [fleet.applicationFacets]
  )

  return (
    <div className="px-5 pt-4 pb-8">
      <header className="mb-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Sources
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Repositories
        </h1>
      </header>

      <FleetStateNotice status={fleet.status} />

      {result ? (
        <Blueprint>
          <BoardHeader
            index="01"
            title="Where the fleet deploys from"
            meta={`${counter.format(result.total)} applications · gen ${result.indexGeneration.toString()}`}
          />
          {sources.length === 0 ? (
            <p role="status" className="px-3.5 py-6 text-reason text-muted-foreground">
              No application in this scope reports a source type.
            </p>
          ) : (
            <table
              aria-label="Applications by source type"
              className="w-full border-collapse text-left"
            >
              <thead>
                <tr className="bg-inset">
                  <th
                    scope="col"
                    className="border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
                  >
                    Source type
                  </th>
                  <th
                    scope="col"
                    className="border-b border-rule-strong px-3.5 py-1.5 text-right font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
                  >
                    Applications
                  </th>
                </tr>
              </thead>
              <tbody>
                {sources.map((facet) => (
                  <tr
                    key={facet.label}
                    className="border-b border-rule-soft last:border-b-0"
                  >
                    <th scope="row" className="px-3.5 py-2 font-normal">
                      <SourceName state={state} facet={facet} />
                    </th>
                    <td className="px-3.5 py-2 text-right font-mono text-console tabular-nums">
                      {counter.format(facet.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Blueprint>
      ) : null}

      <div className="mt-4">
        <Blueprint>
          <BoardHeader index="02" title="Repository inventory" />
          <div role="status" className="px-3.5 py-5">
            <p className="max-w-prose text-reason text-neutral-800">
              Paprika has no repository inventory: a repository is a property of
              an application, not an object this API lists. Rather than count
              distinct repositories from whichever applications happen to be
              loaded — a number that would change with the page size — the
              console reports the source of each application on its own record.
            </p>
            <p className="mt-2 font-mono text-meta text-muted-foreground">
              Open an application to see its source type, repository and
              resolved revision.
            </p>
          </div>
        </Blueprint>
      </div>
    </div>
  )
}

/**
 * A facet is only a filter if the console can express it. Where the bucket
 * carries a source type the console models, the name is a link into the
 * filtered application list; otherwise it stays plain text rather than a link
 * that would quietly drop the filter.
 */
function SourceName({
  state,
  facet,
}: {
  state: FleetQueryState
  facet: FleetFacetBucket
}) {
  const source = asFleetSource(facet.value)
  const label = source ? SOURCE_LABELS[source] : facet.label
  if (!source) {
    return (
      <span className="font-cond text-name font-semibold tracking-[0.02em]">
        {label}
      </span>
    )
  }
  const params = serializeFleetQuery(
    mergeFleetQuery(state, { view: "table", sources: [source] })
  )
  return (
    <Link
      href={`/dashboard/applications/?${params.toString()}`}
      className="font-cond text-name font-semibold tracking-[0.02em] text-foreground no-underline hover:underline"
    >
      {label}
    </Link>
  )
}

function asFleetSource(value: string | undefined): FleetSource | undefined {
  return FLEET_SOURCE_VALUES.find((candidate) => candidate === value)
}
