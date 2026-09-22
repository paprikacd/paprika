"use client"

import { Select } from "@base-ui/react/select"
import { ChevronDown, Search } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type {
  FleetFacetBucket,
  FleetFacetDimension,
} from "@/lib/fleet-client"
import {
  mergeFleetQuery,
  parseFleetQuery,
  serializeFleetQueryPreserving,
  type FleetQueryPatch,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

/**
 * Pages know the fleet-wide facet counts and the index generation; the header
 * lives above them in the shell. This lets a page publish what it has learned
 * so the scope bar can show real option counts instead of a bare list.
 */
export interface ConsoleScopeSignals {
  facets?: FleetFacetBucket[]
  indexGeneration?: bigint
  /** Epoch ms of the last successful fetch. */
  refreshedAt?: number
  isRefreshing?: boolean
  /** Poll cadence in ms for the active view. */
  intervalMs?: number
}

const ScopeSignalsContext = createContext<{
  signals: ConsoleScopeSignals
  publish: (signals: ConsoleScopeSignals) => void
}>({ signals: {}, publish: () => {} })

export function ConsoleScopeProvider({ children }: { children: ReactNode }) {
  const [signals, setSignals] = useState<ConsoleScopeSignals>({})
  const value = useMemo(
    () => ({ signals, publish: setSignals }),
    [signals]
  )
  return (
    <ScopeSignalsContext.Provider value={value}>
      {children}
    </ScopeSignalsContext.Provider>
  )
}

/** Called by a page once its fleet query resolves. */
export function usePublishConsoleScope(signals: ConsoleScopeSignals) {
  const { publish } = useContext(ScopeSignalsContext)
  const {
    facets,
    indexGeneration,
    refreshedAt,
    isRefreshing,
    intervalMs,
  } = signals
  useEffect(() => {
    publish({ facets, indexGeneration, refreshedAt, isRefreshing, intervalMs })
  }, [publish, facets, indexGeneration, refreshedAt, isRefreshing, intervalMs])
}

const SCOPES = [
  {
    key: "project" as const,
    label: "Project",
    dimension: "project" as const,
  },
  {
    key: "cluster" as const,
    label: "Cluster",
    dimension: "cluster" as const,
  },
  {
    key: "stage" as const,
    label: "Stage",
    dimension: "stage" as const,
  },
]

// Sentinel for the unscoped option. Select needs a non-empty value, and
// this cannot collide with a "namespace/name" key or a stage label.
const ALL = "__all__"

/** Matches the facet toolbar, so the two search affordances feel the same. */
const SEARCH_DEBOUNCE_MS = 250

export function ConsoleHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { signals } = useContext(ScopeSignalsContext)

  const raw = searchParams.toString()
  const state = useMemo(() => parseFleetQuery(raw).state, [raw])

  const apply = (patch: FleetQueryPatch) => {
    // Preserve parameters this header does not own — detail routes are keyed
    // by `?namespace=&name=`, and dropping `name` would navigate the operator
    // off the object they were looking at.
    const next = serializeFleetQueryPreserving(
      mergeFleetQuery(state, patch),
      raw,
    )
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  // Typing must not put a history entry and a refetch on every keystroke.
  // 250ms matches the debounce the facet toolbar uses.
  const searchTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(searchTimer.current), [])
  const applySearch = (q: string) => {
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => apply({ q }), SEARCH_DEBOUNCE_MS)
  }

  const selection = scopeSelection(state)
  const anyScope = SCOPES.some((scope) => selection[scope.key] !== ALL)

  return (
    <header className="sticky top-14 z-30 flex h-header items-stretch border-b border-rule bg-card lg:top-0">
      <div className="flex min-w-0 flex-1 items-center">
        {SCOPES.map((scope) => (
          <ScopeSelect
            key={scope.key}
            label={scope.label}
            value={selection[scope.key]}
            options={facetOptions(signals.facets, scope.dimension)}
            onChange={(value) => apply(scopePatch(scope.key, value))}
          />
        ))}

        {anyScope ? (
          <button
            type="button"
            onClick={() =>
              apply({ projects: [], clusters: [], stages: [] })
            }
            className="flex h-full items-center gap-1.5 border-r border-rule px-3 text-note whitespace-nowrap text-steel-700 hover:bg-foreground/[0.04]"
          >
            {scopeSummary(selection)} · clear
          </button>
        ) : null}

        <div className="flex min-w-0 flex-1 items-center gap-2 px-3.5">
          <Search
            className="size-3.5 shrink-0 text-neutral-600"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <input
            type="search"
            defaultValue={state.q}
            onChange={(event) => applySearch(event.target.value)}
            aria-label="Search applications, resources, revisions and runs"
            placeholder="Search apps, resources, revisions, runs…"
            className="min-w-0 flex-1 border-0 bg-transparent text-console outline-none placeholder:text-neutral-500"
          />
        </div>
      </div>

      <FreshnessIndicator signals={signals} />
    </header>
  )
}

/**
 * The design shows `live · 12s` beside a pulsing dot. The console has no push
 * channel — it polls — so this reports the real cadence and the age of the
 * last successful fetch rather than implying a live stream.
 */
function FreshnessIndicator({ signals }: { signals: ConsoleScopeSignals }) {
  const { refreshedAt, isRefreshing, intervalMs, indexGeneration } = signals
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const age = refreshedAt ? Math.max(0, Math.round((now - refreshedAt) / 1000)) : null
  const cadence = intervalMs ? `${Math.round(intervalMs / 1000)}s` : null

  return (
    <div className="flex items-center gap-3 border-l border-rule px-3.5">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 bg-primary",
            isRefreshing && "motion-safe:animate-[var(--animate-blip)]"
          )}
          aria-hidden="true"
        />
        <span className="font-mono text-meta text-muted-foreground">
          {isRefreshing
            ? "refreshing"
            : age === null
              ? cadence
                ? `polling · ${cadence}`
                : "polling"
              : `polled ${formatAge(age)} ago`}
        </span>
      </span>
      {indexGeneration !== undefined ? (
        <span className="font-mono text-meta text-neutral-600">
          gen {indexGeneration.toString()}
        </span>
      ) : null}
    </div>
  )
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function ScopeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string; count?: bigint }[]
  onChange: (value: string) => void
}) {
  const all = [{ value: ALL, label: "All" }, ...options]
  const current = all.find((option) => option.value === value)

  return (
    <Select.Root
      value={value}
      onValueChange={(next) => onChange(next ?? ALL)}
    >
      <Select.Trigger className="flex h-full items-center gap-2 border-r border-rule px-3 hover:bg-foreground/[0.04] data-[popup-open]:bg-inset">
        <span className="font-mono text-kicker tracking-[0.12em] text-neutral-600 uppercase">
          {label}
        </span>
        <span className="font-cond text-label font-semibold tracking-[0.02em] whitespace-nowrap">
          {current?.label ?? "All"}
        </span>
        <Select.Icon>
          <ChevronDown
            className="size-3 text-neutral-600"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="start" sideOffset={0}>
          <Select.Popup className="z-[80] max-h-80 min-w-[220px] overflow-y-auto border border-rule-strong bg-card shadow-dropdown">
            {all.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                className="flex cursor-pointer items-center justify-between gap-4 px-3 py-1.5 text-console data-[highlighted]:bg-inset data-[selected]:bg-selected"
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                {option.count !== undefined ? (
                  <span className="font-mono text-meta text-neutral-600">
                    {option.count.toString()}
                  </span>
                ) : null}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function facetOptions(
  facets: FleetFacetBucket[] | undefined,
  dimension: FleetFacetDimension
) {
  return (facets ?? [])
    .filter((bucket) => bucket.dimension === dimension)
    .map((bucket) => ({
      value: bucket.object
        ? `${bucket.object.namespace}/${bucket.object.name}`
        : (bucket.value ?? bucket.label),
      label: bucket.label,
      count: bucket.count,
    }))
}

function scopeSelection(state: FleetQueryState): Record<string, string> {
  return {
    project: state.projects[0]
      ? `${state.projects[0].namespace}/${state.projects[0].name}`
      : ALL,
    cluster: state.clusters[0]
      ? `${state.clusters[0].namespace}/${state.clusters[0].name}`
      : ALL,
    stage: state.stages[0] ?? ALL,
  }
}

function scopePatch(key: string, value: string): FleetQueryPatch {
  if (key === "stage") {
    return { stages: value === ALL ? [] : [value] }
  }
  const objects =
    value === ALL
      ? []
      : [
          {
            namespace: value.split("/")[0] ?? "",
            name: value.split("/").slice(1).join("/"),
          },
        ]
  return key === "project" ? { projects: objects } : { clusters: objects }
}

function scopeSummary(selection: Record<string, string>): string {
  const parts = SCOPES.filter((scope) => selection[scope.key] !== ALL).map(
    (scope) => {
      const raw = selection[scope.key]
      return raw.includes("/") ? raw.split("/").slice(1).join("/") : raw
    }
  )
  return parts.join(" · ")
}
