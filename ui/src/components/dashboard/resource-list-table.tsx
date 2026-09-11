"use client"

import { ChevronDown } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"

import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * One node of `GetResourceTreeDetailed`. `ready`/`total`, `phase` and
 * `message` are the fields the detailed RPC adds over the flat tree; they are
 * the only source of the per-row summary line, so a server that does not
 * populate them renders a row with no summary rather than an invented one.
 */
export interface FlatTreeNode {
  kind: string
  name: string
  namespace: string
  syncStatus?: string
  health?: string
  healthMessage?: string
  parentKind?: string
  parentName?: string
  managed?: boolean
  phase?: string
  ready?: number
  total?: number
  message?: string
  containers?: string[]
}

interface TreeNode extends FlatTreeNode {
  subRows?: TreeNode[]
}

/** The shape the inspector needs to open on a row. */
export interface MergedResource {
  kind: string
  name: string
  namespace: string
  syncStatus: string
  health: string
  healthMessage: string
}

export function mergeResourcesFromApplication(app: {
  resources?: { kind: string; name: string; namespace: string; status: string }[]
  resourceHealth?: {
    kind: string
    name: string
    namespace: string
    health: string
    message: string
  }[]
}): MergedResource[] {
  const healthMap = new Map<string, { health: string; message: string }>()
  for (const h of app.resourceHealth ?? []) {
    healthMap.set(`${h.kind}/${h.name}`, { health: h.health, message: h.message })
  }
  return (app.resources ?? []).map((r) => {
    const h = healthMap.get(`${r.kind}/${r.name}`)
    return {
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      syncStatus: r.status,
      health: h?.health ?? "Unknown",
      healthMessage: h?.message ?? "",
    }
  })
}

/** Stable identity for a node, matching the parentKind/parentName join key. */
export function resourceKey(n: { kind: string; name: string }): string {
  return `${n.kind}/${n.name}`
}

/**
 * Build a parent → children tree index from a flat list using
 * parentKind/parentName. Roots are nodes whose parent isn't in the list;
 * orphan children become roots so nothing is silently dropped.
 */
export function buildTree(flat: FlatTreeNode[]): TreeNode[] {
  const byKindName = new Map<string, TreeNode>()
  flat.forEach((n) => byKindName.set(resourceKey(n), { ...n }))

  const roots: TreeNode[] = []
  flat.forEach((n) => {
    const node = byKindName.get(resourceKey(n))!
    const parentKey = `${n.parentKind}/${n.parentName}`
    if (n.parentKind && n.parentName && byKindName.has(parentKey)) {
      const parent = byKindName.get(parentKey)!
      parent.subRows = parent.subRows ?? []
      parent.subRows.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

/**
 * The API speaks Kubernetes health strings; the console speaks tones. Anything
 * unrecognised resolves to `unknown` rather than to a cheerful default.
 */
export function resourceHealthTone(health: string | undefined): StatusTone {
  switch ((health ?? "").trim().toLowerCase()) {
    case "healthy":
      return "healthy"
    case "progressing":
      return "progressing"
    case "degraded":
      return "degraded"
    case "failed":
    case "error":
      return "failed"
    case "missing":
      return "missing"
    case "suspended":
    case "pending":
      return "pending"
    default:
      return "unknown"
  }
}

export function resourceSyncTone(sync: string | undefined): StatusTone {
  switch ((sync ?? "").trim().toLowerCase()) {
    case "synced":
      return "healthy"
    case "outofsync":
    case "out_of_sync":
      return "degraded"
    case "missing":
      return "missing"
    case "pruned":
      return "pending"
    default:
      return "unknown"
  }
}

/** Sync has its own vocabulary: a drifted resource is not a "degraded" one. */
export function resourceSyncLabel(sync: string | undefined): string {
  const tone = resourceSyncTone(sync)
  if (tone === "healthy") return "Synced"
  if (tone === "degraded") return "Drifted"
  if (tone === "missing") return "Missing"
  if (tone === "pending") return "Pruned"
  return "Unknown"
}

/**
 * The row summary is assembled only from fields the server actually sent.
 * An unpopulated node gets no summary — never a `0/0` or an em dash standing
 * in for a reading nobody took.
 */
export function resourceSummary(n: FlatTreeNode): string {
  const parts: string[] = []
  if (typeof n.total === "number" && n.total > 0) {
    parts.push(`${n.ready ?? 0}/${n.total} ready`)
  }
  if (n.phase) parts.push(n.phase)
  const message = n.message || n.healthMessage
  if (message) parts.push(message)
  return parts.join(" · ")
}

interface VisibleRow {
  id: string
  node: TreeNode
  depth: number
  childCount: number
  collapsed: boolean
}

/**
 * Depth-first pre-order walk. A collapsed node still renders itself; only its
 * descendants are withheld. `limit` keeps the DOM bounded for a pathological
 * application — the count of what was withheld is reported, not hidden.
 */
export function flattenTree(
  roots: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  limit = MAX_TREE_ROWS
): { rows: VisibleRow[]; truncated: number } {
  const rows: VisibleRow[] = []
  let skipped = 0

  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      const id = resourceKey(node)
      const children = node.subRows ?? []
      const isCollapsed = collapsed.has(id)
      if (rows.length >= limit) {
        skipped += 1 + (isCollapsed ? 0 : countDescendants(children))
        continue
      }
      rows.push({ id, node, depth, childCount: children.length, collapsed: isCollapsed })
      if (!isCollapsed && children.length > 0) walk(children, depth + 1)
    }
  }

  walk(roots, 0)
  return { rows, truncated: skipped }
}

function countDescendants(nodes: readonly TreeNode[]): number {
  let total = 0
  for (const node of nodes) total += 1 + countDescendants(node.subRows ?? [])
  return total
}

/** Every node that has children and is not a root — what "Collapse all" closes. */
export function collapsibleIds(flat: readonly FlatTreeNode[]): Set<string> {
  const roots = buildTree(flat as FlatTreeNode[])
  const ids = new Set<string>()
  const walk = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      const children = node.subRows ?? []
      if (children.length > 0 && depth > 0) ids.add(resourceKey(node))
      walk(children, depth + 1)
    }
  }
  walk(roots, 0)
  return ids
}

export const MAX_TREE_ROWS = 500

interface ResourceTreeProps {
  nodes: FlatTreeNode[]
  /** Ids of nodes whose children are hidden. Controlled by the board header. */
  collapsed: ReadonlySet<string>
  onCollapsedChange: (next: Set<string>) => void
  onSelect: (n: MergedResource) => void
  selectedId?: string | null
  emptyLabel?: string
}

/**
 * The resource tree: one row per managed object, indented by depth, with the
 * health and sync tone carried by a glyph as well as a colour.
 *
 * It is a `treegrid` rather than a table because the rows nest and the
 * expanders are part of the row, not decoration: arrow keys move and
 * open/close, Enter opens the inspector.
 */
export function ResourceTree({
  nodes,
  collapsed,
  onCollapsedChange,
  onSelect,
  selectedId,
  emptyLabel = "No managed resources reported for this application.",
}: ResourceTreeProps) {
  const roots = useMemo(() => buildTree(nodes), [nodes])
  const { rows, truncated } = useMemo(
    () => flattenTree(roots, collapsed),
    [roots, collapsed]
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onCollapsedChange(next)
    },
    [collapsed, onCollapsedChange]
  )

  const focusRow = useCallback((index: number) => {
    setActiveIndex(index)
    rowRefs.current[index]?.focus()
  }, [])

  const onRowKeyDown = useCallback(
    (event: React.KeyboardEvent, row: VisibleRow, index: number) => {
      const hasChildren = row.childCount > 0
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault()
          focusRow(Math.min(rows.length - 1, index + 1))
          break
        case "ArrowUp":
          event.preventDefault()
          focusRow(Math.max(0, index - 1))
          break
        case "Home":
          event.preventDefault()
          focusRow(0)
          break
        case "End":
          event.preventDefault()
          focusRow(rows.length - 1)
          break
        case "ArrowRight":
          if (hasChildren && row.collapsed) {
            event.preventDefault()
            toggle(row.id)
          }
          break
        case "ArrowLeft":
          if (hasChildren && !row.collapsed) {
            event.preventDefault()
            toggle(row.id)
          }
          break
        case "Enter":
        case " ":
          event.preventDefault()
          onSelect(toMergedResource(row.node))
          break
        default:
          break
      }
    },
    [focusRow, onSelect, rows.length, toggle]
  )

  if (rows.length === 0) {
    return (
      <p className="px-3.5 py-8 text-center text-chip text-muted-foreground">
        {emptyLabel}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div
          role="treegrid"
          aria-label="Resource tree"
          aria-rowcount={rows.length + 1}
          data-testid="resource-tree"
        >
          <div
            role="row"
            className="grid h-7 grid-cols-[minmax(0,1fr)_92px_84px] items-center gap-3 border-b border-rule-strong bg-muted px-3.5"
          >
            <span
              role="columnheader"
              className="font-mono text-kicker tracking-[0.14em] text-muted-foreground"
            >
              RESOURCE
            </span>
            <span
              role="columnheader"
              className="font-mono text-kicker tracking-[0.14em] text-muted-foreground"
            >
              HEALTH
            </span>
            <span
              role="columnheader"
              className="font-mono text-kicker tracking-[0.14em] text-muted-foreground"
            >
              SYNC
            </span>
          </div>

          {rows.map((row, index) => (
            <ResourceRow
              key={row.id}
              ref={(el) => {
                rowRefs.current[index] = el
              }}
              row={row}
              index={index}
              rowCount={rows.length}
              tabIndex={index === activeIndex ? 0 : -1}
              selected={selectedId === row.id}
              onToggle={() => toggle(row.id)}
              onOpen={() => onSelect(toMergedResource(row.node))}
              onKeyDown={(event) => onRowKeyDown(event, row, index)}
              onFocus={() => setActiveIndex(index)}
            />
          ))}
        </div>
        {truncated > 0 ? (
          <p
            role="status"
            className="border-t border-rule-soft px-3.5 py-2 font-mono text-meta text-muted-foreground"
          >
            {truncated} further resources not drawn — the tree is capped at{" "}
            {MAX_TREE_ROWS} rows.
          </p>
        ) : null}
      </div>
    </div>
  )
}

function toMergedResource(n: FlatTreeNode): MergedResource {
  return {
    kind: n.kind,
    name: n.name,
    namespace: n.namespace,
    syncStatus: n.syncStatus ?? "",
    health: n.health ?? "",
    healthMessage: n.healthMessage ?? "",
  }
}

function ResourceRow({
  ref,
  row,
  index,
  rowCount,
  tabIndex,
  selected,
  onToggle,
  onOpen,
  onKeyDown,
  onFocus,
}: {
  ref: (el: HTMLDivElement | null) => void
  row: VisibleRow
  index: number
  rowCount: number
  tabIndex: number
  selected: boolean
  onToggle: () => void
  onOpen: () => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onFocus: () => void
}) {
  const n = row.node
  const healthTone = resourceHealthTone(n.health)
  const syncTone = resourceSyncTone(n.syncStatus)
  const hasChildren = row.childCount > 0
  const summary = resourceSummary(n)

  return (
    <div
      ref={ref}
      role="row"
      aria-level={row.depth + 1}
      aria-rowindex={index + 2}
      aria-setsize={rowCount}
      aria-expanded={hasChildren ? !row.collapsed : undefined}
      aria-selected={selected}
      tabIndex={tabIndex}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      data-testid={`row-${n.kind}-${n.name}`}
      className={cn(
        "grid h-[38px] cursor-pointer grid-cols-[minmax(0,1fr)_92px_84px] items-center gap-3 border-b border-rule-soft px-3.5 text-left",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        healthTone === "failed" ? "bg-status-failed-fill" : "bg-card",
        selected && "bg-selected",
        "hover:bg-inset"
      )}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="flex-none" style={{ width: row.depth * 22 }} />
        {hasChildren ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
            aria-label={`${row.collapsed ? "Expand" : "Collapse"} ${n.kind} ${n.name}`}
            tabIndex={-1}
            className="inline-flex size-[18px] flex-none items-center justify-center border border-rule bg-card text-muted-foreground"
          >
            <ChevronDown
              aria-hidden
              className={cn("size-3 transition-transform", row.collapsed && "-rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden className="inline-block size-[18px] flex-none" />
        )}
        <StatusGlyph
          tone={healthTone}
          label={`${STATUS_TONES[healthTone].label} health`}
        />
        <span className="w-[82px] flex-none font-mono text-kicker tracking-[0.08em] text-neutral-600">
          {n.kind.toUpperCase()}
        </span>
        <span className="font-cond text-label font-semibold tracking-[0.02em] whitespace-nowrap">
          {n.name}
        </span>
        {summary ? (
          <span className="truncate text-note text-muted-foreground">{summary}</span>
        ) : null}
        {hasChildren ? (
          <span className="ml-auto pl-2 font-mono text-kicker text-neutral-500 tabular-nums">
            {row.childCount}
          </span>
        ) : null}
      </span>
      <span role="gridcell">
        <StatusPill tone={healthTone} />
      </span>
      <span role="gridcell">
        <StatusPill tone={syncTone} label={resourceSyncLabel(n.syncStatus)} />
      </span>
    </div>
  )
}
