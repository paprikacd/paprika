"use client"

import { Search, X } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"

import type { FleetFacetBucket } from "@/lib/fleet-client"
import {
  FLEET_DENSITY_VALUES,
  FLEET_DIRECTION_VALUES,
  FLEET_GROUP_VALUES,
  FLEET_HEALTH_VALUES,
  FLEET_LABEL_MODE_VALUES,
  FLEET_MATRIX_SORT_VALUES,
  FLEET_RELEASE_VALUES,
  FLEET_ROLLOUT_VALUES,
  FLEET_SIZE_VALUES,
  FLEET_SORT_VALUES,
  FLEET_SOURCE_VALUES,
  FLEET_SYNC_VALUES,
  fleetMatrixSort,
  isFleetMatrixSort,
  type FleetDensity,
  type FleetDirection,
  type FleetGroup,
  type FleetLabelMode,
  type FleetMatrixSort,
  type FleetQueryPatch,
  type FleetQueryState,
  type FleetSize,
  type FleetSort,
  type FleetView,
  type NamespacedKey,
} from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

export interface FleetFiltersProps {
  state: FleetQueryState
  facets?: readonly FleetFacetBucket[]
  onPatch: (patch: FleetQueryPatch) => void
}

interface StringOption {
  id: string
  value: string
  label: string
  count?: bigint
}

type StringFilterField =
  | "health"
  | "sync"
  | "release"
  | "rollout"
  | "sources"

const presentations: readonly { value: FleetView; label: string; detail: string }[] = [
  { value: "heatmap", label: "Heatmap", detail: "Equal-weight application health" },
  { value: "treemap", label: "Treemap", detail: "Relative fleet footprint" },
  { value: "matrix", label: "Matrix", detail: "Cross-scope comparison" },
  { value: "table", label: "Table", detail: "Sortable inventory" },
  { value: "queue", label: "Queue", detail: "Highest impact first" },
]

const groupLabels: Record<FleetGroup, string> = {
  project: "Project",
  cluster: "Cluster",
  stage: "Stage",
  namespace: "Namespace",
  health: "Health",
}

const sizeLabels: Record<FleetSize, string> = {
  resource_count: "Resource count",
  request_rate: "Request rate",
}

const densityLabels: Record<FleetDensity, string> = {
  auto: "Auto",
  compact: "Compact",
  comfortable: "Comfortable",
}

const labelModeLabels: Record<FleetLabelMode, string> = {
  auto: "Auto",
  all: "All",
  none: "None",
}

const sortLabels: Record<FleetSort, string> = {
  name: "Name",
  project: "Project",
  cluster: "Cluster",
  stage: "Stage",
  health: "Health",
  sync: "Sync",
  release: "Release",
  rollout: "Rollout",
  resource_count: "Resource count",
  last_transition: "Last transition",
  impact: "Impact",
  relevance: "Relevance",
}

const matrixSortLabels: Record<FleetMatrixSort, string> = {
  name: "Intersection",
  health: "Worst health",
  resource_count: "Resource weight",
  impact: "Operational impact",
}

const directionLabels: Record<FleetDirection, string> = {
  asc: "Ascending",
  desc: "Descending",
}

const FACET_WINDOW_SIZE = 50

export function FleetFilters({ state, facets = [], onPatch }: FleetFiltersProps) {
  const latestOnPatch = useRef(onPatch)
  const searchTimer = useRef<number | undefined>(undefined)
  const inputId = useId()

  useEffect(() => {
    latestOnPatch.current = onPatch
  }, [onPatch])

  useEffect(() => {
    return () => window.clearTimeout(searchTimer.current)
  }, [state.q])

  const scheduleSearch = (draft: string) => {
    window.clearTimeout(searchTimer.current)
    const search = draft.trim()
    if (search === state.q) return
    searchTimer.current = window.setTimeout(() => latestOnPatch.current({ q: search }), 250)
  }

  const options = useMemo(
    () => ({
      health: enumOptions("health", FLEET_HEALTH_VALUES, facets),
      sync: enumOptions("sync", FLEET_SYNC_VALUES, facets),
      release: enumOptions("release", FLEET_RELEASE_VALUES, facets),
      rollout: enumOptions("rollout", FLEET_ROLLOUT_VALUES, facets),
      sources: enumOptions("source_type", FLEET_SOURCE_VALUES, facets),
    }),
    [facets],
  )

  const toggleString = (
    field: StringFilterField,
    current: readonly string[],
    value: string,
    checked: boolean,
  ) => {
    const next = checked
      ? [...new Set([...current, value])].sort()
      : current.filter((item) => item !== value)
    onPatch({ [field]: next })
  }

  const selectPresentation = (view: FleetView) => {
    if (view === "matrix" && !isFleetMatrixSort(state.sort)) {
      onPatch({ view, sort: "name" })
      return
    }
    onPatch({ view })
  }

  return (
    <section aria-label="Fleet query controls" className="border-b border-border bg-card">
      <div className="grid gap-3 border-b border-border px-4 py-4 sm:px-6 xl:grid-cols-[minmax(18rem,1fr)_auto] xl:items-end">
        <div className="min-w-0">
          <label
            htmlFor={inputId}
            className="mb-1.5 block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
          >
            Search fleet
          </label>
          <div className="relative max-w-2xl">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              key={state.q}
              id={inputId}
              type="search"
              aria-label="Search applications"
              autoComplete="off"
              spellCheck={false}
              defaultValue={state.q}
              onChange={(event) => scheduleSearch(event.target.value)}
              placeholder="Application, project, cluster, revision…"
              className="min-h-11 w-full rounded-md border border-input bg-background pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <fieldset className="min-w-0">
          <legend className="mb-1.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Presentation
          </legend>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-5">
            {presentations.map((presentation) => {
              const active = state.view === presentation.value
              return (
                <button
                  key={presentation.value}
                  type="button"
                  data-preserve-fleet-focus="true"
                  aria-label={`Show ${presentation.label} view`}
                  aria-pressed={active}
                  title={presentation.detail}
                  onClick={() => selectPresentation(presentation.value)}
                  className={cn(
                    "min-h-11 min-w-[5.5rem] bg-background px-3 text-xs font-semibold transition-colors",
                    active
                      ? "bg-primary text-background"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {presentation.label}
                </button>
              )
            })}
          </div>
        </fieldset>
      </div>

      <CanvasControls state={state} onPatch={onPatch} />

      {hasScopeSelections(state) ? <ScopeSummary state={state} /> : null}

      {hasAdvancedSelections(state) ? (
        <div
          aria-label="Active filters"
          className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2 sm:flex-wrap sm:px-6"
        >
          <StringSelectionChips
            label="health"
            values={state.health}
            onRemove={(value) => onPatch({ health: state.health.filter((item) => item !== value) })}
          />
          <StringSelectionChips
            label="sync"
            values={state.sync}
            onRemove={(value) => onPatch({ sync: state.sync.filter((item) => item !== value) })}
          />
          <StringSelectionChips
            label="release"
            values={state.release}
            onRemove={(value) =>
              onPatch({ release: state.release.filter((item) => item !== value) })
            }
          />
          <StringSelectionChips
            label="rollout"
            values={state.rollout}
            onRemove={(value) =>
              onPatch({ rollout: state.rollout.filter((item) => item !== value) })
            }
          />
          <StringSelectionChips
            label="source"
            values={state.sources}
            onRemove={(value) => onPatch({ sources: state.sources.filter((item) => item !== value) })}
          />
        </div>
      ) : null}

      <details className="group/filters">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground hover:bg-muted/60 hover:text-foreground sm:px-6 [&::-webkit-details-marker]:hidden">
          <span>Filter dimensions</span>
          <span aria-hidden="true" className="text-base transition-transform group-open/filters:rotate-45">
            +
          </span>
        </summary>
        <div className="grid border-t border-border sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          <StringFilterGroup
            legend="Health"
            options={options.health}
            selected={state.health}
            onToggle={(value, checked) => toggleString("health", state.health, value, checked)}
          />
          <StringFilterGroup
            legend="Sync"
            options={options.sync}
            selected={state.sync}
            onToggle={(value, checked) => toggleString("sync", state.sync, value, checked)}
          />
          <StringFilterGroup
            legend="Release"
            options={options.release}
            selected={state.release}
            onToggle={(value, checked) => toggleString("release", state.release, value, checked)}
          />
          <StringFilterGroup
            legend="Rollout"
            options={options.rollout}
            selected={state.rollout}
            onToggle={(value, checked) => toggleString("rollout", state.rollout, value, checked)}
          />
          <StringFilterGroup
            legend="Source"
            options={options.sources}
            selected={state.sources}
            onToggle={(value, checked) => toggleString("sources", state.sources, value, checked)}
          />
        </div>
      </details>
    </section>
  )
}

function ScopeSummary({ state }: { state: FleetQueryState }) {
  return (
    <div
      role="group"
      aria-label="Fleet scope summary"
      className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2 sm:flex-wrap sm:px-6"
    >
      <span className="flex min-h-11 shrink-0 items-center font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Fleet scope
      </span>
      {state.projects.map((value) => (
        <ScopeSummaryItem
          key={`project:${objectId(value)}`}
          label="Project"
          value={objectId(value)}
        />
      ))}
      {state.clusters.map((value) => (
        <ScopeSummaryItem
          key={`cluster:${objectId(value)}`}
          label="Cluster"
          value={objectId(value)}
        />
      ))}
      {state.stages.map((value) => (
        <ScopeSummaryItem key={`stage:${value}`} label="Stage" value={value} />
      ))}
      {state.namespaces.map((value) => (
        <ScopeSummaryItem
          key={`namespace:${value}`}
          label="Namespace"
          value={value}
        />
      ))}
    </div>
  )
}

function ScopeSummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-h-11 shrink-0 items-center rounded-md border border-border bg-muted/40 px-3 font-mono text-xs text-foreground">
      {label} {value}
    </span>
  )
}

function CanvasControls({
  state,
  onPatch,
}: Pick<FleetFiltersProps, "state" | "onPatch">) {
  const presentationLabel =
    state.view === "heatmap"
      ? "Heatmap"
      : state.view === "treemap"
        ? "Treemap"
        : state.view === "matrix"
          ? "Matrix"
          : state.view === "table"
            ? "Table"
            : "Queue"

  return (
    <div
      aria-label={`${presentationLabel} layout controls`}
      className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3 sm:px-6"
    >
      {state.view === "heatmap" ? (
        <>
          <SelectControl
            label="Group heatmap by"
            value={state.group}
            options={FLEET_GROUP_VALUES.map((value) => ({ value, label: groupLabels[value] }))}
            onChange={(value) => onPatch({ group: value as FleetGroup })}
          />
          <SelectControl
            label="Heatmap density"
            value={state.density}
            options={FLEET_DENSITY_VALUES.map((value) => ({ value, label: densityLabels[value] }))}
            onChange={(value) => onPatch({ density: value as FleetDensity })}
          />
          <SelectControl
            label="Heatmap labels"
            value={state.labels}
            options={FLEET_LABEL_MODE_VALUES.map((value) => ({ value, label: labelModeLabels[value] }))}
            onChange={(value) => onPatch({ labels: value as FleetLabelMode })}
          />
        </>
      ) : state.view === "treemap" ? (
        <>
          <SelectControl
            label="Group treemap by"
            value={state.group}
            options={FLEET_GROUP_VALUES.map((value) => ({ value, label: groupLabels[value] }))}
            onChange={(value) => onPatch({ group: value as FleetGroup })}
          />
          <SelectControl
            label="Size applications by"
            value={state.size}
            options={FLEET_SIZE_VALUES.map((value) => ({ value, label: sizeLabels[value] }))}
            onChange={(value) => onPatch({ size: value as FleetSize })}
          />
        </>
      ) : state.view === "matrix" ? (
        <>
          <SelectControl
            label="Matrix rows"
            value={state.rows}
            options={FLEET_GROUP_VALUES.map((value) => ({ value, label: groupLabels[value] }))}
            onChange={(value) => onPatch({ rows: value as FleetGroup })}
          />
          <SelectControl
            label="Matrix columns"
            value={state.columns}
            options={FLEET_GROUP_VALUES.map((value) => ({ value, label: groupLabels[value] }))}
            onChange={(value) => onPatch({ columns: value as FleetGroup })}
          />
        </>
      ) : null}
      {state.view === "matrix" ? (
        <SelectControl
          label="Sort intersections by"
          value={fleetMatrixSort(state.sort)}
          options={FLEET_MATRIX_SORT_VALUES.map((value) => ({
            value,
            label: matrixSortLabels[value],
          }))}
          onChange={(value) => onPatch({ sort: value as FleetMatrixSort })}
        />
      ) : (
        <SelectControl
          label="Sort applications by"
          value={state.sort}
          options={FLEET_SORT_VALUES.map((value) => ({ value, label: sortLabels[value] }))}
          onChange={(value) => onPatch({ sort: value as FleetSort })}
        />
      )}
      <SelectControl
        label="Sort direction"
        value={state.direction}
        options={FLEET_DIRECTION_VALUES.map((value) => ({ value, label: directionLabels[value] }))}
        onChange={(value) => onPatch({ direction: value as FleetDirection })}
      />
    </div>
  )
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="grid min-w-40 gap-1">
      <span className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function StringFilterGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string
  options: readonly StringOption[]
  selected: readonly string[]
  onToggle: (value: string, checked: boolean) => void
}) {
  const selectedIds = new Set(selected)
  const [filter, setFilter] = useState("")
  const filteredOptions = useMemo(
    () => filterFacetOptions(options, filter),
    [filter, options],
  )
  const visibleOptions = filteredOptions.slice(0, FACET_WINDOW_SIZE)
  return (
    <FilterGroup
      legend={legend}
      empty={filteredOptions.length === 0}
      emptyMessage={options.length === 0 ? "No authorized values" : "No matching values"}
      search={options.length > FACET_WINDOW_SIZE ? { value: filter, onChange: setFilter } : undefined}
      remaining={filteredOptions.length - visibleOptions.length}
    >
      {visibleOptions.map((option) => (
        <FilterCheckbox
          key={option.id}
          accessibleName={`${legend} ${option.value}`}
          label={option.label}
          technicalLabel={option.label === option.value ? undefined : option.value}
          count={option.count}
          checked={selectedIds.has(option.value)}
          onChange={(checked) => onToggle(option.value, checked)}
        />
      ))}
    </FilterGroup>
  )
}

function FilterGroup({
  legend,
  empty,
  emptyMessage,
  search,
  remaining,
  children,
}: {
  legend: string
  empty: boolean
  emptyMessage: string
  search?: { value: string; onChange: (value: string) => void }
  remaining: number
  children: React.ReactNode
}) {
  return (
    <fieldset className="min-w-0 border-b border-r border-border p-4 last:border-r-0 sm:p-5">
      <legend className="float-left mb-2 w-full font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground">
        {legend}
      </legend>
      <div className="clear-both max-h-52 overflow-y-auto pr-1">
        {search ? (
          <label className="sticky top-0 z-10 mb-2 block bg-card pb-1">
            <span className="sr-only">Filter {legend} options</span>
            <input
              type="search"
              aria-label={`Filter ${legend} options`}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={`Find ${legend.toLowerCase()}…`}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        ) : null}
        {empty ? (
          <p className="py-2 text-xs text-muted-foreground">{emptyMessage}</p>
        ) : (
          children
        )}
        {remaining > 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {remaining.toLocaleString()} more values. Refine this filter to find them.
          </p>
        ) : null}
      </div>
    </fieldset>
  )
}

function FilterCheckbox({
  accessibleName,
  label,
  technicalLabel,
  count,
  checked,
  onChange,
}: {
  accessibleName: string
  label: string
  technicalLabel?: string
  count?: bigint
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2 text-sm transition-colors hover:bg-muted">
      <input
        type="checkbox"
        aria-label={accessibleName}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{label}</span>
        {technicalLabel ? (
          <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">
            {technicalLabel}
          </span>
        ) : null}
      </span>
      {count !== undefined ? (
        <span aria-hidden="true" className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
          {count.toString()}
        </span>
      ) : null}
    </label>
  )
}

function StringSelectionChips({
  label,
  values,
  onRemove,
}: {
  label: string
  values: readonly string[]
  onRemove: (value: string) => void
}) {
  return values.map((value) => (
    <SelectionChip
      key={`${label}:${value}`}
      label={label}
      value={value}
      onRemove={() => onRemove(value)}
    />
  ))
}

function SelectionChip({
  label,
  value,
  onRemove,
}: {
  label: string
  value: string
  onRemove: () => void
}) {
  return (
    <span className="inline-flex min-h-11 shrink-0 items-center overflow-hidden rounded-md border border-border bg-background pl-3 text-xs text-foreground">
      <span className="mr-1 font-mono text-[0.5625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="font-mono">{value}</span>
      <button
        type="button"
        aria-label={`Remove ${label} ${value}`}
        onClick={onRemove}
        className="ml-1 flex size-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  )
}

function enumOptions<T extends string>(
  dimension: "health" | "sync" | "release" | "rollout" | "source_type",
  values: readonly T[],
  facets: readonly FleetFacetBucket[],
): StringOption[] {
  const allowed = new Set<string>(values)
  const facetsByValue = new Map<string, FleetFacetBucket>()
  for (const facet of facets) {
    const value = facet.value?.trim()
    if (facet.dimension === dimension && value && allowed.has(value)) facetsByValue.set(value, facet)
  }

  return values.map((value) => {
    const facet = facetsByValue.get(value)
    return {
      id: value,
      value,
      label: facet?.label.trim() || humanize(value),
      count: facet?.count,
    }
  })
}

function objectId(value: NamespacedKey): string {
  return `${value.namespace}/${value.name}`
}

function filterFacetOptions<T extends { id: string; label: string }>(
  options: readonly T[],
  filter: string,
): T[] {
  const query = filter.trim().toLocaleLowerCase()
  if (!query) return [...options]
  return options.filter((option) =>
    `${option.id} ${option.label}`.toLocaleLowerCase().includes(query),
  )
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function hasScopeSelections(state: FleetQueryState): boolean {
  return (
    state.projects.length +
      state.clusters.length +
      state.stages.length +
      state.namespaces.length >
    0
  )
}

function hasAdvancedSelections(state: FleetQueryState): boolean {
  return (
    state.health.length +
      state.sync.length +
      state.release.length +
      state.rollout.length +
      state.sources.length >
    0
  )
}
