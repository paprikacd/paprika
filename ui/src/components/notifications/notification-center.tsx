"use client"

import { useEffect, useRef, useState } from "react"
import { useConnection } from "@/lib/connection-context"
import { Bell, X, Check } from "lucide-react"

interface NotificationItem {
  id: string
  title: string
  body: string
  phase: string
  timestamp: string
}

const STORAGE_KEY = "paprika-notification-read-ids"

export function NotificationCenter() {
  const { events } = useConnection()
  const [open, setOpen] = useState(false)
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        setReadIds(new Set(JSON.parse(raw)))
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(readIds)))
  }, [readIds])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const notifications: NotificationItem[] = events
    .map((raw, idx) => {
      try {
        const data = JSON.parse(raw)
        const payload = data.payload || {}
        return {
          id: `${idx}-${payload.timestamp || raw}`,
          title: `${payload.namespace}/${payload.name}`,
          body: `${payload.resourceType} is now ${payload.phase}${payload.reason ? ` (${payload.reason})` : ""}`,
          phase: payload.phase || "",
          timestamp: data.timestamp || new Date().toISOString(),
        }
      } catch {
        return null
      }
    })
    .filter((n): n is NotificationItem => n !== null)
    .slice(-20)
    .reverse()

  const unreadCount = notifications.filter((n) => !readIds.has(n.id)).length

  const markAllRead = () => {
    setReadIds(new Set(notifications.map((n) => n.id)))
  }

  const clearAll = () => {
    setReadIds(new Set())
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Notifications"
      >
        <Bell className="size-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border bg-background p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Notifications</p>
            <div className="flex items-center gap-1">
              <button
                onClick={markAllRead}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Mark all read"
              >
                <Check className="size-4" />
              </button>
              <button
                onClick={clearAll}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {notifications.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">No notifications yet</p>
            )}
            {notifications.map((n) => {
              const isUnread = !readIds.has(n.id)
              return (
                <div
                  key={n.id}
                  onClick={() => setReadIds((prev) => new Set([...prev, n.id]))}
                  className={`cursor-pointer rounded-md border p-2 text-left transition-colors hover:bg-muted ${
                    isUnread ? "border-l-4 border-l-primary bg-primary/5" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium">{n.title}</p>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {new Date(n.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{n.body}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
