"use client"

import type { PromiseClient } from "@connectrpc/connect"

import type { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { DataClass, DataState } from "@/gen/paprika/v1/api_pb"
import {
  numbersAreReal,
  useDataSourceIndex,
  type DataSourcesClient,
} from "@/lib/data-state"

/**
 * `GetDataSources` is the console's boot-time capability probe. It answers
 * with exactly one `DataSourceStatus` per `DataClass`, in enum order, always,
 * so a surface can ask "does this class exist here?" once instead of firing
 * the RPC behind it and guessing from an empty result.
 *
 * The distinction matters: an empty list because nothing is configured and an
 * empty list because there is genuinely nothing to show read identically on
 * the wire, and telling an operator the wrong one of those wastes an
 * afternoon. So a board consults the probe first and, when the class is not
 * configured, does not render at all — no zeros, no dashes, no placeholder
 * rows. See 01-backend-design.md section 4.
 *
 * The probe itself now lives in `@/lib/data-state`, which owns the single
 * react-query entry the whole console shares. This module is the clusters
 * route's projection of it and nothing more.
 */

export type DataSourceClient = Pick<
  PromiseClient<typeof PaprikaService>,
  "getDataSources"
>

export interface DataSourceReading {
  state: DataState
  provider: string
  observedAtUnixMs: bigint
  stalenessBudgetMs: bigint
  unavailableReason: string
}

export interface DataSourceProbe {
  isLoading: boolean
  isError: boolean
  /** Undefined until the probe answers, or if the server omitted the class. */
  reading: (dataClass: DataClass) => DataSourceReading | undefined
}

/** The two states in which a class carries numbers worth rendering. */
export function hasData(state: DataState | undefined): boolean {
  return numbersAreReal(state)
}

export function useDataSources(client: DataSourceClient): DataSourceProbe {
  const probe = useDataSourceIndex(client as unknown as DataSourcesClient)

  return {
    isLoading: probe.isLoading,
    isError: probe.isError,
    reading: (dataClass: DataClass) => {
      const source = probe.reading(dataClass)
      if (!source) return undefined
      return {
        state: source.state,
        provider: source.provider,
        observedAtUnixMs: source.observedAtUnixMs,
        stalenessBudgetMs: source.stalenessBudgetMs,
        unavailableReason: source.unavailableReason,
      }
    },
  }
}
