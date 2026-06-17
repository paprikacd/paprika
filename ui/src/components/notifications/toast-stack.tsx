"use client"

import { useEffect, useState } from "react"
import { useConnection } from "@/lib/connection-context"
import { X, Bell, AlertTriangle, CheckCircle2, Info } from "lucide-react"

const icons: Record<string, typeof Info> = {
  Failed: AlertTriangle,
  Degraded: AlertTriangle,
  RolledBack: AlertTriangle,
  Complete: CheckCircle2,
}

export function ToastStack() {
  const { events } = useConnection()
  const [toasts, setToasts] = useState<{ id: number; title: string; body: string; phase: string }[]>([])

  useEffect(() => {
    if (events.length === 0) return
    const last = events[events.length - 1]
    let data
    try { data = JSON.parse(last) } catch { return }
    const phase = data.payload?.phase
    if (!["Failed", "Degraded", "RolledBack", "Complete"].includes(phase)) return
    const payload = data.payload
    const title = `${payload.namespace}/${payload.name}`
    const body = `${payload.resourceType} is now ${phase}${payload.reason ? ` (${payload.reason})` : ""}`
    const id = Date.now()
    setToasts((prev) => [...prev.slice(-4), { id, title, body, phase }])
    const t = setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000)
    return () => clearTimeout(t)
  }, [events])

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => {
        const Icon = icons[t.phase] || Info
        return (
          <div key={t.id} className="flex w-80 items-start gap-3 rounded-lg border bg-background p-3 shadow-lg">
            <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              <p className="text-xs text-muted-foreground">{t.body}</p>
            </div>
            <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
              <X className="size-4 text-muted-foreground" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
