"use client"

import type { Application } from "@/gen/paprika/v1/api_pb"
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Clock,
  Heart,
  Activity,
  ChevronRight,
} from "lucide-react"

export interface MergedResource {
  kind: string
  name: string
  namespace: string
  syncStatus: string
  health: string
  healthMessage: string
}

const syncIcon: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  Synced: { icon: CheckCircle2, color: "text-emerald-500" },
  OutOfSync: { icon: AlertCircle, color: "text-amber-500" },
  Missing: { icon: XCircle, color: "text-destructive" },
  Pruned: { icon: Clock, color: "text-muted-foreground" },
}

const healthIcon: Record<string, { icon: typeof Heart; color: string }> = {
  Healthy: { icon: Heart, color: "text-emerald-500" },
  Degraded: { icon: XCircle, color: "text-destructive" },
  Progressing: { icon: Activity, color: "text-amber-500" },
  Unknown: { icon: AlertCircle, color: "text-muted-foreground" },
  Missing: { icon: XCircle, color: "text-destructive" },
}

export function mergeResources(application: Application): MergedResource[] {
  const healthMap = new Map<string, string>()
  const messageMap = new Map<string, string>()
  for (const h of application.resourceHealth ?? []) {
    healthMap.set(`${h.kind}/${h.name}`, h.health)
    messageMap.set(`${h.kind}/${h.name}`, h.message)
  }
  return (application.resources ?? []).map((r) => ({
    kind: r.kind,
    name: r.name,
    namespace: r.namespace || application.namespace,
    syncStatus: r.status,
    health: healthMap.get(`${r.kind}/${r.name}`) ?? "Unknown",
    healthMessage: messageMap.get(`${r.kind}/${r.name}`) ?? "",
  }))
}

export function ResourceTable({
  resources,
  onSelect,
}: {
  resources: MergedResource[]
  onSelect: (r: MergedResource) => void
}) {
  if (resources.length === 0) return null

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/40 bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">Kind</th>
            <th className="px-4 py-2.5 text-left font-medium">Name</th>
            <th className="px-4 py-2.5 text-left font-medium">Sync</th>
            <th className="px-4 py-2.5 text-left font-medium">Health</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => {
            const si = syncIcon[r.syncStatus] ?? syncIcon.Pruned
            const hi = healthIcon[r.health] ?? healthIcon.Unknown
            const SI = si.icon
            const HI = hi.icon
            return (
              <tr
                key={`${r.kind}/${r.name}`}
                onClick={() => onSelect(r)}
                className="cursor-pointer border-b border-border/20 transition-[background-color] last:border-0 hover:bg-muted/30"
              >
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs font-medium">{r.kind}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-xs">{r.name}</span>
                  {r.namespace && (
                    <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">{r.namespace}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${si.color}`}>
                    <SI className="size-3.5" />
                    {r.syncStatus}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${hi.color}`}>
                    <HI className="size-3.5" />
                    {r.health}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
