"use client"

import { Search } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import type { FleetFacetBucket, FleetFacetDimension } from "@/lib/fleet-client"
import {
  FLEET_HEALTH_VALUES,
  FLEET_RELEASE_VALUES,
  FLEET_ROLLOUT_VALUES,
  FLEET_SOURCE_VALUES,
  FLEET_SYNC_VALUES,
  type FleetQueryPatch,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

/**
 * Facets replace the nine-fieldset disclosure the console used to carry. Each
 * chip is one server-counted bucket: the label and the count both come from
 * `QueryApplications`, so a facet nobody has cannot appear, and a count is
 * never a guess.
 */
export interface FacetToolbarProps {
  state: FleetQueryState
  facets: readonly FleetFacetBucket[]
  onPatch: (patch: FleetQueryPatch) => void
  /** Right-aligned scope summary, e.g. `100 loaded / 10,000 indexed`. */
  summary?: string
}

type ChipField = "health" | "sync" | "stages" | "sources" | "release" | "rollout"

interface FacetDimensionSpec {
  dimension: FleetFacetDimension
  field: ChipField
  values?: readonly string[]
}

/**
 * Ordered by how often an operator reaches for them. Project and cluster are
 * deliberately absent: they are scope, and scope lives in the console header.
 * Namespace is absent too — one chip per namespace is unbounded at fleet
 * scale, and the URL still carries `namespace=` for a deep link.
 */
const FACET_DIMENSIONS: readonly FacetDimensionSpec[] = [
  { dimension: "health", field: "health", values: FLEET_HEALTH_VALUES },
  { dimension: "sync", field: "sync", values: FLEET_SYNC_VALUES },
  { dimension: "rollout", field: "rollout", values: FLEET_ROLLOUT_VALUES },
  { dimension: "release", field: "release", values: FLEET_RELEASE_VALUES },
  { dimension: "stage", field: "stages" },
  { dimension: "source_type", field: "sources", values: FLEET_SOURCE_VALUES },
]

/** Keeps the chip row bounded however many buckets the index reports. */
const CHIPS_PER_DIMENSION = 6

interface FacetChip {
  id: string
  field: ChipField
  value: string
  label: string
  count: bigint
  selected: boolean
}

export function FacetToolbar({
  state,
  facets,
  onPatch,
  summary,
}: FacetToolbarProps) {
  const inputId = useId()
  const chips = facetChips(state, facets)
  const activeCount = chips.filter((chip) => chip.selected).length

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2.5 border-y border-rule bg-card px-5.5 py-1.5">
      <SearchField id={inputId} value={state.q} onPatch={onPatch} />

      <span aria-hidden className="hidden h-5 w-px bg-rule sm:block" />

      <div
        role="group"
        aria-label="Facet filters"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
      >
        {chips.length === 0 ? (
          <p className="text-note text-neutral-600">
            No facets in this scope
          </p>
        ) : (
          chips.map((chip) => (
            <FacetChipButton
              key={chip.id}
              chip={chip}
              onToggle={() =>
                onPatch(toggleFacet(state, chip.field, chip.value))
              }
            />
          ))
        )}
        {activeCount > 0 ? (
          <button
            type="button"
            onClick={() =>
              onPatch({
                health: [],
                sync: [],
                release: [],
                rollout: [],
                stages: [],
                sources: [],
              })
            }
            className="inline-flex h-6 cursor-pointer items-center rounded-[2px] border border-rule bg-card px-2 text-note text-steel-700 hover:bg-inset pointer-coarse:h-11"
          >
            Clear {activeCount} facet{activeCount === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      {summary ? (
        <p className="font-mono text-meta whitespace-nowrap text-muted-foreground">
          {summary}
        </p>
      ) : null}
    </div>
  )
}

function FacetChipButton({
  chip,
  onToggle,
}: {
  chip: FacetChip
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={chip.selected}
      aria-label={`${chip.label}, ${chip.count.toString()} applications`}
      onClick={onToggle}
      className={cn(
        "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-[2px] border px-2.5 text-note pointer-coarse:h-11",
        chip.selected
          ? "border-primary bg-selected text-steel-800"
          : "border-rule bg-card text-muted-foreground hover:bg-inset"
      )}
    >
      {chip.label}
      <span aria-hidden className="font-mono text-meta opacity-60">
        {chip.count.toString()}
      </span>
    </button>
  )
}

/**
 * The input keeps its own draft so typing is not interrupted by the URL
 * round-trip, and re-seeds when the query changes underneath it — the console
 * header writes the same `q`.
 */
function SearchField({
  id,
  value,
  onPatch,
}: {
  id: string
  value: string
  onPatch: (patch: FleetQueryPatch) => void
}) {
  const [draft, setDraft] = useState(value)
  const [committed, setCommitted] = useState(value)
  const timer = useRef<number | undefined>(undefined)

  if (value !== committed) {
    setCommitted(value)
    setDraft(value)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const schedule = (next: string) => {
    setDraft(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const search = next.trim()
      if (search === value) return
      setCommitted(search)
      onPatch({ q: search })
    }, 250)
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Search
        aria-hidden="true"
        strokeWidth={1.5}
        className="size-3.5 shrink-0 text-neutral-600"
      />
      <label htmlFor={id} className="sr-only">
        Filter applications by name, project, cluster or revision
      </label>
      <input
        id={id}
        type="search"
        value={draft}
        onChange={(event) => schedule(event.target.value)}
        placeholder="name, project, cluster, revision…"
        className="w-56 min-w-0 border-0 bg-transparent text-console outline-none placeholder:text-neutral-500"
      />
    </span>
  )
}

function facetChips(
  state: FleetQueryState,
  facets: readonly FleetFacetBucket[],
): FacetChip[] {
  const chips: FacetChip[] = []
  for (const spec of FACET_DIMENSIONS) {
    const selected = new Set<string>(state[spec.field] as readonly string[])
    const buckets = facets
      .filter((facet) => facet.dimension === spec.dimension)
      .map((facet) => ({ value: facet.value ?? "", facet }))
      .filter(({ value }) => value.length > 0)
      .filter(({ value }) => !spec.values || spec.values.includes(value))

    // Selected buckets always render, whatever their rank, so a filter can
    // always be switched off from the chip that switched it on.
    const ordered = [
      ...buckets.filter(({ value }) => selected.has(value)),
      ...buckets
        .filter(({ value }) => !selected.has(value))
        .sort((left, right) => Number(right.facet.count - left.facet.count))
        .slice(0, CHIPS_PER_DIMENSION),
    ]

    for (const { value, facet } of ordered) {
      chips.push({
        id: `${spec.dimension}:${value}`,
        field: spec.field,
        value,
        label: facet.label || humanize(value),
        count: facet.count,
        selected: selected.has(value),
      })
    }
  }
  return chips
}

function toggleFacet(
  state: FleetQueryState,
  field: ChipField,
  value: string,
): FleetQueryPatch {
  const current = state[field] as readonly string[]
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value]
  return { [field]: next } as FleetQueryPatch
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
