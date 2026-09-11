"use client"

import { Code, ConnectError } from "@connectrpc/connect"
import { useQuery } from "@tanstack/react-query"
import { useRouter, useSearchParams } from "next/navigation"
import { useId, useMemo, useState } from "react"

import type { MergedResource } from "@/components/dashboard/resource-list-table"
import {
  buildJsonPatch,
  JsonPatchPane,
  SplitDiffPane,
  summarizeUnifiedDiff,
  UnifiedDiffPane,
  type DiffSummary,
  type JsonPatchOperation,
} from "@/components/dashboard/sync-diff-view"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Seg, type SegOption } from "@/components/ui/seg"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import {
  DataClass,
  DataState,
  DriftReason,
  type DriftedField,
  type GetApplicationResponse,
  type GetDataSourcesResponse,
  type GetResourceResponse,
  type IgnoreDriftedFieldResponse,
  type ListDriftDetailsResponse,
  type ResourceDriftDetail,
  type SyncResourcesResponse,
} from "@/gen/paprika/v1/api_pb"
import {
  getFleetClient,
  queryApplications,
  type FleetApplicationsPage,
} from "@/lib/fleet-client"
import {
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { useDataSourceIndex } from "@/lib/data-state"
import { STATUS_TONES, toneRank, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

export type DriftFilter = "all" | "drifted" | "missing" | "degraded" | "pruned"

/**
 * One row of the drift queue. Everything here is reported by the control
 * plane: the kind, name and sync state come from the application's resource
 * status, and `fieldCount` is absent — not zero — whenever per-resource drift
 * detail is not readable, so an unconfigured collector can never be mistaken
 * for a clean object.
 */
export interface DriftQueueItem {
  key: string
  kind: string
  name: string
  namespace: string
  syncStatus: string
  health: string
  tone: StatusTone
  toneLabel: string
  /** The line under the name. A real health message, real field paths, or the sync state. */
  reason: string
  /** Present only when the DRIFT_DETAIL data class is readable. */
  fieldCount?: number
  fieldsTruncated?: boolean
}

export const DRIFT_FILTERS: { id: DriftFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "drifted", label: "Drifted" },
  { id: "missing", label: "Missing" },
  { id: "degraded", label: "Degraded" },
  { id: "pruned", label: "Pruned" },
]

/** The queue never renders one node per fleet application; it is one application's objects, capped. */
export const DRIFT_QUEUE_LIMIT = 200

const DEGRADED_HEALTH = new Set(["Degraded", "Failed"])

export function resourceTone(syncStatus: string, health: string): StatusTone {
  if (syncStatus === "Missing") return "missing"
  if (health === "Failed") return "failed"
  if (health === "Degraded") return "degraded"
  if (syncStatus === "Pruned") return "pending"
  if (syncStatus === "OutOfSync") return "degraded"
  if (syncStatus === "Synced" && health === "Healthy") return "healthy"
  if (health === "Progressing") return "progressing"
  return "unknown"
}

export function matchesDriftFilter(item: DriftQueueItem, filter: DriftFilter): boolean {
  if (filter === "all") return true
  if (filter === "missing") return item.syncStatus === "Missing"
  if (filter === "pruned") return item.syncStatus === "Pruned"
  if (filter === "degraded") return DEGRADED_HEALTH.has(item.health)
  return item.syncStatus !== "" && item.syncStatus !== "Synced"
}

export function driftFilterCounts(
  items: readonly DriftQueueItem[],
): Record<DriftFilter, number> {
  return DRIFT_FILTERS.reduce(
    (counts, filter) => {
      counts[filter.id] = items.filter((item) => matchesDriftFilter(item, filter.id)).length
      return counts
    },
    {} as Record<DriftFilter, number>,
  )
}

/** Worst first: the object most likely to be an incident is what the eye lands on. */
export function sortDriftQueue(items: readonly DriftQueueItem[]): DriftQueueItem[] {
  return [...items].sort(
    (a, b) =>
      toneRank(a.tone) - toneRank(b.tone) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  )
}

export function driftQueueItemFromResource(resource: MergedResource): DriftQueueItem {
  const tone = resourceTone(resource.syncStatus, resource.health)
  return {
    key: `${resource.kind}/${resource.namespace}/${resource.name}`,
    kind: resource.kind,
    name: resource.name,
    namespace: resource.namespace,
    syncStatus: resource.syncStatus,
    health: resource.health,
    tone,
    toneLabel: STATUS_TONES[tone].label,
    reason: resource.healthMessage || resource.syncStatus || "No sync state reported",
  }
}

/**
 * The left rail: filter chips over a worst-first list of objects. It owns no
 * data of its own so both the workbench route and the application detail card
 * can draw the same queue from whatever they already hold.
 */
export function DriftQueue({
  items,
  filter,
  onFilterChange,
  selectedKey,
  onSelect,
  itemLabel,
  selection,
  onToggleSelection,
  emptyMessage = "This application has not published resource sync status yet.",
  className,
}: {
  items: readonly DriftQueueItem[]
  filter: DriftFilter
  onFilterChange: (filter: DriftFilter) => void
  selectedKey?: string
  onSelect: (item: DriftQueueItem) => void
  /** Overrides the accessible name of each row button. */
  itemLabel?: (item: DriftQueueItem) => string
  /** Omit to hide the per-row checkboxes entirely. */
  selection?: ReadonlySet<string>
  onToggleSelection?: (item: DriftQueueItem) => void
  emptyMessage?: string
  className?: string
}) {
  const counts = useMemo(() => driftFilterCounts(items), [items])
  const ordered = useMemo(() => sortDriftQueue(items), [items])
  const visible = useMemo(
    () => ordered.filter((item) => matchesDriftFilter(item, filter)).slice(0, DRIFT_QUEUE_LIMIT),
    [filter, ordered],
  )
  const matching = counts[filter] ?? 0

  return (
    <div className={cn("flex min-w-0 flex-col bg-card", className)}>
      <div
        role="group"
        aria-label="Filter the drift queue"
        className="flex flex-wrap gap-1.5 border-b border-rule px-3.5 py-2"
      >
        {DRIFT_FILTERS.map((chip) => {
          const active = chip.id === filter
          return (
            <button
              key={chip.id}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(chip.id)}
              className={cn(
                "inline-flex min-h-11 items-center gap-1.5 rounded-[2px] border px-2 text-note sm:min-h-0 sm:py-[3px]",
                active
                  ? "border-primary bg-selected text-steel-800"
                  : "border-rule bg-card text-neutral-700 hover:bg-inset",
              )}
            >
              {chip.label}
              <span className="font-mono text-kicker opacity-65">{counts[chip.id] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {items.length === 0 ? (
        <p className="px-3.5 py-6 text-note text-neutral-700">{emptyMessage}</p>
      ) : visible.length === 0 ? (
        <p className="px-3.5 py-6 text-note text-neutral-700">
          No objects match this filter.
        </p>
      ) : (
        <ul className="min-w-0 list-none overflow-y-auto">
          {visible.map((item) => (
            <DriftQueueRow
              key={item.key}
              item={item}
              selected={item.key === selectedKey}
              label={(itemLabel ?? defaultDriftItemLabel)(item)}
              checked={selection?.has(item.key)}
              onToggleSelection={onToggleSelection}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      {matching > visible.length ? (
        <p className="border-t border-rule px-3.5 py-2 font-mono text-meta text-neutral-700">
          {visible.length} of {matching} shown · narrow the filter to see the rest
        </p>
      ) : null}
    </div>
  )
}

/**
 * The accessible name of a queue row. Built from the same facts the row shows,
 * so a screen reader hears the object, its state, its changed-field count when
 * one exists, and the reason — in that order rather than in layout order.
 */
export function defaultDriftItemLabel(item: DriftQueueItem): string {
  const parts = [`${item.kind} ${item.name}`, item.toneLabel]
  if (item.fieldCount !== undefined) {
    parts.push(
      `${item.fieldCount}${item.fieldsTruncated ? " or more" : ""} changed ${
        item.fieldCount === 1 ? "field" : "fields"
      }`,
    )
  }
  if (item.reason) parts.push(item.reason)
  return parts.join(", ")
}

function DriftQueueRow({
  item,
  selected,
  label,
  checked,
  onToggleSelection,
  onSelect,
}: {
  item: DriftQueueItem
  selected: boolean
  label: string
  checked?: boolean
  onToggleSelection?: (item: DriftQueueItem) => void
  onSelect: (item: DriftQueueItem) => void
}) {
  return (
    <li
      className={cn(
        "flex min-w-0 items-stretch border-b border-rule-soft border-l-[3px]",
        selected ? "border-l-primary bg-selected" : "border-l-transparent bg-card",
      )}
    >
      {onToggleSelection ? (
        <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
          <span className="sr-only">
            Select {item.kind} {item.name} for sync
          </span>
          <input
            type="checkbox"
            checked={checked ?? false}
            onChange={() => onToggleSelection(item)}
            className="size-3.5 accent-primary"
          />
        </label>
      ) : null}
      <button
        type="button"
        onClick={() => onSelect(item)}
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        className="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center px-3.5 py-2 text-left hover:bg-inset"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusGlyph tone={item.tone} label={item.toneLabel} />
          <span className="font-mono text-meta tracking-[0.06em] text-neutral-600 uppercase">
            {item.kind}
          </span>
          <span className="flex-1" />
          {item.fieldCount === undefined ? null : (
            <span aria-hidden className="font-mono text-meta text-neutral-600">
              {item.fieldCount}
              {item.fieldsTruncated ? "+" : ""}
            </span>
          )}
        </span>
        <span className="mt-0.5 truncate font-cond text-label font-semibold tracking-[0.02em]">
          {item.name}
        </span>
        <span className="truncate text-note text-neutral-700">{item.reason}</span>
      </button>
    </li>
  )
}

type DiffMode = "unified" | "split" | "patch"

interface IgnoreFieldRequest {
  namespace: string
  name: string
  group: string
  kind: string
  resourceName: string
  resourceNamespace: string
  jsonPointers: string[]
  reason: string
}

interface SyncResourcesRequestShape {
  namespace: string
  name: string
  resources: {
    group: string
    version: string
    kind: string
    name: string
    namespace: string
  }[]
  confirm: boolean
  reason: string
}

export interface SyncDiffWorkbenchClient {
  getDataSources: () => Promise<GetDataSourcesResponse>
  queryApplications: (state: FleetQueryState) => Promise<FleetApplicationsPage>
  getApplication: (request: {
    namespace: string
    name: string
  }) => Promise<GetApplicationResponse>
  listDriftDetails: (request: {
    namespace: string
    application: string
    includeFields: boolean
    pageSize: number
  }) => Promise<ListDriftDetailsResponse>
  getResource: (request: {
    applicationNamespace: string
    applicationName: string
    resourceKind: string
    resourceName: string
    resourceNamespace: string
  }) => Promise<GetResourceResponse>
  ignoreDriftedField: (request: IgnoreFieldRequest) => Promise<IgnoreDriftedFieldResponse>
  syncResources: (request: SyncResourcesRequestShape) => Promise<SyncResourcesResponse>
}

const defaultClient: SyncDiffWorkbenchClient = {
  getDataSources: () => getFleetClient().getDataSources({}),
  queryApplications: (state) => queryApplications(state),
  getApplication: (request) => getFleetClient().getApplication(request),
  listDriftDetails: (request) => getFleetClient().listDriftDetails(request),
  getResource: (request) => getFleetClient().getResource(request),
  ignoreDriftedField: (request) => getFleetClient().ignoreDriftedField(request),
  syncResources: (request) => getFleetClient().syncResources(request),
}

/** Enough drift detail to fill one page of the queue; the server caps the page anyway. */
const DRIFT_DETAIL_PAGE_SIZE = 100
const APPLICATION_OPTION_LIMIT = 100
const EMPTY_SELECTION: ReadonlySet<string> = new Set()

export function SyncDiffWorkbench({
  client = defaultClient,
}: {
  client?: SyncDiffWorkbenchClient
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const raw = searchParams.toString()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""
  const applicationKey = namespace && name ? `${namespace}/${name}` : ""

  const scope = useMemo<FleetQueryState>(
    () => ({ ...parseFleetQuery(raw).state, sync: ["out_of_sync"] }),
    [raw],
  )

  const [filter, setFilter] = useState<DriftFilter>("all")
  const [selectedKey, setSelectedKey] = useState("")
  const [mode, setMode] = useState<DiffMode>("unified")
  const [checked, setChecked] = useState<ReadonlySet<string>>(EMPTY_SELECTION)
  const [outcome, setOutcome] = useState<{ tone: "note" | "refused"; message: string } | null>(null)

  // The console-wide capability probe: one query, one cache entry, shared with
  // every other view rather than refetched per route.
  const dataSources = useDataSourceIndex(client)

  const driftDetailSource = dataSources.reading(DataClass.DRIFT_DETAIL)
  const driftDetailState = driftDetailSource?.state ?? DataState.UNSPECIFIED
  // Only OK and STALE carry numbers. Everything else must not produce a count,
  // a patch, or an explanation, so the RPC behind them is not even called.
  const driftDetailReadable =
    driftDetailState === DataState.OK || driftDetailState === DataState.STALE

  // Keyed on the scope, not the raw query string: changing which object is
  // selected must not refetch the application list.
  const scopeKey = useMemo(() => serializeFleetQuery(scope).toString(), [scope])
  const applications = useQuery({
    queryKey: ["diff", "applications", scopeKey],
    queryFn: () => client.queryApplications(scope),
  })

  usePublishConsoleScope({
    facets: applications.data?.facets,
    indexGeneration: applications.data?.indexGeneration,
    refreshedAt: applications.dataUpdatedAt || undefined,
    isRefreshing: applications.isFetching,
  })

  const application = useQuery({
    queryKey: ["diff", "application", namespace, name],
    queryFn: () => client.getApplication({ namespace, name }),
    enabled: applicationKey !== "",
  })

  const driftDetails = useQuery({
    queryKey: ["diff", "drift-details", namespace, name],
    queryFn: () =>
      client.listDriftDetails({
        namespace,
        application: name,
        includeFields: true,
        pageSize: DRIFT_DETAIL_PAGE_SIZE,
      }),
    enabled: applicationKey !== "" && driftDetailReadable,
  })

  // The response can still downgrade what the probe promised.
  const detailsUsable =
    driftDetailReadable &&
    (driftDetails.data?.state === DataState.OK ||
      driftDetails.data?.state === DataState.STALE)

  const detailByKey = useMemo(() => {
    if (!detailsUsable) return new Map<string, ResourceDriftDetail>()
    const entries = new Map<string, ResourceDriftDetail>()
    for (const detail of driftDetails.data?.resources ?? []) {
      if (
        detail.detailState !== DataState.OK &&
        detail.detailState !== DataState.STALE
      ) {
        continue
      }
      entries.set(`${detail.kind}/${detail.namespace}/${detail.name}`, detail)
    }
    return entries
  }, [detailsUsable, driftDetails.data])

  const items = useMemo<DriftQueueItem[]>(() => {
    const record = application.data?.application
    if (!record) return []
    const health = new Map(
      record.resourceHealth.map((entry) => [
        `${entry.kind}/${entry.name}`,
        { health: entry.health, message: entry.message },
      ]),
    )
    return record.resources.map((resource) => {
      const observed = health.get(`${resource.kind}/${resource.name}`)
      const base = driftQueueItemFromResource({
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
        syncStatus: resource.status,
        health: observed?.health ?? "Unknown",
        healthMessage: observed?.message ?? "",
      })
      const detail = detailByKey.get(base.key)
      if (!detail) return base
      return {
        ...base,
        reason: driftReasonText(detail) || base.reason,
        fieldCount: detail.changedFieldCount,
        fieldsTruncated: detail.fieldsTruncated,
      }
    })
  }, [application.data, detailByKey])

  const selected = useMemo(
    () => items.find((item) => item.key === selectedKey),
    [items, selectedKey],
  )
  const selectedDetail = selected ? detailByKey.get(selected.key) : undefined

  // A new application means a new queue, so the previous selection is
  // meaningless. Reset during render rather than in an effect: an effect would
  // let one frame paint the old selection against the new application.
  const [queueKey, setQueueKey] = useState(applicationKey)
  if (queueKey !== applicationKey) {
    setQueueKey(applicationKey)
    setSelectedKey("")
    setChecked(EMPTY_SELECTION)
    setOutcome(null)
  }

  const resource = useQuery({
    queryKey: [
      "diff",
      "resource",
      namespace,
      name,
      selected?.kind ?? "",
      selected?.namespace ?? "",
      selected?.name ?? "",
    ],
    queryFn: () =>
      client.getResource({
        applicationNamespace: namespace,
        applicationName: name,
        resourceKind: selected?.kind ?? "",
        resourceName: selected?.name ?? "",
        resourceNamespace: selected?.namespace ?? "",
      }),
    enabled: applicationKey !== "" && selected !== undefined,
  })

  const diff = resource.data?.diff ?? ""
  const summary = useMemo(() => summarizeUnifiedDiff(diff), [diff])
  const patchOperations = useMemo(
    () => (selectedDetail ? buildJsonPatch(selectedDetail.fields) : []),
    [selectedDetail],
  )
  const patchAvailable = selectedDetail !== undefined && patchOperations.length > 0
  const effectiveMode: DiffMode = mode === "patch" && !patchAvailable ? "unified" : mode

  const modeOptions = useMemo<SegOption<DiffMode>[]>(() => {
    const options: SegOption<DiffMode>[] = [
      { value: "unified", label: "Unified" },
      { value: "split", label: "Split" },
    ]
    // No drift detail means no JSON pointers, so there is no patch to render
    // and the control that would show one does not exist.
    if (patchAvailable) options.push({ value: "patch", label: "JSON patch" })
    return options
  }, [patchAvailable])

  const runIgnore = async (pointer: string) => {
    if (!selected || !selectedDetail) return
    setOutcome(null)
    try {
      await client.ignoreDriftedField({
        namespace,
        name,
        group: selectedDetail.group,
        kind: selected.kind,
        resourceName: selected.name,
        resourceNamespace: selected.namespace,
        jsonPointers: [pointer],
        reason: "Ignored from the sync and diff workbench",
      })
      setOutcome({ tone: "note", message: `Ignore rule recorded for ${pointer}.` })
    } catch (error) {
      setOutcome(refusal("Ignoring a drifted field", error))
    }
  }

  const runSync = async () => {
    const selectors = items
      .filter((item) => checked.has(item.key))
      .map((item) => ({
        group: detailByKey.get(item.key)?.group ?? "",
        version: detailByKey.get(item.key)?.version ?? "",
        kind: item.kind,
        name: item.name,
        namespace: item.namespace,
      }))
    if (selectors.length === 0) return
    setOutcome(null)
    try {
      const response = await client.syncResources({
        namespace,
        name,
        resources: selectors,
        confirm: true,
        reason: "Selective sync from the sync and diff workbench",
      })
      setOutcome({
        tone: response.accepted ? "note" : "refused",
        message: response.accepted
          ? `Sync accepted for ${response.selectedCount} of ${selectors.length} selected objects.`
          : "The control plane did not accept the sync; no change was made.",
      })
    } catch (error) {
      setOutcome(refusal("Selective sync", error))
    }
  }

  const checkedCount = items.filter((item) => checked.has(item.key)).length

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule bg-card px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
            Drift control
          </p>
          <h1
            className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]"
          >
            Sync &amp; diff workbench
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={checkedCount === 0}
            onClick={runSync}
            className={cn(
              "inline-flex h-11 items-center border border-primary bg-primary px-3 font-cond text-label font-semibold text-primary-foreground sm:h-7.5",
              "hover:bg-steel-600 active:bg-steel-700",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
          >
            {checkedCount === 0 ? "Sync selected" : `Sync ${checkedCount} selected`}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-card px-5 py-2">
        <ApplicationPicker
          applications={applications.data}
          current={applicationKey}
          isLoading={applications.isLoading}
          onChange={(next) => {
            const params = new URLSearchParams(raw)
            if (next === "") {
              params.delete("namespace")
              params.delete("name")
            } else {
              const [nextNamespace, ...rest] = next.split("/")
              params.set("namespace", nextNamespace)
              params.set("name", rest.join("/"))
            }
            const query = params.toString()
            router.replace(query ? `/dashboard/diff/?${query}` : "/dashboard/diff/", {
              scroll: false,
            })
          }}
        />
        {applications.data ? (
          <p className="font-mono text-meta text-neutral-700">
            {Math.min(applications.data.applications.length, APPLICATION_OPTION_LIMIT)} listed /{" "}
            {applications.data.total.toString()} drifted
          </p>
        ) : null}
      </div>

      {/* Always present, so a screen reader is already watching it when a
          mutation answers. A region that appears with its own message is
          announced unreliably. */}
      <div role="status">
        {outcome ? (
          <p
            className={cn(
              "border-b px-5 py-2 text-note",
              outcome.tone === "refused"
                ? "border-status-failed-line bg-status-failed-fill text-status-failed-text"
                : "border-rule bg-inset text-neutral-800",
            )}
          >
            {outcome.message}
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 items-stretch lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section
          aria-label="Drift queue"
          className="min-w-0 border-b border-rule lg:border-r lg:border-b-0"
        >
          {applicationKey === "" ? (
            <p className="px-3.5 py-6 text-note text-neutral-700">
              Choose an application to load its drift queue.
            </p>
          ) : application.isLoading ? (
            <p role="status" className="px-3.5 py-6 text-note text-neutral-700">
              Loading the drift queue…
            </p>
          ) : application.isError ? (
            <p role="status" className="px-3.5 py-6 text-note text-status-failed-text">
              The drift queue could not be loaded for {applicationKey}.
            </p>
          ) : (
            <DriftQueue
              items={items}
              filter={filter}
              onFilterChange={setFilter}
              selectedKey={selectedKey}
              onSelect={(item) => setSelectedKey(item.key)}
              selection={checked}
              onToggleSelection={(item) =>
                setChecked((previous) => {
                  const next = new Set(previous)
                  if (next.has(item.key)) next.delete(item.key)
                  else next.add(item.key)
                  return next
                })
              }
            />
          )}
        </section>

        <ResourceDiffPane
          selected={selected}
          diff={diff}
          summary={summary}
          isLoading={resource.isLoading}
          isError={resource.isError}
          apiVersion={resource.data?.apiVersion ?? ""}
          mode={effectiveMode}
          modeOptions={modeOptions}
          onModeChange={setMode}
          patchOperations={patchOperations}
          drift={{
            state: driftDetailState,
            responseState: driftDetails.data?.state,
            reason: driftDetailSource?.unavailableReason ?? "",
            detail: selectedDetail,
            evaluatedAtUnixMs: driftDetails.data?.evaluatedAtUnixMs,
          }}
          emptyMessage={
            applicationKey === ""
              ? "No application selected."
              : "Select an object in the drift queue to see its diff."
          }
          onIgnore={runIgnore}
        />
      </div>
    </div>
  )
}

/**
 * The right pane: what the selected object looks like now against what the
 * rendered manifest declares, in whichever of the three readings the operator
 * asked for.
 */
function ResourceDiffPane({
  selected,
  diff,
  summary,
  isLoading,
  isError,
  apiVersion,
  mode,
  modeOptions,
  onModeChange,
  patchOperations,
  drift,
  emptyMessage,
  onIgnore,
}: {
  selected: DriftQueueItem | undefined
  diff: string
  summary: DiffSummary
  isLoading: boolean
  isError: boolean
  apiVersion: string
  mode: DiffMode
  modeOptions: readonly SegOption<DiffMode>[]
  onModeChange: (mode: DiffMode) => void
  patchOperations: readonly JsonPatchOperation[]
  drift: {
    state: DataState
    responseState?: DataState
    reason: string
    detail?: ResourceDriftDetail
    evaluatedAtUnixMs?: bigint
  }
  emptyMessage: string
  onIgnore: (pointer: string) => void
}) {
  const headingId = useId()

  if (!selected) {
    return (
      <section aria-label="Resource diff" className="min-w-0 bg-background">
        <p className="px-5 py-6 text-note text-neutral-700">{emptyMessage}</p>
      </section>
    )
  }

  const caption = apiVersion
    ? `${apiVersion} ${selected.kind} · ${resourceScope(selected)}`
    : `${selected.kind} · ${resourceScope(selected)}`

  return (
    <section aria-label="Resource diff" className="flex min-w-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-card px-5 py-2.5">
        <div className="min-w-0">
          <p className="font-mono text-meta tracking-[0.1em] text-neutral-600 uppercase">
            {selected.kind} · {selected.namespace || "cluster-scoped"}
          </p>
          <h2
            id={headingId}
            className="mt-px truncate font-cond text-stat font-semibold tracking-[0.02em]"
          >
            {selected.name}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill tone={selected.tone} label={selected.toneLabel} />
          <p className="font-mono text-meta text-neutral-700">
            {selected.fieldCount === undefined
              ? null
              : `${selected.fieldCount}${selected.fieldsTruncated ? "+" : ""} changed ${
                  selected.fieldCount === 1 ? "field" : "fields"
                } · `}
            {countLabel(summary.additions, "addition")} ·{" "}
            {countLabel(summary.deletions, "removal")}
          </p>
          <Seg
            label="Diff format"
            options={modeOptions}
            value={mode}
            onValueChange={onModeChange}
          />
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto px-5 py-4 pb-7">
        {isLoading ? (
          <p role="status" className="text-note text-neutral-700">
            Loading the manifest diff…
          </p>
        ) : isError ? (
          <p role="status" className="text-note text-status-failed-text">
            The diff could not be loaded for this object.
          </p>
        ) : mode === "patch" ? (
          <JsonPatchPane
            operations={patchOperations}
            labelledBy={headingId}
            caption={`${patchOperations.length} replace ${
              patchOperations.length === 1 ? "operation" : "operations"
            } derived from the reported drifted fields`}
          />
        ) : mode === "split" ? (
          <SplitDiffPane diff={diff} labelledBy={headingId} caption={caption} />
        ) : (
          <UnifiedDiffPane diff={diff} labelledBy={headingId} caption={caption} />
        )}

        <WhyThisDrifted
          state={drift.state}
          responseState={drift.responseState}
          reason={drift.reason}
          detail={drift.detail}
          evaluatedAtUnixMs={drift.evaluatedAtUnixMs}
          onIgnore={onIgnore}
        />
      </div>
    </section>
  )
}

function resourceScope(selected: DriftQueueItem): string {
  return selected.namespace ? `${selected.namespace}/${selected.name}` : selected.name
}

function ApplicationPicker({
  applications,
  current,
  isLoading,
  onChange,
}: {
  applications: FleetApplicationsPage | undefined
  current: string
  isLoading: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  const options = useMemo(() => {
    const listed = (applications?.applications ?? [])
      .slice(0, APPLICATION_OPTION_LIMIT)
      .flatMap((summary) =>
        summary.identity
          ? [
              {
                value: `${summary.identity.namespace}/${summary.identity.name}`,
                // driftCount is a real figure from the fleet index; the
                // fallback entry below has none, so it shows none.
                label: `${summary.identity.namespace}/${summary.identity.name} · ${summary.driftCount} drifted`,
              },
            ]
          : [],
      )
    if (current !== "" && !listed.some((option) => option.value === current)) {
      listed.unshift({ value: current, label: current })
    }
    return listed
  }, [applications, current])

  return (
    <span className="flex items-center gap-2">
      <label
        htmlFor={id}
        className="font-mono text-kicker tracking-[0.12em] text-neutral-600 uppercase"
      >
        Application
      </label>
      <select
        id={id}
        value={current}
        disabled={isLoading}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 min-w-56 border border-rule bg-card px-2 font-cond text-label font-semibold tracking-[0.02em] sm:h-7.5"
      >
        <option value="">
          {isLoading ? "Loading applications…" : "Choose an application"}
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

/**
 * The design's best original idea, and the one part of it the API can
 * substantiate: `managedFields` records which controller last wrote the live
 * object. It is drawn only when the drift-detail class is readable — an
 * unconfigured collector produces no panel at all rather than a panel with
 * blanks in it.
 */
function WhyThisDrifted({
  state,
  responseState,
  reason,
  detail,
  evaluatedAtUnixMs,
  onIgnore,
}: {
  state: DataState
  responseState?: DataState
  reason: string
  detail?: ResourceDriftDetail
  evaluatedAtUnixMs?: bigint
  onIgnore: (pointer: string) => void
}) {
  const headingId = useId()

  // NOT_CONFIGURED and FORBIDDEN are absences the console must not narrate:
  // one has nothing to say, the other must not hint that there is something.
  if (state === DataState.NOT_CONFIGURED || state === DataState.FORBIDDEN) return null
  if (state === DataState.UNSPECIFIED) return null

  if (state === DataState.NOT_AVAILABLE || state === DataState.ERROR) {
    return (
      <section
        aria-labelledby={headingId}
        className="mt-3.5 border border-rule bg-inset px-3.5 py-3 text-neutral-700"
      >
        <h3
          id={headingId}
          className="font-cond text-label font-semibold tracking-[0.06em] uppercase"
        >
          Why this drifted
        </h3>
        <p className="mt-1.5 text-chip leading-relaxed">
          {reason || "Per-resource drift detail is unavailable on this control plane."}
        </p>
      </section>
    )
  }

  if (!detail) return null

  const stale =
    state === DataState.STALE ||
    responseState === DataState.STALE ||
    detail.detailState === DataState.STALE
  const fields = detail.fields
  const shown = fields.length

  return (
    <section
      aria-labelledby={headingId}
      className="mt-3.5 border border-rule bg-card px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={headingId}
          className="font-cond text-label font-semibold tracking-[0.06em] uppercase"
        >
          Why this drifted
        </h3>
        {stale ? (
          <StatusPill
            tone="unknown"
            label={`Stale${
              evaluatedAtUnixMs !== undefined && Number(evaluatedAtUnixMs) > 0
                ? ` · evaluated ${formatAgo(Number(evaluatedAtUnixMs))}`
                : ""
            }`}
          />
        ) : null}
      </div>

      <p className="mt-1.5 text-chip leading-relaxed text-neutral-800">
        {detail.lastAppliedBy ? (
          <>
            The live object was last written by{" "}
            <span className="font-mono text-note">{detail.lastAppliedBy}</span>
            {Number(detail.lastAppliedAtUnixMs) > 0
              ? ` ${formatAgo(Number(detail.lastAppliedAtUnixMs))}`
              : ""}
            .{" "}
          </>
        ) : (
          <>Kubernetes recorded no field manager for the live object, so the last writer is unknown. </>
        )}
        {driftReasonSentence(detail.reason)}{" "}
        {detail.changedFieldCount > 0
          ? `${detail.changedFieldCount} ${
              detail.changedFieldCount === 1 ? "field differs" : "fields differ"
            } from the rendered manifest.`
          : ""}
      </p>

      {shown > 0 ? (
        <ul className="mt-2 list-none border-t border-rule-faint">
          {fields.map((field) => (
            <li
              key={field.path}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule-faint py-1.5"
            >
              <span className="font-mono text-note text-foreground">{field.path}</span>
              <span className="font-mono text-note text-diff-del-text">{field.live || "—"}</span>
              <span aria-hidden className="text-note text-neutral-600">
                →
              </span>
              <span className="font-mono text-note text-diff-add-text">
                {field.desired || "—"}
              </span>
              {field.ignored ? (
                <span className="font-mono text-meta text-neutral-600">ignored</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onIgnore(field.path)}
                  className="ml-auto inline-flex h-11 items-center border border-rule bg-card px-2 font-cond text-note font-semibold hover:bg-inset sm:h-6"
                >
                  Ignore {field.path}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {detail.fieldsTruncated ? (
        <p className="mt-2 font-mono text-meta text-neutral-700">
          Showing {shown} of {detail.changedFieldCount} changed fields; the server caps the list.
        </p>
      ) : null}
    </section>
  )
}

/** The queue's one-line reason, built only from paths the server reported. */
function driftReasonText(detail: ResourceDriftDetail): string {
  const paths = detail.fields
    .map((field: DriftedField) => field.path)
    .filter((path) => path !== "")
  if (paths.length === 0) return driftReasonSentence(detail.reason)
  const head = paths.slice(0, 3).join(", ")
  const rest = detail.changedFieldCount - Math.min(paths.length, 3)
  return rest > 0 ? `${head} +${rest} more` : head
}

function driftReasonSentence(reason: DriftReason): string {
  switch (reason) {
    case DriftReason.FIELD_CHANGED:
      return "The control plane classified this as a changed field."
    case DriftReason.RESOURCE_MISSING:
      return "The object is declared but absent from the cluster."
    case DriftReason.RESOURCE_UNMANAGED:
      return "The object exists in the cluster but is not managed here."
    case DriftReason.PRUNE_PENDING:
      return "The object is queued for pruning."
    case DriftReason.IGNORED:
      return "An ignore rule already covers this drift."
    default:
      return "The control plane did not classify this drift."
  }
}

function refusal(action: string, error: unknown): { tone: "refused"; message: string } {
  const connect = ConnectError.from(error)
  if (connect.code === Code.Unimplemented) {
    return {
      tone: "refused",
      message: `${action} is not implemented on this control plane; no change was made.`,
    }
  }
  if (connect.code === Code.PermissionDenied) {
    return { tone: "refused", message: `${action} was refused: you are not permitted to do this.` }
  }
  return { tone: "refused", message: `${action} failed; no change was made.` }
}

function countLabel(value: number, word: string): string {
  return `${value} ${word}${value === 1 ? "" : "s"}`
}

function formatAgo(unixMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
