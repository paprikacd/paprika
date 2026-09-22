"use client"

import { useQuery } from "@tanstack/react-query"

import { CostBasis } from "@/gen/paprika/v1/api_pb"
import type { DataStateName } from "@/components/fleet/data-sources"
import { getFleetClient } from "@/lib/fleet-client"
import type { NamespacedKey } from "@/lib/fleet-query"

/**
 * Cost is the clearest case in the degraded-mode contract: with no cost source
 * configured the whole class is `NOT_CONFIGURED` and every cost surface in the
 * console disappears. Nothing here ever invents a figure — an absent entry is
 * absent, not zero.
 */
export type CostBasisName =
  | "unspecified"
  | "rate_card_requested"
  | "rate_card_allocatable"
  | "billing"

export interface ApplicationCostView {
  application: NamespacedKey
  state: DataStateName
  basis: CostBasisName
  monthlyAmount: number
  currency: string
  unavailableReason: string
}

export interface FleetCostResult {
  /** The class-level state returned with the query. */
  state: DataStateName
  /** Keyed `namespace/name`. Only applications the server priced appear. */
  costs: Map<string, ApplicationCostView>
  /** The basis behind the figures, so an estimate can never read as a bill. */
  basis: CostBasisName
}

export interface FleetCostClient {
  queryCost: (
    applications: readonly NamespacedKey[],
    signal?: AbortSignal,
  ) => Promise<FleetCostResult>
}

const BASIS_NAMES: Record<CostBasis, CostBasisName> = {
  [CostBasis.UNSPECIFIED]: "unspecified",
  [CostBasis.RATE_CARD_REQUESTED]: "rate_card_requested",
  [CostBasis.RATE_CARD_ALLOCATABLE]: "rate_card_allocatable",
  [CostBasis.BILLING]: "billing",
}

const STATE_NAMES: Record<number, DataStateName> = {
  0: "unspecified",
  1: "ok",
  2: "not_configured",
  3: "not_available",
  4: "stale",
  5: "error",
  6: "forbidden",
}

const defaultClient: FleetCostClient = {
  queryCost: async (applications, signal) => {
    const response = await getFleetClient().queryCost(
      {
        applications: applications.map((application) => ({
          namespace: application.namespace,
          name: application.name,
        })),
        pageSize: applications.length,
      },
      { signal },
    )
    const costs = new Map<string, ApplicationCostView>()
    for (const entry of response.applications) {
      const application = entry.application
      const cost = entry.cost
      if (!application || !cost) continue
      costs.set(`${application.namespace}/${application.name}`, {
        application: {
          namespace: application.namespace,
          name: application.name,
        },
        state: STATE_NAMES[cost.state] ?? "unspecified",
        basis: BASIS_NAMES[cost.basis] ?? "unspecified",
        monthlyAmount: cost.monthlyAmount,
        currency: cost.currency,
        unavailableReason: cost.unavailableReason,
      })
    }
    return {
      state: STATE_NAMES[response.state] ?? "unspecified",
      costs,
      basis: BASIS_NAMES[response.total?.basis ?? CostBasis.UNSPECIFIED] ?? "unspecified",
    }
  },
}

export const EMPTY_COSTS: FleetCostResult = {
  state: "not_configured",
  costs: new Map(),
  basis: "unspecified",
}

/**
 * Prices only the applications already on screen. The fleet index pages at
 * 100, so this request is bounded by the loaded window rather than by the
 * size of the fleet.
 */
export function useApplicationCosts({
  identities,
  enabled,
  client = defaultClient,
}: {
  identities: readonly NamespacedKey[]
  enabled: boolean
  client?: FleetCostClient
}): FleetCostResult {
  const keys = identities.map(
    (identity) => `${identity.namespace}/${identity.name}`,
  )
  const query = useQuery<FleetCostResult>({
    queryKey: ["console", "cost", keys.join(",")],
    queryFn: ({ signal }) => client.queryCost(identities, signal),
    enabled: enabled && identities.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
  return query.data ?? EMPTY_COSTS
}

/** `$4.1k`, `$980`, `€12.4k`. Never a bare number without its currency. */
export function formatMonthlyCost(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return ""
  const prefix = currencyPrefix(currency)
  const magnitude = Math.abs(amount)
  if (magnitude >= 1_000_000) return `${prefix}${round(amount / 1_000_000)}M`
  if (magnitude >= 1_000) return `${prefix}${round(amount / 1_000)}k`
  return `${prefix}${Math.round(amount)}`
}

/** An estimate must never read as a measurement. */
export function isCostEstimate(basis: CostBasisName): boolean {
  return basis === "rate_card_requested" || basis === "rate_card_allocatable"
}

export function costBasisLabel(basis: CostBasisName): string {
  switch (basis) {
    case "rate_card_requested":
      return "Estimate · rate card × requested resources"
    case "rate_card_allocatable":
      return "Estimate · rate card × node allocatable"
    case "billing":
      return "Billed spend"
    default:
      return "Basis unknown"
  }
}

function round(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

function currencyPrefix(currency: string): string {
  switch (currency.toUpperCase()) {
    case "USD":
      return "$"
    case "EUR":
      return "€"
    case "GBP":
      return "£"
    case "":
      return ""
    default:
      return `${currency.toUpperCase()} `
  }
}
