"use client"

import type { PromiseClient } from "@connectrpc/connect"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useSyncExternalStore } from "react"

import { ProviderLibrary } from "@/app/dashboard/observability/provider-library"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { DataState } from "@/gen/paprika/v1/api_pb"
import { getFleetClient } from "@/lib/fleet-client"
import type { StatusTone } from "@/lib/status-tone"

/**
 * Observability, as three independent surfaces.
 *
 * The library board (00) is the gateway's catalog of provider types plus the
 * onboarding wizard that creates ObservabilityProvider CRs from it. It is
 * gateway data and follows the degraded-mode contract: a non-OK `DataState`
 * renders the server's `unavailableReason` verbatim instead of an empty
 * grid. The wizard itself lives in `provider-library.tsx`.
 *
 * The providers board (01) lists the ObservabilityProvider CRs this server
 * can read. It is ordinary inventory — it works whether or not the
 * observability gateway is wired in, because the CRs live on the api-server's
 * own cluster.
 *
 * The usage board (02) is different: its numbers come from the gateway
 * process, over a connection the api-server may not have.
 * `GetObservabilityUsage` answers that with a `DataState` — when it is not
 * `OK` the response carries no tool rows at all, and under the degraded-mode
 * contract the board then renders the server's own `unavailableReason`
 * sentence verbatim rather than a table of zeros. An empty list and an
 * unavailable gateway read identically on the wire; the state field is what
 * keeps them apart.
 */

export type ObservabilityClient = Pick<
  PromiseClient<typeof PaprikaService>,
  | "listObservabilityProviders"
  | "getObservabilityUsage"
  | "listObservabilityProviderTypes"
  | "getObservabilityProviderType"
  | "validateObservabilityProvider"
  | "createObservabilityProvider"
>

export interface ObservabilityViewProps {
  client?: ObservabilityClient
}

const counter = new Intl.NumberFormat("en-US")

function subscribeToNothing() {
  return () => {}
}

export function ObservabilityView({ client }: ObservabilityViewProps) {
  const resolved = useMemo(() => client ?? getFleetClient(), [client])

  const providers = useQuery({
    queryKey: ["console", "observability-providers"],
    queryFn: async ({ signal }) =>
      resolved.listObservabilityProviders({}, { signal }),
  })

  const usage = useQuery({
    queryKey: ["console", "observability-usage"],
    queryFn: async ({ signal }) => resolved.getObservabilityUsage({}, { signal }),
    staleTime: 30_000,
  })

  // This page is statically prerendered, so the server pass and the client's
  // first hydration render must agree: the server snapshot renders no origin
  // (no footer), and React swaps in the client snapshot after hydration.
  const gatewayOrigin = useSyncExternalStore(
    subscribeToNothing,
    () => window.location.origin,
    () => "",
  )

  const items = providers.data?.items ?? []

  return (
    <div className="px-5 pt-4 pb-8">
      <header className="mb-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Sources
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Observability
        </h1>
      </header>

      <ProviderLibrary client={resolved} />

      <div className="mt-4">
        <Blueprint>
          <BoardHeader
            index="01"
            title="Observability providers"
            meta={
              providers.data
                ? `${counter.format(providers.data.total)} providers · gen ${providers.data.indexGeneration.toString()}`
                : undefined
            }
          />
          {providers.isPending ? (
            <p
              role="status"
              aria-live="polite"
              className="px-3.5 py-5 text-reason text-muted-foreground"
            >
              Loading observability providers.
            </p>
          ) : providers.isError ? (
            <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
              Paprika could not list observability providers. Nothing here is
              missing; it is unknown.
            </p>
          ) : items.length === 0 ? (
            <p role="status" className="px-3.5 py-6 text-reason text-muted-foreground">
              No observability providers. Annotate a Service with
              observability.paprika.io/discover=true or apply an
              ObservabilityProvider manifest, or set one up from the provider
              library above.
            </p>
          ) : (
            <table
              aria-label="Observability providers"
              className="w-full border-collapse text-left"
            >
              <thead>
                <tr className="bg-inset">
                  {["Provider", "Type", "Signals", "Endpoint", "State", "Discovered"].map(
                    (heading) => (
                      <th key={heading} scope="col" className={cellHeadClass()}>
                        {heading}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  // Keyed on the namespaced object, not the name: two providers
                  // in different namespaces can share a name.
                  <tr
                    key={`${item.namespace}/${item.name}`}
                    className="border-b border-rule-soft last:border-b-0"
                  >
                    <th scope="row" className="px-3.5 py-2 font-normal">
                      <span className="block font-cond text-name font-semibold tracking-[0.02em]">
                        {item.name}
                      </span>
                      <span className="block font-mono text-meta text-muted-foreground">
                        {item.namespace}
                      </span>
                    </th>
                    <td className="px-3.5 py-2 font-mono text-note text-muted-foreground">
                      {item.type || "unknown"}
                    </td>
                    <td className="px-3.5 py-2">
                      {item.signals.length === 0 ? (
                        <span className="font-mono text-note text-muted-foreground">
                          not reported
                        </span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {item.signals.map((signal) => (
                            <StatusPill key={signal} tone="unknown" label={signal} />
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-2">
                      <span
                        className="block max-w-56 truncate font-mono text-meta text-muted-foreground"
                        title={item.endpoint || undefined}
                      >
                        {item.endpoint || "not reported"}
                      </span>
                    </td>
                    <td className="px-3.5 py-2">
                      <StatusPill
                        tone={providerStateTone(item.state)}
                        label={providerStateLabel(item.state)}
                      />
                      {item.state !== "OK" && item.reason ? (
                        <span className="mt-1 block max-w-64 text-reason text-muted-foreground">
                          {item.reason}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3.5 py-2">
                      {item.discovered ? (
                        <StatusPill tone="progressing" label="Discovered" />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Blueprint>
      </div>

      <div className="mt-4">
        <Blueprint>
          <BoardHeader
            index="02"
            title="Tool usage"
            meta={
              usage.data?.state === DataState.OK
                ? `${counter.format(totalCalls(usage.data.tools))} calls`
                : undefined
            }
          />
          {usage.isPending ? (
            <p
              role="status"
              aria-live="polite"
              className="px-3.5 py-5 text-reason text-muted-foreground"
            >
              Loading tool usage.
            </p>
          ) : usage.isError ? (
            <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
              Paprika could not read observability tool usage. Nothing here is
              missing; it is unknown.
            </p>
          ) : usage.data && usage.data.state !== DataState.OK ? (
            // Degraded-mode contract: the server declares the surface
            // unavailable and explains why in its own words. Per-tool counts
            // are omitted rather than reported as zero — an empty list and an
            // unreachable gateway are different statements.
            <div role="status" className="px-3.5 py-5">
              <p className="text-reason text-neutral-800">
                {usage.data.unavailableReason ||
                  "Observability tool usage is not available on this server."}
              </p>
              <p className="mt-2 font-mono text-meta text-muted-foreground">
                Per-tool call and error counts are omitted rather than reported
                as zero.
              </p>
            </div>
          ) : usage.data && usage.data.tools.length === 0 ? (
            <p role="status" className="px-3.5 py-6 text-reason text-muted-foreground">
              The gateway has not recorded any tool calls yet.
            </p>
          ) : usage.data ? (
            <>
              <table
                aria-label="Observability tool usage"
                className="w-full border-collapse text-left"
              >
                <thead>
                  <tr className="bg-inset">
                    <th scope="col" className={cellHeadClass()}>
                      Tool
                    </th>
                    <th scope="col" className={cellHeadClass(true)}>
                      Calls
                    </th>
                    <th scope="col" className={cellHeadClass(true)}>
                      Errors
                    </th>
                    <th scope="col" className={cellHeadClass(true)}>
                      Error share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usage.data.tools.map((tool) => (
                    <tr
                      key={tool.name}
                      className="border-b border-rule-soft last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="px-3.5 py-2 font-mono text-console font-normal"
                      >
                        {tool.name}
                      </th>
                      <td className="px-3.5 py-2 text-right font-mono text-console tabular-nums">
                        {counter.format(tool.calls)}
                      </td>
                      <td className={errorsCellClass(tool.errors > 0)}>
                        {counter.format(tool.errors)}
                      </td>
                      <td
                        className={shareCellClass(tool.calls === BigInt(0))}
                      >
                        {errorShare(tool.calls, tool.errors)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {gatewayOrigin ? (
                <p className="border-t border-rule px-3.5 py-2 text-reason text-muted-foreground">
                  Gateway MCP endpoint: {gatewayOrigin}/observe/mcp
                </p>
              ) : null}
            </>
          ) : null}
        </Blueprint>
      </div>
    </div>
  )
}

function cellHeadClass(alignRight = false): string {
  return [
    "border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase",
    alignRight ? "text-right" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * The provider state arrives in the CR status's own vocabulary, not an enum,
 * so the mapping is an explicit switch: a state word the console has never
 * seen lands on `unknown`, never on a guessed tone.
 */
function providerStateTone(state: string): StatusTone {
  switch (state) {
    case "OK":
      return "healthy"
    case "Error":
      return "failed"
    case "Forbidden":
      return "degraded"
    case "NotConfigured":
    case "NotAvailable":
      return "pending"
    default:
      return "unknown"
  }
}

function providerStateLabel(state: string): string {
  switch (state) {
    case "OK":
      return "OK"
    case "Error":
      return "Error"
    case "Forbidden":
      return "Forbidden"
    case "NotConfigured":
      return "Not configured"
    case "NotAvailable":
      return "Not available"
    case "":
      return "Unknown"
    default:
      return state
  }
}

function totalCalls(tools: { calls: bigint }[]): bigint {
  return tools.reduce((sum, tool) => sum + tool.calls, BigInt(0))
}

function errorShare(calls: bigint, errors: bigint): string {
  if (calls === BigInt(0)) return "—"
  return `${((Number(errors) / Number(calls)) * 100).toFixed(1)}%`
}

function errorsCellClass(hasErrors: boolean): string {
  return [
    "px-3.5 py-2 text-right font-mono text-console tabular-nums",
    hasErrors ? "font-semibold text-status-failed-text" : "text-muted-foreground",
  ].join(" ")
}

function shareCellClass(isEmpty: boolean): string {
  return [
    "px-3.5 py-2 text-right font-mono text-console tabular-nums",
    isEmpty ? "text-muted-foreground" : "",
  ]
    .filter(Boolean)
    .join(" ")
}
