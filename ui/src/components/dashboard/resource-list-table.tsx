"use client"

import { useMemo } from "react"
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type Row,
} from "@tanstack/react-table"
import { ChevronRight, Box, Server, Activity } from "lucide-react"

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

// MergedResource is the synthesis of Application.status.resources + Application.status.resourceHealth.
// Used as a fallback when the resource-tree RPCs return nothing.
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
  resourceHealth?: { kind: string; name: string; namespace: string; health: string; message: string }[]
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

/**
 * Build a parent → children tree index from a flat list using parentKind/parentName.
 * Roots are nodes whose parent isn't in the list. Orphan children become roots.
 */
export function buildTree(flat: FlatTreeNode[]): TreeNode[] {
  const byKindName = new Map<string, TreeNode>()
  flat.forEach((n) => byKindName.set(`${n.kind}/${n.name}`, { ...n }))

  const roots: TreeNode[] = []
  flat.forEach((n) => {
    const node = byKindName.get(`${n.kind}/${n.name}`)!
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

const columnHelper = createColumnHelper<TreeNode>()

const kindIcons: Record<string, typeof Box> = {
  Deployment: Box,
  StatefulSet: Box,
  DaemonSet: Box,
  ReplicaSet: Activity,
  Pod: Activity,
  Service: Server,
  ConfigMap: Box,
  Secret: Box,
  Ingress: Server,
  Job: Activity,
  CronJob: Activity,
}

interface ResourceListTableProps {
  nodes: FlatTreeNode[]
  onSelect: (n: {
    kind: string
    name: string
    namespace: string
    syncStatus: string
    health: string
    healthMessage: string
  }) => void
}

function selectResource(node: TreeNode, onSelect: ResourceListTableProps["onSelect"]) {
  onSelect({
    kind: node.kind,
    name: node.name,
    namespace: node.namespace,
    syncStatus: node.syncStatus || "",
    health: node.health || "",
    healthMessage: node.healthMessage || "",
  })
}

export function ResourceListTable({ nodes, onSelect }: ResourceListTableProps) {
  const data = useMemo(() => buildTree(nodes), [nodes])

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: "expander",
        header: () => null,
        cell: ({ row }) =>
          row.getCanExpand() ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                row.toggleExpanded()
              }}
              aria-label={`${row.getIsExpanded() ? "Collapse" : "Expand"} children for ${row.original.kind} ${row.original.name}`}
              aria-expanded={row.getIsExpanded()}
              className="flex size-5 items-center justify-center rounded text-muted-foreground transition-[color,background-color] hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <ChevronRight
                className={`size-3.5 transition-transform ${row.getIsExpanded() ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <span className="inline-block size-5" />
          ),
      }),
      columnHelper.accessor("kind", {
        header: "Kind",
        cell: (ctx) => {
          const kind = ctx.getValue()
          const Icon = kindIcons[kind] ?? Box
          return (
            <span className="inline-flex items-center gap-1.5">
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="font-mono text-xs">{kind}</span>
            </span>
          )
        },
      }),
      columnHelper.accessor("name", {
        header: "Name",
        cell: (ctx) => {
          const node = ctx.row.original
          return (
            <button
              type="button"
              aria-label={`Open ${node.kind} ${node.name} resource details`}
              onClick={(event) => {
                event.stopPropagation()
                selectResource(node, onSelect)
              }}
              className="inline-flex rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span className="font-mono text-xs">{ctx.getValue()}</span>
            </button>
          )
        },
      }),
      columnHelper.accessor("namespace", {
        header: "Namespace",
        cell: (ctx) => <span className="text-xs text-muted-foreground tabular-nums">{ctx.getValue() || "—"}</span>,
      }),
      columnHelper.accessor("syncStatus", {
        header: "Sync",
        cell: (ctx) => {
          const v = ctx.getValue() || "—"
          return <span className="text-xs">{v}</span>
        },
      }),
      columnHelper.accessor("health", {
        header: "Health",
        cell: (ctx) => {
          const v = ctx.getValue() || "—"
          return <span className="text-xs">{v}</span>
        },
      }),
      columnHelper.display({
        id: "ready",
        header: "Ready",
        cell: ({ row }) => {
          const { ready, total } = row.original
          if (total === undefined || total === 0) return <span className="text-xs text-muted-foreground">—</span>
          const good = ready === total
          const partial = ready !== undefined && ready > 0 && ready < total
          const cls = good ? "text-emerald-500" : partial ? "text-amber-500" : "text-destructive"
          return <span className={`text-xs tabular-nums ${cls}`}>{ready}/{total}</span>
        },
      }),
    ],
    [onSelect],
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSubRows: (row) => row.subRows,
    getRowId: (row) => `${row.kind}/${row.name}`,
  })

  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl bg-muted/30 ring-1 ring-foreground/10">
        <p className="text-sm text-muted-foreground">No resources to display.</p>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <table aria-label="Application resources" className="w-full text-sm" data-testid="resource-list-table">
        <thead className="bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className="px-3 py-2 text-left font-medium">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <ResourceRow key={row.id} row={row} onSelect={onSelect} depth={row.depth} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResourceRow({
  row,
  onSelect,
  depth,
}: {
  row: Row<TreeNode>
  onSelect: ResourceListTableProps["onSelect"]
  depth: number
}) {
  const n = row.original
  return (
    <tr
      onClick={() => selectResource(n, onSelect)}
      className="cursor-pointer border-t border-foreground/5 transition-[background-color] hover:bg-muted/30"
      data-testid={`row-${n.kind}-${n.name}`}
    >
      {row.getVisibleCells().map((cell, i) => (
        <td
          key={cell.id}
          className="px-3 py-2 align-middle"
          style={i === 1 && depth > 0 ? { paddingLeft: `${depth * 16 + 12}px` } : undefined}
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </td>
      ))}
    </tr>
  )
}
