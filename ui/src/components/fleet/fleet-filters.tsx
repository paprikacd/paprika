"use client"

import { Search, X } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"

import type { FleetFacetBucket } from "@/lib/fleet-client"
import {
  FLEET_GROUP_VALUES,
  FLEET_HEALTH_VALUES,
  FLEET_RELEASE_VALUES,
  FLEET_ROLLOUT_VALUES,
  FLEET_SIZE_VALUES,
  FLEET_SOURCE_VALUES,
  FLEET_SYNC_VALUES,
  type FleetGroup,
  type FleetQueryPatch,
  type FleetQueryState,
  type FleetSize,
  type FleetView,
  type NamespacedKey,
} from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

export interface FleetFiltersProps {
  state: FleetQueryState
  facets?: readonly FleetFacetBucket[]
  onPatch: (patch: FleetQueryPatch) => void
}

interface ObjectOption {
  id: string
  value: NamespacedKey
  label: string
  count?: bigint
}

interface StringOption {
  id: string
  value: string
  label: string
  count?: bigint
}

type ObjectFilterField = "projects" | "clusters"
type StringFilterField =
  | "stages"
  | "namespaces"
  | "health"
  | "sync"
  | "release"
  | "rollout"
  | "sources"

const presentations: readonly { value: FleetView; label: string; detail: string }[] = [
  { value: "treemap", label: "Treemap", detail: "Relative fleet footprint" },
  { value: "matrix", label: "Matrix", detail: "Cross-scope comparison" },
  { value: "table", label: "Table", detail: "Sortable inventory" },
  { value: "queue", label: "Queue", detail: "Highest impact first" },
]

const groupLabels: Record<FleetGroup, string> = {
  project: "Project",
  cluster: "Cluster",
  stage: "Stage",
  health: "Health",
}

const sizeLabels: Record<FleetSize, string> = {
  resource_count: "Resource count",
  request_rate: "Request rate",
}

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/
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
      projects: objectOptions("project", state.projects, facets),
      clusters: objectOptions("cluster", state.clusters, facets),
      stages: stringOptions("stage", state.stages, facets),
      namespaces: stringOptions("namespace", state.namespaces, facets),
      health: enumOptions("health", FLEET_HEALTH_VALUES, facets),
      sync: enumOptions("sync", FLEET_SYNC_VALUES, facets),
      release: enumOptions("release", FLEET_RELEASE_VALUES, facets),
      rollout: enumOptions("rollout", FLEET_ROLLOUT_VALUES, facets),
      sources: enumOptions("source_type", FLEET_SOURCE_VALUES, facets),
    }),
    [facets, state.clusters, state.namespaces, state.projects, state.stages],
  )

  const toggleObject = (
    field: ObjectFilterField,
    current: readonly NamespacedKey[],
    value: NamespacedKey,
    checked: boolean,
  ) => {
    const id = objectId(value)
    const next = checked
      ? uniqueObjects([...current, value])
      : current.filter((item) => objectId(item) !== id)
    onPatch({ [field]: next })
  }

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
    if (view === "table") {
      onPatch({ view, sort: "name", direction: "asc" })
      return
    }
    if (view === "queue") {
      onPatch({ view, sort: "impact", direction: "desc" })
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
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
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

      {hasSelections(state) ? (
        <div
          aria-label="Active filters"
          className="flex gap-2 overflow-x-auto border-b border-border px-4 py-2 sm:flex-wrap sm:px-6"
        >
          <ObjectSelectionChips
            label="project"
            values={state.projects}
            onRemove={(value) => onPatch({ projects: withoutObject(state.projects, value) })}
          />
          <ObjectSelectionChips
            label="cluster"
            values={state.clusters}
            onRemove={(value) => onPatch({ clusters: withoutObject(state.clusters, value) })}
          />
          <StringSelectionChips
            label="stage"
            values={state.stages}
            onRemove={(value) => onPatch({ stages: state.stages.filter((item) => item !== value) })}
          />
          <StringSelectionChips
            label="namespace"
            values={state.namespaces}
            onRemove={(value) =>
              onPatch({ namespaces: state.namespaces.filter((item) => item !== value) })
            }
          />
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
          <ObjectFilterGroup
            legend="Project"
            options={options.projects}
            selected={state.projects}
            onToggle={(value, checked) => toggleObject("projects", state.projects, value, checked)}
          />
          <ObjectFilterGroup
            legend="Cluster"
            options={options.clusters}
            selected={state.clusters}
            onToggle={(value, checked) => toggleObject("clusters", state.clusters, value, checked)}
          />
          <StringFilterGroup
            legend="Stage"
            options={options.stages}
            selected={state.stages}
            onToggle={(value, checked) => toggleString("stages", state.stages, value, checked)}
          />
          <StringFilterGroup
            legend="Namespace"
            options={options.namespaces}
            selected={state.namespaces}
            onToggle={(value, checked) =>
              toggleString("namespaces", state.namespaces, value, checked)
            }
          />
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

function CanvasControls({
  state,
  onPatch,
}: Pick<FleetFiltersProps, "state" | "onPatch">) {
  if (state.view !== "treemap" && state.view !== "matrix") return null

  return (
    <div
      aria-label={`${state.view === "treemap" ? "Treemap" : "Matrix"} layout controls`}
      className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3 sm:px-6"
    >
      {state.view === "treemap" ? (
        <SelectControl
          label="Group treemap by"
          value={state.group}
          options={FLEET_GROUP_VALUES.map((value) => ({ value, label: groupLabels[value] }))}
          onChange={(value) => onPatch({ group: value as FleetGroup })}
        />
      ) : (
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
      )}
      <SelectControl
        label="Size applications by"
        value={state.size}
        options={FLEET_SIZE_VALUES.map((value) => ({ value, label: sizeLabels[value] }))}
        onChange={(value) => onPatch({ size: value as FleetSize })}
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

function ObjectFilterGroup({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: "Project" | "Cluster"
  options: readonly ObjectOption[]
  selected: readonly NamespacedKey[]
  onToggle: (value: NamespacedKey, checked: boolean) => void
}) {
  const selectedIds = new Set(selected.map(objectId))
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
          accessibleName={`${legend} ${option.id}`}
          label={option.label}
          technicalLabel={option.id}
          count={option.count}
          checked={selectedIds.has(option.id)}
          onChange={(checked) => onToggle(option.value, checked)}
        />
      ))}
    </FilterGroup>
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

function ObjectSelectionChips({
  label,
  values,
  onRemove,
}: {
  label: "project" | "cluster"
  values: readonly NamespacedKey[]
  onRemove: (value: NamespacedKey) => void
}) {
  return values.filter(validObject).map((value) => (
    <SelectionChip
      key={`${label}:${objectId(value)}`}
      label={label}
      value={objectId(value)}
      onRemove={() => onRemove(value)}
    />
  ))
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

function objectOptions(
  dimension: "project" | "cluster",
  selected: readonly NamespacedKey[],
  facets: readonly FleetFacetBucket[],
): ObjectOption[] {
  const options = new Map<string, ObjectOption>()
  for (const value of selected) {
    if (!validObject(value)) continue
    const id = objectId(value)
    options.set(id, { id, value: { ...value }, label: id })
  }
  for (const facet of facets) {
    if (facet.dimension !== dimension || !facet.object || !validObject(facet.object)) continue
    const id = objectId(facet.object)
    options.set(id, {
      id,
      value: { ...facet.object },
      label: facet.label.trim() || id,
      count: facet.count,
    })
  }
  return [...options.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function stringOptions(
  dimension: "stage" | "namespace",
  selected: readonly string[],
  facets: readonly FleetFacetBucket[],
): StringOption[] {
  const options = new Map<string, StringOption>()
  for (const value of selected) {
    const normalized = value.trim()
    if (normalized) options.set(normalized, { id: normalized, value: normalized, label: normalized })
  }
  for (const facet of facets) {
    const value = facet.value?.trim()
    if (facet.dimension !== dimension || !value) continue
    options.set(value, {
      id: value,
      value,
      label: facet.label.trim() || value,
      count: facet.count,
    })
  }
  return [...options.values()].sort((left, right) => left.id.localeCompare(right.id))
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

function validObject(value: NamespacedKey): boolean {
  return (
    value.namespace.length > 0 &&
    value.namespace.length <= 63 &&
    dnsLabel.test(value.namespace) &&
    value.name.length > 0 &&
    value.name.length <= 253 &&
    value.name.split(".").every((part) => part.length <= 63 && dnsLabel.test(part))
  )
}

function uniqueObjects(values: readonly NamespacedKey[]): NamespacedKey[] {
  const unique = new Map<string, NamespacedKey>()
  for (const value of values) {
    if (validObject(value)) unique.set(objectId(value), { ...value })
  }
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

function withoutObject(values: readonly NamespacedKey[], target: NamespacedKey): NamespacedKey[] {
  const targetId = objectId(target)
  return uniqueObjects(values).filter((value) => objectId(value) !== targetId)
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

function hasSelections(state: FleetQueryState): boolean {
  return (
    state.projects.length +
      state.clusters.length +
      state.stages.length +
      state.namespaces.length +
      state.health.length +
      state.sync.length +
      state.release.length +
      state.rollout.length +
      state.sources.length >
    0
  )
}
