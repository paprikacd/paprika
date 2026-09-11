"use client"

import { createPromiseClient } from "@connectrpc/connect"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useCallback, useMemo, useRef, useState } from "react"

import { ApplicationReleaseHistory } from "@/components/dashboard/application-release-history"
import { InvestigationTriage } from "@/components/dashboard/investigation-triage"
import {
  ResourceDetailPanel,
  type InspectedResource,
} from "@/components/dashboard/resource-detail-panel"
import {
  ResourceGraph,
  type ResourceGraphNode,
} from "@/components/dashboard/resource-graph"
import {
  ResourceTree,
  collapsibleIds,
  mergeResourcesFromApplication,
  resourceKey,
  type FlatTreeNode,
} from "@/components/dashboard/resource-list-table"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { Seg } from "@/components/ui/seg"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  DataClass,
  DataState,
  LifecyclePhase,
  LifecyclePhaseState,
  type Application,
  type CommitInfo,
  type DataSourceStatus,
  type DrilldownLink,
  type LifecyclePhaseStatus,
  type Ownership,
  type Release,
} from "@/gen/paprika/v1/api_pb"
import { useConnection } from "@/lib/connection-context"
import { FOCUSED_REFRESH_INTERVAL_MS, useFocusedRefresh } from "@/lib/fleet-refresh"
import { STATUS_TONES, worstTone, type StatusTone } from "@/lib/status-tone"
import { createTransport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

/* ── DataState gating ──────────────────────────────────────────────────
   §4 of the backend design is normative: a data class that is not
   configured has no surface at all, and only STALE carries numbers among
   the non-OK states. `gateFor` is the single place that decision is made.
   ──────────────────────────────────────────────────────────────────── */

export interface SurfaceGate {
  /** False means the surface must not be drawn at all. */
  visible: boolean
  /** True means draw the frame and the reason, and no figures. */
  degraded: boolean
  stale: boolean
  reason: string
  observedAtMs: number
}

const HIDDEN_GATE: SurfaceGate = {
  visible: false,
  degraded: false,
  stale: false,
  reason: "",
  observedAtMs: 0,
}

export function gateFor(
  sources: readonly DataSourceStatus[] | undefined,
  dataClass: DataClass
): SurfaceGate {
  // No capability probe means no licence to draw anything that depends on
  // one. Silence beats a plausible fabrication.
  if (!sources) return HIDDEN_GATE
  const status = sources.find((s) => s.dataClass === dataClass)
  if (!status) return HIDDEN_GATE
  switch (status.state) {
    case DataState.OK:
      return {
        visible: true,
        degraded: false,
        stale: false,
        reason: "",
        observedAtMs: Number(status.observedAtUnixMs),
      }
    case DataState.STALE:
      return {
        visible: true,
        degraded: false,
        stale: true,
        reason: status.unavailableReason,
        observedAtMs: Number(status.observedAtUnixMs),
      }
    case DataState.NOT_AVAILABLE:
    case DataState.ERROR:
      return {
        visible: true,
        degraded: true,
        stale: false,
        reason: status.unavailableReason || "This source is not answering.",
        observedAtMs: Number(status.observedAtUnixMs),
      }
    // NOT_CONFIGURED, FORBIDDEN and UNSPECIFIED all mean "do not draw".
    default:
      return HIDDEN_GATE
  }
}

/** A `CommitInfo` carries its own state; the same rules apply to it. */
function commitIsUsable(commit: CommitInfo | undefined): commit is CommitInfo {
  if (!commit) return false
  return commit.state === DataState.OK || commit.state === DataState.STALE
}

/* ── Formatting ────────────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

function formatAge(unixMs: number, now = Date.now()): string {
  if (!unixMs) return ""
  const delta = Math.max(0, now - unixMs)
  if (delta < 60_000) return "just now"
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatSeconds(ts?: bigint): string {
  if (ts === undefined || ts === null) return ""
  const seconds = Number(ts)
  if (!seconds) return ""
  return new Date(seconds * 1000).toLocaleString()
}

/* ── Tones for the application's own strings ───────────────────────── */

function phaseTone(phase: string | undefined): StatusTone {
  switch ((phase ?? "").trim().toLowerCase()) {
    case "healthy":
    case "succeeded":
    case "synced":
    case "ready":
      return "healthy"
    case "progressing":
    case "running":
    case "syncing":
      return "progressing"
    case "degraded":
    case "suspended":
      return "degraded"
    case "failed":
    case "error":
      return "failed"
    case "missing":
      return "missing"
    case "pending":
    case "awaitingapproval":
      return "pending"
    default:
      return "unknown"
  }
}

const LIFECYCLE_LABELS: Record<number, string> = {
  [LifecyclePhase.SOURCE]: "Source",
  [LifecyclePhase.BUILD]: "Build",
  [LifecyclePhase.TEST]: "Test",
  [LifecyclePhase.RENDER]: "Render",
  [LifecyclePhase.DEPLOY]: "Deploy",
  [LifecyclePhase.VERIFY]: "Verify",
}

function lifecycleTone(state: LifecyclePhaseState): StatusTone {
  switch (state) {
    case LifecyclePhaseState.SUCCEEDED:
      return "healthy"
    case LifecyclePhaseState.RUNNING:
      return "progressing"
    case LifecyclePhaseState.BLOCKED:
      return "degraded"
    case LifecyclePhaseState.FAILED:
      return "failed"
    case LifecyclePhaseState.PENDING:
    case LifecyclePhaseState.NOT_APPLICABLE:
      return "pending"
    default:
      return "unknown"
  }
}

function lifecycleStateLabel(state: LifecyclePhaseState): string {
  switch (state) {
    case LifecyclePhaseState.NOT_APPLICABLE:
      return "Not applicable"
    case LifecyclePhaseState.PENDING:
      return "Pending"
    case LifecyclePhaseState.RUNNING:
      return "Running"
    case LifecyclePhaseState.BLOCKED:
      return "Blocked"
    case LifecyclePhaseState.SUCCEEDED:
      return "Succeeded"
    case LifecyclePhaseState.FAILED:
      return "Failed"
    default:
      return "Unknown"
  }
}

const TIER_LABELS: Record<number, string> = { 1: "1", 2: "2", 3: "3", 4: "4" }

/* ── Sub-tabs ──────────────────────────────────────────────────────── */

const SUB_TABS = [
  { id: "overview", label: "Overview" },
  { id: "resources", label: "Resources" },
  { id: "releases", label: "Releases" },
  { id: "pipelines", label: "Pipelines" },
  { id: "policy", label: "Policy" },
  { id: "manifest", label: "Manifest" },
] as const

type SubTab = (typeof SUB_TABS)[number]["id"]

type ResourceView = "graph" | "tree"

interface DetailData {
  application: Application | null
  releases: Release[]
  tree: FlatTreeNode[]
  sources: DataSourceStatus[] | undefined
  ownership: Ownership | undefined
  lifecycle: LifecyclePhaseStatus[] | undefined
  lifecycleObservedAtMs: number
  commit: CommitInfo | undefined
}

const EMPTY_DATA: DetailData = {
  application: null,
  releases: [],
  tree: [],
  sources: undefined,
  ownership: undefined,
  lifecycle: undefined,
  lifecycleObservedAtMs: 0,
  commit: undefined,
}

function ApplicationDetail() {
  const searchParams = useSearchParams()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""

  const [data, setData] = useState<DetailData>(EMPTY_DATA)
  const [indexGeneration, setIndexGeneration] = useState<bigint | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [tab, setTab] = useState<SubTab>("overview")
  const [resourceView, setResourceView] = useState<ResourceView>("graph")
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<InspectedResource | null>(null)
  const { reportRequestOutcome } = useConnection()
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const fetchData = useCallback(async () => {
    if (!namespace || !name) return
    setLoading(true)
    setError(null)
    try {
      // Round one: the application itself, plus the capability probe that
      // decides which of the state-carrying boards may exist at all.
      const [appRes, relRes, treeRes, sourcesRes] = await Promise.all([
        client.getApplication({ namespace, name }),
        client.listReleases({ namespace, applicationName: name }),
        client
          .getResourceTreeDetailed({
            applicationNamespace: namespace,
            applicationName: name,
          })
          .catch(() => ({ nodes: [] })),
        client.getDataSources({ namespace }).catch(() => undefined),
      ])

      const sources = sourcesRes?.sources
      const ownershipGate = gateFor(sources, DataClass.OWNERSHIP)
      const lifecycleGate = gateFor(sources, DataClass.LIFECYCLE)
      const commitGate = gateFor(sources, DataClass.COMMIT_METADATA)

      // Round two: only the classes the probe says are worth asking for.
      const [ownershipRes, lifecycleRes, revisionRes] = await Promise.all([
        ownershipGate.visible && !ownershipGate.degraded
          ? client.getApplicationOwnership({ namespace, name }).catch(() => undefined)
          : Promise.resolve(undefined),
        lifecycleGate.visible && !lifecycleGate.degraded
          ? client.getApplicationLifecycle({ namespace, name }).catch(() => undefined)
          : Promise.resolve(undefined),
        commitGate.visible && !commitGate.degraded
          ? client
              .getRevisionInfo({ namespace, application: name, revision: "" })
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ])

      setData({
        application: appRes.application ?? null,
        releases: relRes.releases ?? [],
        tree: (treeRes.nodes ?? []) as unknown as FlatTreeNode[],
        sources,
        ownership: ownershipRes?.ownership,
        lifecycle: lifecycleRes?.lifecycle?.phases,
        lifecycleObservedAtMs: Number(lifecycleRes?.lifecycle?.observedAtUnixMs ?? 0),
        commit: revisionRes?.commit,
      })
      setIndexGeneration(sourcesRes?.indexGeneration)
      setRefreshedAt(Date.now())
    } catch (err) {
      setError("Could not load this application.")
      console.error(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [namespace, name])

  useFocusedRefresh(fetchData, {
    enabled: Boolean(namespace && name),
    onRequestOutcome: reportRequestOutcome,
  })

  usePublishConsoleScope({
    indexGeneration,
    refreshedAt,
    isRefreshing: loading,
    intervalMs: FOCUSED_REFRESH_INTERVAL_MS,
  })

  const { application, releases, tree, sources, ownership, lifecycle, commit } = data

  const ownershipGate = useMemo(
    () => gateFor(sources, DataClass.OWNERSHIP),
    [sources]
  )
  const lifecycleGate = useMemo(
    () => gateFor(sources, DataClass.LIFECYCLE),
    [sources]
  )

  const appReleases = useMemo(
    () =>
      releases
        .filter((r) => r.application === name && r.namespace === namespace)
        .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)),
    [releases, namespace, name]
  )

  const currentRelease = useMemo(() => {
    if (!application?.releaseRef) return null
    return (
      appReleases.find(
        (r) => r.name === application.releaseRef && r.namespace === application.namespace
      ) ?? null
    )
  }, [application, appReleases])

  // The tree RPC is the authority. Only when it returns nothing do we fall
  // back to the flat resource list carried on the Application itself.
  const treeNodes = useMemo<FlatTreeNode[]>(() => {
    if (tree.length > 0) return tree
    if (!application) return []
    return mergeResourcesFromApplication(application).map((r) => ({
      ...r,
      parentKind: "",
      parentName: "",
      managed: true,
    }))
  }, [tree, application])

  const graphNodes = useMemo<ResourceGraphNode[]>(
    () =>
      treeNodes.map((n) => ({
        kind: n.kind,
        name: n.name,
        namespace: n.namespace,
        syncStatus: n.syncStatus ?? "",
        health: n.health ?? "",
        healthMessage: n.healthMessage ?? "",
        parentKind: n.parentKind ?? "",
        parentName: n.parentName ?? "",
        uid: "",
        managed: n.managed ?? true,
        ready: n.ready,
        total: n.total,
      })),
    [treeNodes]
  )

  const driftedCount = application?.outOfSync ?? 0
  const selectedId = selected ? resourceKey(selected) : null

  const runAction = useCallback(
    async (key: string, label: string, run: () => Promise<unknown>) => {
      setBusyAction(key)
      setNotice("")
      try {
        await run()
        setNotice(`${label} accepted.`)
      } catch (err) {
        console.error(err)
        setNotice(`${label} failed.`)
        setBusyAction(null)
        return
      }
      // A refresh that fails is a refresh problem, not an action problem —
      // the poll's own backoff will report it.
      await fetchData().catch(() => {})
      setBusyAction(null)
    },
    [fetchData]
  )

  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = SUB_TABS.length - 1
    let next = -1
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = last
    if (next === -1) return
    event.preventDefault()
    setTab(SUB_TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  if (!namespace || !name) {
    return (
      <p className="px-5 py-12 text-center text-chip text-muted-foreground">
        This page needs a namespace and a name in the address.
      </p>
    )
  }

  if (loading && !application) {
    return (
      <p role="status" aria-busy="true" className="px-5 py-12 text-chip text-muted-foreground">
        Loading {namespace}/{name}…
      </p>
    )
  }

  if (!application) {
    return (
      <div className="px-5 py-12">
        <h1 className="font-cond text-title font-semibold">Application not found</h1>
        <p className="mt-2 text-chip text-muted-foreground">
          {error ?? `No application named ${name} in ${namespace}.`}
        </p>
      </div>
    )
  }

  const healthTone = phaseTone(application.health || application.phase)
  const syncIsClean = driftedCount === 0 && application.synced

  return (
    <div className="bg-background">
      {/* ── Header slab ─────────────────────────────────────────────── */}
      <div className="border-b border-rule bg-card px-5 pt-4">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <nav aria-label="Breadcrumb" className="font-mono text-meta text-neutral-600">
              <Link href="/dashboard/applications/" className="text-steel-700">
                Applications
              </Link>
              <span aria-hidden> / </span>
              {application.project ? (
                <>
                  <span>{application.project}</span>
                  <span aria-hidden> / </span>
                </>
              ) : null}
              <span>{application.name}</span>
            </nav>

            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <h1 className="font-cond text-title leading-none font-semibold tracking-[0.01em]">
                {application.name}
              </h1>
              <StatusPill
                tone={healthTone}
                label={STATUS_TONES[healthTone].label}
                className="gap-1.5 text-note"
              />
              <StatusPill
                tone={syncIsClean ? "healthy" : "degraded"}
                label={syncIsClean ? "In sync" : `${driftedCount} out of sync`}
                className="gap-1.5 text-note"
              />
            </div>

            <ul className="mt-2 flex list-none flex-wrap gap-1.5">
              {ownershipGate.visible && ownership ? (
                <>
                  {ownership.ownerLabel || ownership.owner ? (
                    <Tag>owner: {ownership.ownerLabel || ownership.owner}</Tag>
                  ) : null}
                  {ownership.onCall ? <Tag>on-call: {ownership.onCall}</Tag> : null}
                  {TIER_LABELS[ownership.tier] ? (
                    <Tag>tier: {TIER_LABELS[ownership.tier]}</Tag>
                  ) : null}
                </>
              ) : null}
              {application.source?.type ? (
                <Tag>
                  {application.source.type}
                  {application.source.path ? ` · ${application.source.path}` : ""}
                </Tag>
              ) : null}
              {application.currentStage ? <Tag>{application.currentStage}</Tag> : null}
            </ul>
          </div>

          <div className="flex flex-none flex-wrap items-center gap-1.5">
            {currentRelease ? (
              <ActionButton
                busy={busyAction === "rollback"}
                onClick={() =>
                  runAction("rollback", "Rollback", () =>
                    client.rollbackRelease({
                      namespace: currentRelease.namespace,
                      name: currentRelease.name,
                    })
                  )
                }
              >
                Rollback
              </ActionButton>
            ) : null}
            <Link
              href={`/dashboard/diff/?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`}
              className="inline-flex h-[30px] items-center border border-rule bg-card px-3 font-cond text-label font-semibold no-underline hover:bg-inset"
            >
              Diff
            </Link>
            <ActionButton
              primary
              busy={busyAction === "sync"}
              onClick={() =>
                runAction("sync", "Sync", () =>
                  client.syncApplication({ namespace, name })
                )
              }
            >
              Sync now
            </ActionButton>
          </div>
        </div>

        <div role="tablist" aria-label="Application sections" className="mt-3.5 flex">
          {SUB_TABS.map((t, index) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[index] = el
              }}
              type="button"
              role="tab"
              id={`app-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="app-tabpanel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                "border-b-2 px-3 pb-2 text-chip focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                tab === t.id
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {notice ? (
        <p role="status" className="border-b border-rule bg-inset px-5 py-2 text-note">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="border-b border-status-failed-line bg-status-failed-fill px-5 py-2 text-note text-status-failed-text"
        >
          {error}
        </p>
      ) : null}

      <div
        id="app-tabpanel"
        role="tabpanel"
        aria-labelledby={`app-tab-${tab}`}
        tabIndex={0}
        className="flex flex-col gap-4 px-5 pt-4.5 pb-8 outline-none"
      >
        {tab === "overview" ? (
          <>
            <DeliveryTimeline
              gate={lifecycleGate}
              phases={lifecycle}
              commit={commit}
              release={application.releaseRef}
              observedAtMs={data.lifecycleObservedAtMs}
            />
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              <ResourceBoard
                view={resourceView}
                onViewChange={setResourceView}
                nodes={treeNodes}
                graphNodes={graphNodes}
                collapsed={collapsed}
                onCollapsedChange={setCollapsed}
                onSelect={setSelected}
                selectedId={selectedId}
                driftedCount={driftedCount}
              />
              <div className="flex flex-col gap-3.5">
                <DrilldownRail gate={ownershipGate} ownership={ownership} />
                <GatesBoard
                  application={application}
                  policyResults={currentRelease?.policyResults ?? []}
                  busyAction={busyAction}
                  onGateAction={(gate, action) =>
                    runAction(
                      `gate:${gate}`,
                      action === "approve" ? "Approval" : "Rejection",
                      () =>
                        action === "approve"
                          ? client.approveGate({ namespace, name, gate })
                          : client.rejectGate({ namespace, name, gate })
                    )
                  }
                />
                <SourceBoard application={application} commit={commit} />
              </div>
            </div>
            <PromotionStages application={application} />
          </>
        ) : null}

        {tab === "resources" ? (
          <>
            <ResourceBoard
              view={resourceView}
              onViewChange={setResourceView}
              nodes={treeNodes}
              graphNodes={graphNodes}
              collapsed={collapsed}
              onCollapsedChange={setCollapsed}
              onSelect={setSelected}
              selectedId={selectedId}
              driftedCount={driftedCount}
            />
            <HealthChecksBoard application={application} />
            <InvestigationTriage
              application={application}
              investigate={(resource) =>
                client.investigate({
                  applicationNamespace: namespace,
                  applicationName: name,
                  resourceKind: resource.kind,
                  resourceName: resource.name,
                  resourceNamespace: resource.namespace,
                })
              }
              onSelectResource={setSelected}
            />
          </>
        ) : null}

        {tab === "releases" ? (
          <ApplicationReleaseHistory
            releases={appReleases}
            rollingBack={busyAction === "rollback" ? currentRelease?.name : null}
            onRollback={(release) =>
              void runAction("rollback", "Rollback", () =>
                client.rollbackRelease({
                  namespace: release.namespace,
                  name: release.name,
                })
              )
            }
          />
        ) : null}

        {tab === "pipelines" ? <PipelinesBoard application={application} /> : null}

        {tab === "policy" ? (
          <PolicyBoards application={application} release={currentRelease} />
        ) : null}

        {tab === "manifest" ? <ManifestBoard application={application} /> : null}
      </div>

      {selected ? (
        <ResourceDetailPanel
          applicationNamespace={application.namespace}
          applicationName={application.name}
          resource={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

/* ── Small shared pieces ───────────────────────────────────────────── */

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <li className="inline-flex items-center rounded-[2px] bg-inset px-2.5 py-[3px] text-note tracking-[0.02em] text-neutral-800">
      {children}
    </li>
  )
}

function ActionButton({
  children,
  onClick,
  busy,
  primary,
}: {
  children: React.ReactNode
  onClick: () => void
  busy?: boolean
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "inline-flex h-[30px] items-center border px-3 font-cond text-label font-semibold",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        primary
          ? "border-primary bg-primary text-primary-foreground"
          : "border-rule bg-card hover:bg-inset"
      )}
    >
      {busy ? "Working…" : children}
    </button>
  )
}

/**
 * The frame a board wears when its source is configured but not answering.
 * It states the reason and shows nothing numeric — a greyed board with a
 * sentence is honest; a board of zeros is not.
 */
function DegradedBody({ reason }: { reason: string }) {
  return (
    <p className="bg-inset px-3.5 py-6 text-center text-note text-muted-foreground">
      {reason}
    </p>
  )
}

function StaleBadge({ observedAtMs }: { observedAtMs: number }) {
  const age = formatAge(observedAtMs)
  if (!age) return null
  return (
    <span className="rounded-[2px] border border-status-degraded-line bg-status-degraded-fill px-1.5 py-px font-mono text-kicker text-status-degraded-text">
      stale · {age}
    </span>
  )
}

/* ── Delivery timeline ─────────────────────────────────────────────── */

function DeliveryTimeline({
  gate,
  phases,
  commit,
  release,
  observedAtMs,
}: {
  gate: SurfaceGate
  phases: LifecyclePhaseStatus[] | undefined
  commit: CommitInfo | undefined
  release: string
  observedAtMs: number
}) {
  if (!gate.visible) return null

  const meta = commitIsUsable(commit)
    ? [
        commit.message,
        commit.shortRevision,
        formatAge(Number(commit.committedAtUnixMs)),
      ]
        .filter(Boolean)
        .join(" · ")
    : formatAge(observedAtMs)

  return (
    <Blueprint>
      <BoardHeader
        title={release ? `Delivery timeline · ${release}` : "Delivery timeline"}
        meta={meta || undefined}
        actions={gate.stale ? <StaleBadge observedAtMs={gate.observedAtMs} /> : undefined}
      />
      {gate.degraded || !phases || phases.length === 0 ? (
        <DegradedBody
          reason={
            gate.reason ||
            "No lifecycle phases reported for this application yet."
          }
        />
      ) : (
        <ol className="grid list-none grid-cols-2 gap-px bg-rule md:grid-cols-3 xl:grid-cols-6">
          {phases.map((phase) => {
            const tone = lifecycleTone(phase.state)
            const spec = STATUS_TONES[tone]
            const duration = formatDuration(Number(phase.durationMs))
            return (
              <li
                key={phase.phase}
                className={cn(
                  "px-3.5 pt-2.5 pb-3",
                  tone === "healthy" ? "bg-card" : spec.fill
                )}
              >
                <div className="flex items-center justify-between">
                  <StatusGlyph
                    tone={tone}
                    label={`${LIFECYCLE_LABELS[phase.phase] ?? "Phase"}: ${lifecycleStateLabel(phase.state)}`}
                  />
                  {duration ? (
                    <span className="font-mono text-kicker text-neutral-600 tabular-nums">
                      {duration}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 font-cond text-label font-semibold tracking-[0.07em] uppercase">
                  {LIFECYCLE_LABELS[phase.phase] ?? "Phase"}
                </p>
                <p className="mt-0.5 text-note leading-[1.4] text-muted-foreground">
                  {phase.detail || lifecycleStateLabel(phase.state)}
                </p>
                {phase.referenceKind && phase.reference?.name ? (
                  <p className="mt-1.5 font-mono text-meta text-steel-700">
                    {phase.referenceKind} {phase.reference.name}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </Blueprint>
  )
}

/* ── Resource board ────────────────────────────────────────────────── */

function ResourceBoard({
  view,
  onViewChange,
  nodes,
  graphNodes,
  collapsed,
  onCollapsedChange,
  onSelect,
  selectedId,
  driftedCount,
}: {
  view: ResourceView
  onViewChange: (view: ResourceView) => void
  nodes: FlatTreeNode[]
  graphNodes: ResourceGraphNode[]
  collapsed: ReadonlySet<string>
  onCollapsedChange: (next: Set<string>) => void
  onSelect: (n: InspectedResource) => void
  selectedId: string | null
  driftedCount: number
}) {
  const managed = nodes.length
  return (
    <Blueprint>
      <BoardHeader
        title="Resource graph"
        meta={`${managed} managed · ${driftedCount} drifted`}
        actions={
          <span className="flex items-center gap-2.5">
            {view === "tree" ? (
              <span className="flex gap-1">
                <MicroButton onClick={() => onCollapsedChange(new Set())}>
                  Expand all
                </MicroButton>
                <MicroButton onClick={() => onCollapsedChange(collapsibleIds(nodes))}>
                  Collapse all
                </MicroButton>
              </span>
            ) : null}
            <Seg
              label="Resource view"
              value={view}
              onValueChange={onViewChange}
              options={[
                { value: "graph", label: "Graph" },
                { value: "tree", label: "Tree" },
              ]}
            />
          </span>
        }
      />
      {view === "graph" ? (
        <ResourceGraph
          nodes={graphNodes}
          selectedId={selectedId}
          onSelectNode={(n) =>
            onSelect({
              kind: n.kind,
              name: n.name,
              namespace: n.namespace,
              syncStatus: n.syncStatus,
              health: n.health,
              healthMessage: n.healthMessage,
            })
          }
        />
      ) : (
        <ResourceTree
          nodes={nodes}
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      )}
    </Blueprint>
  )
}

function MicroButton({
  children,
  onClick,
}: {
  children: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[2px] border border-rule bg-card px-[7px] py-px font-mono text-meta whitespace-nowrap text-muted-foreground hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {children}
    </button>
  )
}

/* ── Right rail ────────────────────────────────────────────────────── */

const DRILLDOWN_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 7]

function DrilldownRail({
  gate,
  ownership,
}: {
  gate: SurfaceGate
  ownership: Ownership | undefined
}) {
  // NOT_CONFIGURED / FORBIDDEN: the rail does not exist. No empty frame,
  // no "connect a source" placeholder pretending to be data.
  if (!gate.visible) return null

  const links: DrilldownLink[] = ownership?.links ?? []
  const ordered = [...links].sort(
    (a, b) => DRILLDOWN_ORDER.indexOf(a.kind) - DRILLDOWN_ORDER.indexOf(b.kind)
  )

  return (
    <Blueprint>
      <RailHeader
        title="Drilldowns"
        badge={gate.stale ? <StaleBadge observedAtMs={gate.observedAtMs} /> : null}
      />
      {gate.degraded ? (
        <DegradedBody reason={gate.reason} />
      ) : ordered.length === 0 ? (
        <p className="px-3 py-4 text-note text-muted-foreground">
          No drilldown links are attached to this application.
        </p>
      ) : (
        <ul className="list-none">
          {ordered.map((link) => (
            <li key={`${link.kind}-${link.url}`}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex h-11 items-center gap-2 border-b border-rule-soft px-3 text-chip text-foreground no-underline hover:bg-inset"
              >
                <span className="flex-1 truncate">{link.label}</span>
                <span aria-hidden className="font-mono text-meta text-neutral-600">
                  ↗
                </span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {ownership?.escalationUrl ? (
        <div className="px-3 py-2">
          <a
            href={ownership.escalationUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 w-full items-center justify-center border border-rule bg-card text-note no-underline hover:bg-inset"
          >
            Escalate
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      ) : null}
    </Blueprint>
  )
}

function RailHeader({
  title,
  badge,
}: {
  title: string
  badge?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between border-b border-rule py-1.5 pr-2 pl-3">
      <h3 className="font-cond text-label font-semibold tracking-[0.06em] uppercase">
        {title}
      </h3>
      {badge}
    </div>
  )
}

function GatesBoard({
  application,
  policyResults,
  busyAction,
  onGateAction,
}: {
  application: Application
  policyResults: { name: string; passed: boolean; message: string; severity: string }[]
  busyAction: string | null
  onGateAction: (gate: string, action: "approve" | "reject") => void
}) {
  const gates = application.gates ?? []
  const analysis = application.analysisResults ?? []
  if (gates.length === 0 && analysis.length === 0 && policyResults.length === 0) {
    return null
  }

  return (
    <Blueprint>
      <RailHeader title="Gates & analysis" />
      <ul className="list-none">
        {gates.map((gate) => {
          const tone = phaseTone(gate.status)
          const pending = gate.status === "Pending"
          return (
            <li
              key={gate.name}
              className="flex items-center gap-2 border-b border-rule-soft px-3 py-2"
            >
              <StatusGlyph tone={tone} label={`${gate.name}: ${gate.status}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-chip font-semibold">{gate.name}</span>
                <span className="block text-note text-muted-foreground">
                  {[gate.stage, gate.type, gate.message].filter(Boolean).join(" · ")}
                </span>
              </span>
              {pending ? (
                <span className="flex flex-none gap-1">
                  <MicroButton onClick={() => onGateAction(gate.name, "approve")}>
                    {busyAction === `gate:${gate.name}` ? "…" : "Approve"}
                  </MicroButton>
                  <MicroButton onClick={() => onGateAction(gate.name, "reject")}>
                    Reject
                  </MicroButton>
                </span>
              ) : null}
            </li>
          )
        })}
        {analysis.map((result, index) => {
          const tone = result.passed ? "healthy" : phaseTone(result.phase)
          return (
            <li
              key={`analysis-${result.name}-${index}`}
              className="flex items-center gap-2 border-b border-rule-soft px-3 py-2"
            >
              <StatusGlyph
                tone={tone}
                label={`${result.name}: ${result.passed ? "passed" : result.phase || "failed"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-chip font-semibold">
                  analysis: {result.name}
                </span>
                <span className="block text-note text-muted-foreground">
                  {result.message || result.phase}
                </span>
              </span>
            </li>
          )
        })}
        {policyResults.map((result, index) => (
          <li
            key={`policy-${result.name}-${index}`}
            className="flex items-center gap-2 border-b border-rule-soft px-3 py-2"
          >
            <StatusGlyph
              tone={result.passed ? "healthy" : "failed"}
              label={`${result.name}: ${result.passed ? "passed" : "failed"}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-chip font-semibold">{result.name}</span>
              <span className="block text-note text-muted-foreground">
                {[result.severity, result.message].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Blueprint>
  )
}

function SourceBoard({
  application,
  commit,
}: {
  application: Application
  commit: CommitInfo | undefined
}) {
  const source = application.source
  const rows: [string, string][] = []
  if (source?.repoUrl) rows.push(["Repository", source.repoUrl])
  if (source?.bucket) rows.push(["Bucket", source.bucket])
  if (source?.path) rows.push(["Path", source.path])
  if (source?.type) rows.push(["Engine", source.type])
  const revision =
    (commitIsUsable(commit) ? commit.shortRevision : "") ||
    source?.revision ||
    application.revision
  if (revision) rows.push(["Revision", revision])
  if (commitIsUsable(commit) && commit.authorName) rows.push(["Author", commit.authorName])
  if (application.syncPolicy) rows.push(["Sync policy", application.syncPolicy])
  if (application.strategy) rows.push(["Strategy", application.strategy])
  if (application.templateRef) rows.push(["Template", application.templateRef])
  if (rows.length === 0) return null

  return (
    <Blueprint>
      <RailHeader title="Source" />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 px-3 pt-1 pb-2.5">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="border-b border-rule-faint py-1.5 text-note text-muted-foreground">
              {key}
            </dt>
            <dd className="truncate border-b border-rule-faint py-1.5 text-right font-mono text-note">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Blueprint>
  )
}

/* ── Promotion stages ──────────────────────────────────────────────── */

function PromotionStages({ application }: { application: Application }) {
  const stages = application.stages ?? []
  if (stages.length === 0) return null
  return (
    <Blueprint>
      <BoardHeader title="Promotion stages" meta={`${stages.length} rings`} />
      <ol className="grid list-none grid-cols-1 gap-px bg-rule sm:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => {
          const tone = phaseTone(stage.phase)
          const spec = STATUS_TONES[tone]
          return (
            <li
              key={`${stage.ring}-${stage.name}`}
              className={cn(
                "px-3.5 pt-2.5 pb-3",
                tone === "healthy" ? "bg-card" : spec.fill
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
                  RING {stage.ring}
                </span>
                <StatusGlyph tone={tone} label={`${stage.name}: ${stage.phase}`} />
              </div>
              <p className="mt-1.5 font-cond text-board font-semibold tracking-[0.04em] uppercase">
                {stage.name}
              </p>
              {stage.release ? (
                <p className="mt-0.5 font-mono text-meta text-neutral-600">
                  {stage.release}
                </p>
              ) : null}
              <p className="mt-2 text-note text-muted-foreground">
                {[stage.phase, stage.revision].filter(Boolean).join(" · ")}
              </p>
            </li>
          )
        })}
      </ol>
    </Blueprint>
  )
}

/* ── Other sub-tabs ────────────────────────────────────────────────── */

function HealthChecksBoard({ application }: { application: Application }) {
  const checks = application.healthChecks ?? []
  if (checks.length === 0) return null
  const tone = worstTone(checks.map((c) => phaseTone(c.status)))
  return (
    <Blueprint>
      <BoardHeader
        title="Health checks"
        meta={`${checks.length} · worst ${STATUS_TONES[tone].label.toLowerCase()}`}
      />
      <table className="w-full border-collapse text-chip">
        <caption className="sr-only">CEL health check results</caption>
        <thead>
          <tr className="border-b border-rule-strong bg-muted text-left">
            <Th>Check</Th>
            <Th>Status</Th>
            <Th>HTTP</Th>
            <Th>Message</Th>
            <Th>Checked</Th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.name} className="border-b border-rule-soft">
              <Td className="font-mono">{check.name}</Td>
              <Td>
                <StatusPill
                  tone={phaseTone(check.status)}
                  label={check.status || "Unknown"}
                />
              </Td>
              <Td className="tabular-nums">
                {check.httpStatusCode > 0 ? check.httpStatusCode : ""}
              </Td>
              <Td className="text-muted-foreground">{check.message}</Td>
              <Td className="text-muted-foreground tabular-nums">
                {formatSeconds(check.checkedAt)}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Blueprint>
  )
}

function PipelinesBoard({ application }: { application: Application }) {
  if (!application.pipelineRef) {
    return (
      <Blueprint>
        <BoardHeader title="Pipelines" />
        <p className="px-3.5 py-6 text-note text-muted-foreground">
          No pipeline is bound to this application.
        </p>
      </Blueprint>
    )
  }
  return (
    <Blueprint>
      <BoardHeader title="Pipelines" meta={application.pipelineRef} />
      <div className="px-3.5 py-4">
        <Link
          href={`/dashboard/pipelines/detail/?namespace=${encodeURIComponent(application.namespace)}&name=${encodeURIComponent(application.pipelineRef)}`}
          className="text-chip"
        >
          Open pipeline {application.pipelineRef}
        </Link>
      </div>
    </Blueprint>
  )
}

function PolicyBoards({
  application,
  release,
}: {
  application: Application
  release: Release | null
}) {
  const conditions = application.conditions ?? []
  const policyResults = release?.policyResults ?? []
  const gates = application.gates ?? []

  if (conditions.length === 0 && policyResults.length === 0 && gates.length === 0) {
    return (
      <Blueprint>
        <BoardHeader title="Policy" />
        <p className="px-3.5 py-6 text-note text-muted-foreground">
          No gates, policies or conditions have been evaluated for this
          application.
        </p>
      </Blueprint>
    )
  }

  return (
    <>
      {policyResults.length > 0 ? (
        <Blueprint>
          <BoardHeader
            title="Policy results"
            meta={release ? `release ${release.name}` : undefined}
          />
          <table className="w-full border-collapse text-chip">
            <caption className="sr-only">Policy evaluation for the current release</caption>
            <thead>
              <tr className="border-b border-rule-strong bg-muted text-left">
                <Th>Policy</Th>
                <Th>Result</Th>
                <Th>Severity</Th>
                <Th>Action</Th>
                <Th>Message</Th>
              </tr>
            </thead>
            <tbody>
              {policyResults.map((result, index) => (
                <tr key={`${result.name}-${index}`} className="border-b border-rule-soft">
                  <Td className="font-semibold">{result.name}</Td>
                  <Td>
                    <StatusPill
                      tone={result.passed ? "healthy" : "failed"}
                      label={result.passed ? "Pass" : "Fail"}
                    />
                  </Td>
                  <Td>{result.severity}</Td>
                  <Td className="font-mono">{result.action}</Td>
                  <Td className="text-muted-foreground">{result.message}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Blueprint>
      ) : null}

      {conditions.length > 0 ? (
        <Blueprint>
          <BoardHeader title="Conditions" meta={`${conditions.length}`} />
          <ul className="list-none">
            {conditions.map((condition) => (
              <li
                key={condition.type}
                className="flex items-start gap-2 border-b border-rule-soft px-3.5 py-2"
              >
                <StatusGlyph
                  tone={condition.status === "True" ? "healthy" : "degraded"}
                  label={`${condition.type}: ${condition.status}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-chip font-semibold">{condition.type}</span>
                  <span className="block text-note text-muted-foreground">
                    {[condition.reason, condition.message].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="flex-none font-mono text-meta text-neutral-600">
                  {condition.lastTransitionTime}
                </span>
              </li>
            ))}
          </ul>
        </Blueprint>
      ) : null}
    </>
  )
}

function ManifestBoard({ application }: { application: Application }) {
  const parameters = Object.entries(application.parameters ?? {})
  return (
    <>
      <SourceBoard application={application} commit={undefined} />
      <Blueprint>
        <BoardHeader title="Parameters" meta={`${parameters.length}`} />
        {parameters.length === 0 ? (
          <p className="px-3.5 py-6 text-note text-muted-foreground">
            This application overrides no parameters.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-3.5 py-2">
            {parameters.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="border-b border-rule-faint py-1.5 font-mono text-note text-muted-foreground">
                  {key}
                </dt>
                <dd className="truncate border-b border-rule-faint py-1.5 text-right font-mono text-note">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Blueprint>
    </>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
    >
      {children}
    </th>
  )
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <td className={cn("px-3.5 py-2 align-middle", className)}>{children}</td>
}

export default function ApplicationDetailPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="px-5 py-12 text-chip text-muted-foreground">
          Loading application…
        </p>
      }
    >
      <ApplicationDetail />
    </Suspense>
  )
}
