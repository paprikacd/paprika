"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { createPromiseClient } from "@connectrpc/connect"
import { ArrowLeft, ArrowRight, ChevronRight, Search } from "lucide-react"

import { ReleaseGrid } from "@/components/dashboard/release-table"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  FleetFilter,
  FleetObjectKey,
  type Release,
} from "@/gen/paprika/v1/api_pb"
import {
  RELEASE_MAX_OFFSET,
  RELEASE_PAGE_SIZE,
  parseReleaseQuery,
  releaseURL,
  type ReleaseQueryState,
} from "@/lib/release-query"
import { createTransport } from "@/lib/transport"
import { fleetHref } from "@/lib/fleet-navigation"

const client = createPromiseClient(PaprikaService, createTransport())
const MAX_QUERYABLE_PAGE = Math.floor(RELEASE_MAX_OFFSET / RELEASE_PAGE_SIZE) + 1
const PAGE_SIZE_BIGINT = BigInt(RELEASE_PAGE_SIZE)
const MAX_QUERYABLE_PAGE_BIGINT = BigInt(MAX_QUERYABLE_PAGE)
const ZERO_BIGINT = BigInt(0)
const ONE_BIGINT = BigInt(1)

export function releasePageCount(total: bigint): number {
  if (total <= ZERO_BIGINT) return 1
  const pages = (total + PAGE_SIZE_BIGINT - ONE_BIGINT) / PAGE_SIZE_BIGINT
  return Number(
    pages > MAX_QUERYABLE_PAGE_BIGINT ? MAX_QUERYABLE_PAGE_BIGINT : pages,
  )
}

interface ReleasePageData {
  releases: Release[]
  total: bigint
}

function releaseFilter(state: ReleaseQueryState): FleetFilter {
  return new FleetFilter({
    projects: state.projects.map(
      (project) => new FleetObjectKey({ namespace: project.namespace, name: project.name }),
    ),
    clusters: state.clusters.map(
      (cluster) => new FleetObjectKey({ namespace: cluster.namespace, name: cluster.name }),
    ),
    stages: [...state.stages],
    namespaces: [...state.namespaces],
    health: [],
    sync: [],
    releaseStates: [],
    rolloutStates: [],
    sourceTypes: [],
  })
}

function PaginationLink({
  href,
  label,
  disabled,
  direction,
}: {
  href: string
  label: string
  disabled: boolean
  direction: "previous" | "next"
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault()
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-45"
    >
      {direction === "previous" && <ArrowLeft className="size-3.5" aria-hidden="true" />}
      {direction === "previous" ? "Previous" : "Next"}
      {direction === "next" && <ArrowRight className="size-3.5" aria-hidden="true" />}
    </Link>
  )
}

function ReleasesContent() {
  const { replace } = useRouter()
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const parsed = useMemo(() => parseReleaseQuery(rawQuery), [rawQuery])
  const state = parsed.state
  const canonicalQuery = useMemo(() => releaseURL(state), [state])
  const [searchDraft, setSearchDraft] = useState({ source: state.q, value: state.q })
  const [pendingSearchCommits, setPendingSearchCommits] = useState<string[]>([])
  const lastHandledSearchURL = useRef(state.q)
  const pendingSearchAcknowledgement = pendingSearchCommits.includes(state.q)
  const search =
    searchDraft.source === state.q || pendingSearchAcknowledgement
      ? searchDraft.value
      : state.q
  const [data, setData] = useState<ReleasePageData>({ releases: [], total: ZERO_BIGINT })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const requestGeneration = useRef(0)

  useEffect(() => {
    if (parsed.needsCanonicalReplace) replace(canonicalQuery)
  }, [canonicalQuery, parsed.needsCanonicalReplace, replace])

  useEffect(() => {
    if (lastHandledSearchURL.current === state.q) return
    lastHandledSearchURL.current = state.q
    const acknowledgement = pendingSearchCommits.indexOf(state.q)

    queueMicrotask(() => {
      if (acknowledgement >= 0) {
        setPendingSearchCommits((current) => {
          const currentAcknowledgement = current.indexOf(state.q)
          return currentAcknowledgement >= 0
            ? current.slice(currentAcknowledgement + 1)
            : current
        })
        setSearchDraft((current) =>
          current.source === state.q ? current : { source: state.q, value: current.value },
        )
        return
      }

      setPendingSearchCommits([])
      setSearchDraft((current) =>
        current.source === state.q && current.value === state.q
          ? current
          : { source: state.q, value: state.q },
      )
    })
  }, [pendingSearchCommits, state.q])

  useEffect(() => {
    if (search.trim() === state.q) return
    const timer = window.setTimeout(() => {
      const committedSearch = search.trim()
      setPendingSearchCommits((current) =>
        current.at(-1) === committedSearch ? current : [...current, committedSearch],
      )
      replace(releaseURL(state, { q: committedSearch }))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [replace, search, state])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++requestGeneration.current
    const pageOffset = (state.page - 1) * RELEASE_PAGE_SIZE
    let redirecting = false

    queueMicrotask(() => {
      if (controller.signal.aborted || generation !== requestGeneration.current) return
      setLoading(true)
      setError(null)
    })

    void client
      .queryReleases(
        {
          filter: releaseFilter(state),
          search: state.q,
          pageSize: RELEASE_PAGE_SIZE,
          pageOffset,
        },
        { signal: controller.signal },
      )
      .then((response) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return

        const total = response.totalCount
        const lastPage = releasePageCount(total)
        if (state.page > lastPage) {
          redirecting = true
          if (total === ZERO_BIGINT) setData({ releases: [], total })
          replace(releaseURL(state, { page: lastPage }))
          return
        }

        setData({ releases: response.releases, total })
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return
        console.error(requestError)
        setError("Unable to load releases. Try again.")
      })
      .finally(() => {
        if (controller.signal.aborted || generation !== requestGeneration.current || redirecting) return
        setLoading(false)
      })

    return () => controller.abort()
  }, [canonicalQuery, replace, retryGeneration, state])

  const totalPages = releasePageCount(data.total)
  const previousHref = releaseURL(state, { page: Math.max(1, state.page - 1) })
  const nextHref = releaseURL(state, { page: Math.min(totalPages, state.page + 1) })

  return (
    <main className="mx-auto max-w-[100rem] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href={fleetHref("/dashboard", new URLSearchParams(rawQuery))} className="hover:text-foreground">
          Dashboard
        </Link>
        <ChevronRight className="size-3.5" aria-hidden="true" />
        <span className="text-foreground">Releases</span>
      </nav>

      <header className="flex flex-col gap-4 border-b border-border/70 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            Deployment control plane
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Releases</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Inspect coordinated promotions, rollout state, policy results, and deployment evidence.
          </p>
        </div>
        <label className="relative block w-full lg:w-80">
          <span className="sr-only">Search releases</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search releases"
            value={search}
            onChange={(event) => setSearchDraft({ source: state.q, value: event.target.value })}
            placeholder="Search release, app, pipeline…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </label>
      </header>

      <ReleaseGrid
        releases={data.releases}
        query={rawQuery}
        loading={loading}
        search={state.q}
        error={error}
        onRetry={() => setRetryGeneration((generation) => generation + 1)}
      />

      <footer className="flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          Page {state.page} of {totalPages} · {data.total.toString()} total
        </p>
        <div className="flex items-center gap-2">
          <PaginationLink
            href={previousHref}
            label="Previous page"
            disabled={loading || state.page <= 1}
            direction="previous"
          />
          <PaginationLink
            href={nextHref}
            label="Next page"
            disabled={loading || state.page >= totalPages}
            direction="next"
          />
        </div>
      </footer>
    </main>
  )
}

export default function ReleasesPage() {
  return (
    <Suspense fallback={<div role="status" className="px-6 py-8 text-sm text-muted-foreground">Loading releases…</div>}>
      <ReleasesContent />
    </Suspense>
  )
}
