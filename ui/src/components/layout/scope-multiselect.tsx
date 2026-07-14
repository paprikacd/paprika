"use client"

import { Popover } from "@base-ui/react/popover"
import { ChevronDown, LoaderCircle, Search } from "lucide-react"
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import type {
  FleetScopeDimension,
  FleetScopeFacet,
} from "@/lib/fleet-scope-context"
import type { FleetDataStatus } from "@/lib/use-fleet-data"

const MAX_VISIBLE_OPTIONS = 100
const SELECTION_KEY_SEPARATOR = "\u0000"

const dimensionCopy: Record<
  FleetScopeDimension,
  { plural: string; singular: string; all: string }
> = {
  project: {
    plural: "Projects",
    singular: "Project",
    all: "All projects",
  },
  cluster: {
    plural: "Clusters",
    singular: "Cluster",
    all: "All clusters",
  },
  stage: { plural: "Stages", singular: "Stage", all: "All stages" },
  namespace: {
    plural: "Namespaces",
    singular: "Namespace",
    all: "All namespaces",
  },
}

interface DecoratedFacet {
  facet: FleetScopeFacet
  displayLabel: string
  technicalLabel?: string
}

type RetryState = "idle" | "retrying" | "failed"

export interface ScopeMultiselectProps {
  dimension: FleetScopeDimension
  facets: readonly FleetScopeFacet[]
  status: FleetDataStatus
  onSelectionChange: (next: readonly FleetScopeFacet[]) => boolean | void
  onRetry: () => void | Promise<void>
  icon?: ReactNode
}

export function ScopeMultiselect({
  dimension,
  facets,
  status,
  onSelectionChange,
  onRetry,
  icon,
}: ScopeMultiselectProps) {
  const copy = dimensionCopy[dimension]
  const [filter, setFilter] = useState("")
  const [retryState, setRetryState] = useState<RetryState>("idle")
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Array<HTMLInputElement | null>>([])
  const options = useMemo(
    () => decorateFacets(facets.filter((facet) => facet.dimension === dimension)),
    [dimension, facets],
  )
  const selected = options.filter((option) => option.facet.selected)
  const selectedKey = selectionKey(selected.map(({ facet }) => facet.id))
  const pendingSelection = useRef(
    new Set(selected.map(({ facet }) => facet.id)),
  )
  const issuedSelectionKeys = useRef(new Set<string>())
  const latestIssuedSelectionKey = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (latestIssuedSelectionKey.current === selectedKey) {
      pendingSelection.current = selectionFromKey(selectedKey)
      issuedSelectionKeys.current.clear()
      latestIssuedSelectionKey.current = null
      return
    }
    if (issuedSelectionKeys.current.has(selectedKey)) return

    pendingSelection.current = selectionFromKey(selectedKey)
    issuedSelectionKeys.current.clear()
    latestIssuedSelectionKey.current = null
  }, [selectedKey])
  const authorizedCount = options.filter(
    (option) => option.facet.availability === "available",
  ).length
  const selectedSummary = selectionSummary(copy.all, selected)
  const loading = status === "loading" || status === "stale"
  const failed =
    status === "error" ||
    status === "unavailable" ||
    status === "unauthorized"
  const authoritative =
    status === "ready" || status === "empty" || status === "partial"
  const resultSummary = loading
    ? "loading results"
    : failed
      ? "results unavailable"
      : formatResults(authorizedCount)
  const filtered = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!query) return options
    return options.filter(({ facet, displayLabel, technicalLabel }) =>
      `${displayLabel} ${technicalLabel ?? ""} ${facet.id}`
        .toLocaleLowerCase()
        .includes(query),
    )
  }, [filter, options])
  const filteredAuthorizedCount = filtered.filter(
    (option) => option.facet.availability === "available",
  ).length
  const visible = boundedOptions(filtered)
  const visibleAuthorizedCount = visible.filter(
    (option) => option.facet.availability === "available",
  ).length
  const filterResultSummary = loading
    ? "loading results"
    : failed
      ? "results unavailable"
      : formatResults(filteredAuthorizedCount)
  const liveStatus =
    retryState === "retrying"
      ? `Retrying ${copy.plural}…`
      : retryState === "failed"
        ? "Retry failed. Try again."
        : loading
          ? `Loading authorized ${copy.plural.toLocaleLowerCase()}…`
          : failed
            ? "Results unavailable."
            : `${formatResults(filteredAuthorizedCount)} available.`

  function emitSelection(selectedIds: Set<string>) {
    const next = options
      .filter(({ facet }) => selectedIds.has(facet.id))
      .map(({ facet }) => facet)
    const accepted = onSelectionChange(next)
    if (accepted === false) return
    pendingSelection.current = new Set(selectedIds)
    const nextKey = selectionKey(next.map((facet) => facet.id))
    issuedSelectionKeys.current.add(nextKey)
    latestIssuedSelectionKey.current = nextKey
  }

  function toggle(option: DecoratedFacet, checked: boolean) {
    const next = new Set(pendingSelection.current)
    if (checked) next.add(option.facet.id)
    else next.delete(option.facet.id)
    emitSelection(next)
  }

  function selectAllVisible() {
    const next = new Set(pendingSelection.current)
    for (const option of visible) {
      if (option.facet.availability === "available") {
        next.add(option.facet.id)
      }
    }
    emitSelection(next)
  }

  async function retryFacets() {
    setRetryState("retrying")
    try {
      await onRetry()
      setRetryState("idle")
    } catch {
      setRetryState("failed")
    }
  }

  function focusOption(index: number) {
    optionRefs.current[index]?.focus()
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && visible.length > 0) {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === "ArrowUp" && visible.length > 0) {
      event.preventDefault()
      focusOption(visible.length - 1)
    }
  }

  function handleOptionKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    option: DecoratedFacet,
    index: number,
  ) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        focusOption(Math.min(index + 1, visible.length - 1))
        break
      case "ArrowUp":
        event.preventDefault()
        focusOption(Math.max(index - 1, 0))
        break
      case "Home":
        event.preventDefault()
        focusOption(0)
        break
      case "End":
        event.preventDefault()
        focusOption(visible.length - 1)
        break
      case "Enter":
        event.preventDefault()
        toggle(option, !pendingSelection.current.has(option.facet.id))
        break
    }
  }

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) {
          setFilter("")
          setRetryState("idle")
        }
      }}
    >
      <Popover.Trigger
        type="button"
        aria-label={`${copy.plural}, ${selectedSummary}, ${resultSummary}`}
        aria-busy={loading || undefined}
        className="flex min-h-11 min-w-40 shrink-0 items-center gap-2 border-r border-border px-4 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span className="max-w-40 truncate">{selectedSummary}</span>
        {loading ? (
          <LoaderCircle
            aria-hidden="true"
            className="ml-auto size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : (
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-3.5 text-muted-foreground"
          />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          className="z-[70]"
        >
          <Popover.Popup
            role="dialog"
            aria-label={`Choose ${copy.plural}`}
            initialFocus={inputRef}
            finalFocus
            className="z-[70] w-[min(22rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-3 text-foreground shadow-xl outline-none"
          >
            <label className="relative block">
              <span className="sr-only">Filter {copy.plural}</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                ref={inputRef}
                type="search"
                value={filter}
                aria-label={`Filter ${copy.plural}, ${filterResultSummary}`}
                placeholder={`Find ${copy.plural.toLocaleLowerCase()}…`}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={handleInputKeyDown}
                className="min-h-11 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-ring"
              />
            </label>

            <div className="mt-2 flex items-center justify-between gap-2 border-b border-border pb-2">
              <button
                type="button"
                aria-label={`Select all ${visibleAuthorizedCount} visible ${copy.singular} ${visibleAuthorizedCount === 1 ? "result" : "results"}`}
                disabled={!authoritative || visibleAuthorizedCount === 0}
                onClick={selectAllVisible}
                className="min-h-11 rounded-md px-2 text-xs font-semibold text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select all visible
              </button>
              <button
                type="button"
                aria-label={`Clear ${copy.plural} selection`}
                disabled={selected.length === 0}
                onClick={() => emitSelection(new Set())}
                className="min-h-11 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
            </div>

            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={
                loading || retryState !== "idle"
                  ? "px-2 py-2 text-xs text-muted-foreground"
                  : "sr-only"
              }
            >
              {liveStatus}
            </p>
            {failed ? (
              <div
                role="alert"
                className="my-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
              >
                <p className="text-xs text-destructive">
                  {copy.plural} could not be loaded. Your current selection is
                  unchanged.
                </p>
                <button
                  type="button"
                  aria-label={`Retry loading ${copy.plural}`}
                  disabled={retryState === "retrying"}
                  onClick={() => void retryFacets()}
                  className="mt-2 min-h-11 rounded-md border border-border bg-background px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Retry
                </button>
              </div>
            ) : null}

            <fieldset className="max-h-72 overflow-y-auto overscroll-contain py-1">
              <legend className="sr-only">{copy.plural} options</legend>
              {visible.map((option, index) => (
                <label
                  key={option.facet.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-2 text-sm transition-colors hover:bg-muted focus-within:bg-muted"
                >
                  <input
                    ref={(node) => {
                      optionRefs.current[index] = node
                    }}
                    type="checkbox"
                    aria-label={optionAccessibleName(copy.plural, option)}
                    checked={option.facet.selected}
                    onChange={(event) => toggle(option, event.target.checked)}
                    onKeyDown={(event) =>
                      handleOptionKeyDown(event, option, index)
                    }
                    className="size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {option.displayLabel}
                    </span>
                    {option.technicalLabel ? (
                      <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">
                        {option.technicalLabel}
                      </span>
                    ) : null}
                    {option.facet.availability === "unavailable" ? (
                      <span className="block text-[0.625rem] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        Unavailable
                      </span>
                    ) : option.facet.availability === "unknown" ? (
                      <span className="block text-[0.625rem] text-muted-foreground">
                        Checking availability
                      </span>
                    ) : null}
                  </span>
                  {option.facet.count !== undefined ? (
                    <span
                      aria-hidden="true"
                      className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted-foreground"
                    >
                      {option.facet.count.toString()}
                    </span>
                  ) : null}
                </label>
              ))}
              {visible.length === 0 && authoritative ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  {filter
                    ? `No ${copy.plural.toLocaleLowerCase()} match your search.`
                    : `No authorized ${copy.plural.toLocaleLowerCase()}.`}
                </p>
              ) : null}
              {filtered.length > visible.length ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  Showing the first {visible.length} of {filtered.length}{" "}
                  {filtered.every(
                    (option) => option.facet.availability === "available",
                  )
                    ? "results"
                    : "options"}
                  . Refine your search to find more.
                </p>
              ) : null}
            </fieldset>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function decorateFacets(facets: readonly FleetScopeFacet[]): DecoratedFacet[] {
  const labelCounts = new Map<string, number>()
  const labelNamespaceCounts = new Map<string, number>()
  for (const facet of facets) {
    const key = facet.label.toLocaleLowerCase()
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1)
    if (facet.object) {
      const namespaceKey = `${key}:${facet.object.namespace.toLocaleLowerCase()}`
      labelNamespaceCounts.set(
        namespaceKey,
        (labelNamespaceCounts.get(namespaceKey) ?? 0) + 1,
      )
    }
  }
  return facets.map((facet) => {
    const labelKey = facet.label.toLocaleLowerCase()
    const collision =
      facet.object !== undefined && (labelCounts.get(labelKey) ?? 0) > 1
    const namespaceCollision =
      facet.object !== undefined &&
      (labelNamespaceCounts.get(
        `${labelKey}:${facet.object.namespace.toLocaleLowerCase()}`,
      ) ?? 0) > 1
    return {
      facet,
      displayLabel: collision
        ? `${facet.label} · ${namespaceCollision ? facet.id : facet.object?.namespace}`
        : facet.label,
      technicalLabel: facet.object ? facet.id : undefined,
    }
  })
}

function boundedOptions(
  filtered: readonly DecoratedFacet[],
): DecoratedFacet[] {
  const pinned = filtered.filter(
    ({ facet }) => facet.selected && facet.availability !== "available",
  )
  const pinnedIds = new Set(pinned.map(({ facet }) => facet.id))
  const ordinary = filtered.filter(({ facet }) => !pinnedIds.has(facet.id))
  return [
    ...pinned,
    ...ordinary.slice(0, Math.max(0, MAX_VISIBLE_OPTIONS - pinned.length)),
  ]
}

function selectionSummary(
  emptyLabel: string,
  selected: readonly DecoratedFacet[],
): string {
  if (selected.length === 0) return emptyLabel
  if (selected.length === 1) return selected[0].displayLabel
  return `${selected[0].displayLabel} +${selected.length - 1}`
}

function formatResults(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"}`
}

function selectionKey(ids: readonly string[]): string {
  return ids.join(SELECTION_KEY_SEPARATOR)
}

function selectionFromKey(key: string): Set<string> {
  return new Set(key ? key.split(SELECTION_KEY_SEPARATOR) : [])
}

function optionAccessibleName(
  plural: string,
  option: DecoratedFacet,
): string {
  const parts = [plural, option.facet.label]
  if (option.technicalLabel) parts.push(option.technicalLabel)
  if (option.facet.count !== undefined) {
    const count = option.facet.count
    parts.push(
      `${count.toString()} ${count === BigInt(1) ? "application" : "applications"}`,
    )
  }
  if (option.facet.availability === "unavailable") parts.push("unavailable")
  else if (option.facet.availability === "unknown") {
    parts.push("checking availability")
  }
  parts.push(option.facet.selected ? "selected" : "not selected")
  return parts.join(", ")
}
