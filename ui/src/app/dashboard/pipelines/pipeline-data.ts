"use client"

import { createPromiseClient, type PromiseClient } from "@connectrpc/connect"
import { useEffect, useState } from "react"

import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import { createTransport } from "@/lib/transport"

import { indexDataSources, type DataSourceIndex } from "./pipeline-model"

let cachedClient: PromiseClient<typeof PaprikaService> | null = null

/** One client per browser session, created lazily so tests can mock first. */
export function pipelineApi(): PromiseClient<typeof PaprikaService> {
  cachedClient ??= createPromiseClient(PaprikaService, createTransport())
  return cachedClient
}

let dataSourcesRequest: Promise<DataSourceIndex> | null = null

/**
 * `GetDataSources` is a boot-time capability probe, not a per-view query —
 * the console calls it once and every gated surface reads the answer. A
 * failed probe resolves to an empty index, which reads as NOT_CONFIGURED
 * everywhere: failing closed hides boards instead of inventing them.
 */
export function loadDataSources(): Promise<DataSourceIndex> {
  dataSourcesRequest ??= pipelineApi()
    .getDataSources({})
    .then((response) => indexDataSources(response.sources))
    .catch(() => {
      dataSourcesRequest = null
      return indexDataSources([])
    })
  return dataSourcesRequest
}

/** Test seam. Production code never needs to forget the probe. */
export function resetDataSourcesCache(): void {
  dataSourcesRequest = null
  cachedClient = null
}

/** `null` until the probe resolves — gated surfaces stay hidden until then. */
export function useDataSources(): DataSourceIndex | null {
  const [index, setIndex] = useState<DataSourceIndex | null>(null)

  useEffect(() => {
    let active = true
    void loadDataSources().then((next) => {
      if (active) setIndex(next)
    })
    return () => {
      active = false
    }
  }, [])

  return index
}

/** A clock that only ticks while a pipeline is still moving. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  return now
}
