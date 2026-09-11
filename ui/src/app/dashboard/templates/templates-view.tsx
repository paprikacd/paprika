"use client"

import type { PromiseClient } from "@connectrpc/connect"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useCallback, useMemo } from "react"

import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { ApplicationSet } from "@/gen/paprika/v1/api_pb"
import { getFleetClient } from "@/lib/fleet-client"
import { parseFleetQuery } from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import { useConnection } from "@/lib/connection-context"
import type { StatusTone } from "@/lib/status-tone"

/**
 * Templates — the design's name for ApplicationSets, the generators that fan
 * one definition out into many applications.
 *
 * `ListApplicationSets` returns four fields per set: name, namespace, the
 * number of applications it has generated, and a phase derived from its Ready
 * condition. That is all this page shows. The set's generators, its template
 * and its per-application status live on the detail record, which each row
 * links to.
 *
 * The scope bar does not apply here: the RPC filters by namespace only, and
 * the fleet index this console usually scopes against does not carry
 * ApplicationSets at all. The page therefore publishes empty scope signals
 * rather than leaving another view's index generation on screen.
 */

export type TemplatesClient = Pick<
  PromiseClient<typeof PaprikaService>,
  "listApplicationSets"
>

export interface TemplatesViewProps {
  client?: TemplatesClient
}

const MAX_LISTED_SETS = 200

const counter = new Intl.NumberFormat("en-US")

export function TemplatesView({ client }: TemplatesViewProps) {
  const resolved = useMemo(() => client ?? getFleetClient(), [client])
  const searchParams = useSearchParams()
  const { reportRequestOutcome } = useConnection()

  const raw = searchParams.toString()
  // One selected namespace is a filter the RPC can honour. Several is not, so
  // the page asks for everything the caller may see rather than silently
  // answering for one of them.
  const namespace = useMemo(() => {
    const namespaces = parseFleetQuery(raw).state.namespaces
    return namespaces.length === 1 ? namespaces[0] : undefined
  }, [raw])

  usePublishConsoleScope({ intervalMs: FLEET_REFRESH_INTERVAL_MS })

  const sets = useQuery({
    queryKey: ["console", "applicationsets", namespace ?? ""],
    queryFn: async ({ signal }) => {
      const response = await resolved.listApplicationSets(
        namespace ? { namespace } : {},
        { signal }
      )
      return response.applicationsets
    },
  })

  const refetch = sets.refetch
  useFleetRefresh(
    useCallback(() => refetch(), [refetch]),
    { onRequestOutcome: reportRequestOutcome, refreshOnMount: false }
  )

  const rows = sets.data ?? []
  const generated = rows.reduce((total, set) => total + set.applications, 0)

  return (
    <div className="px-5 pt-4 pb-8">
      <header className="mb-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Sources
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Templates
        </h1>
        <p className="mt-1.5 max-w-prose text-reason text-muted-foreground">
          ApplicationSets generate applications from one definition.
          {namespace ? ` Scoped to namespace ${namespace}.` : ""}
        </p>
      </header>

      <Blueprint>
        <BoardHeader
          index="01"
          title="ApplicationSets"
          meta={
            sets.isSuccess
              ? `${counter.format(rows.length)} sets · ${counter.format(generated)} generated applications`
              : undefined
          }
        />
        {sets.isPending ? (
          <p
            role="status"
            aria-live="polite"
            className="px-3.5 py-6 text-reason text-muted-foreground"
          >
            Loading ApplicationSets.
          </p>
        ) : sets.isError ? (
          <p role="alert" className="px-3.5 py-6 text-reason text-muted-foreground">
            Paprika could not list ApplicationSets. Nothing here is missing; it
            is unknown.
          </p>
        ) : rows.length === 0 ? (
          <div role="status" className="px-3.5 py-6">
            <p className="text-reason text-neutral-800">
              No ApplicationSets are visible in this scope.
            </p>
            <p className="mt-1.5 max-w-prose font-mono text-meta text-muted-foreground">
              Create an ApplicationSet to generate applications from a single
              template.
            </p>
          </div>
        ) : (
          <>
            <table
              aria-label="ApplicationSets"
              className="w-full border-collapse text-left"
            >
              <thead>
                <tr className="bg-inset">
                  <th scope="col" className={headClass()}>
                    Name
                  </th>
                  <th scope="col" className={headClass()}>
                    State
                  </th>
                  <th scope="col" className={headClass(true)}>
                    Applications
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, MAX_LISTED_SETS).map((set) => (
                  <tr
                    key={`${set.namespace}/${set.name}`}
                    className="border-b border-rule-soft last:border-b-0"
                  >
                    <th scope="row" className="px-3.5 py-2 font-normal">
                      <Link
                        href={detailHref(set)}
                        className="block font-cond text-name font-semibold tracking-[0.02em] text-foreground no-underline hover:underline"
                      >
                        {set.name}
                      </Link>
                      <span className="block font-mono text-meta text-muted-foreground">
                        {set.namespace}
                      </span>
                    </th>
                    <td className="px-3.5 py-2">
                      <StatusPill
                        tone={phaseTone(set.phase)}
                        label={phaseLabel(set.phase)}
                      />
                    </td>
                    <td className="px-3.5 py-2 text-right font-mono text-console tabular-nums">
                      {counter.format(set.applications)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > MAX_LISTED_SETS ? (
              <p className="border-t border-rule px-3.5 py-2 text-note text-muted-foreground">
                Showing the first {counter.format(MAX_LISTED_SETS)} of{" "}
                {counter.format(rows.length)} ApplicationSets.
              </p>
            ) : null}
          </>
        )}
      </Blueprint>
    </div>
  )
}

function headClass(alignRight = false): string {
  return [
    "border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase",
    alignRight ? "text-right" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

function detailHref(set: ApplicationSet): string {
  const params = new URLSearchParams({
    namespace: set.namespace,
    name: set.name,
  })
  return `/dashboard/applicationsets/detail/?${params.toString()}`
}

/**
 * The server sends a phase string derived from the Ready condition. Anything
 * it does not recognise is reported verbatim under the unknown tone rather
 * than being forced into a state the console made up.
 */
function phaseTone(phase: string): StatusTone {
  switch (phase) {
    case "Ready":
      return "healthy"
    case "NotReady":
      return "degraded"
    default:
      return "unknown"
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "Ready":
      return "Ready"
    case "NotReady":
      return "Not ready"
    default:
      return phase || "Unknown"
  }
}
