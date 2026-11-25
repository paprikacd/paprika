"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { insightsEmbedHref } from "@/lib/insights-link"

// One dashboard grid row is 58 px plus a 16 px gap; the frame adds the embed's Open dashboard line.
const ROW_PX = 74
const GAP_PX = 16
const LINK_LINE_PX = 28
const DEFAULT_ROWS = 3
const MIN_HEIGHT_PX = 120
const MAX_HEIGHT_PX = 560
/** How long the frame may take to load, once it is near the viewport, before the page offers a retry. */
export const FRAME_TIMEOUT_MS = 20_000

/** The frame height for a widget of this many grid rows, so the tile has the height it has on its dashboard. */
export function frameHeight(rows: number | undefined): number {
  const h = rows && rows > 0 ? rows : DEFAULT_ROWS
  return Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, h * ROW_PX - GAP_PX + LINK_LINE_PX))
}

/** True when the frame holds the Insights page. A refused or failed frame holds an error page the host cannot read. */
function framedInsights(frame: HTMLIFrameElement): boolean {
  try {
    return /\/dashboard\/insights\/?$/.test(frame.contentWindow?.location.pathname ?? "")
  } catch {
    return false
  }
}

/**
 * The summary widget of a dashboard that covers the application: the Insights page in embed mode, in a same-origin
 * frame. The console loads no Insights code; the frame shares the session through same-origin storage.
 */
export function ApplicationInsightsWidget({
  dashboardId,
  widgetId,
  variables,
  rows,
  title,
  href,
}: {
  dashboardId: string
  widgetId: string
  variables: Record<string, string>
  /** The widget's saved height in grid rows. */
  rows?: number
  /** The dashboard title, for the frame's accessible name. */
  title: string
  /** The Insights link to the whole dashboard. */
  href: string
}) {
  // The console has one, light appearance; the tile matches it, not the Insights preference.
  const path = insightsEmbedHref(dashboardId, widgetId, variables, "light")
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ attempt: number; status: "ready" | "failed" }>()
  const status = state?.attempt === attempt ? state.status : "loading"
  // A lazy frame starts loading only near the viewport, so the timeout starts there too.
  const box = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const element = box.current
    if (!element || near || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { rootMargin: "100% 0px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])
  useEffect(() => {
    if (!path || !near || status !== "loading") return
    const timer = setTimeout(() => setState({ attempt, status: "failed" }), FRAME_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [path, near, attempt, status])
  if (!path) return null
  const height = frameHeight(rows)
  return (
    <div ref={box} className="relative w-full" style={{ height }}>
      {status !== "failed" ? (
        <iframe
          key={attempt}
          src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`}
          title={`${title}: summary widget`}
          loading="lazy"
          className={`block h-full w-full border-0 ${status === "loading" ? "invisible" : ""}`}
          onLoad={(event) => setState({ attempt, status: framedInsights(event.currentTarget) ? "ready" : "failed" })}
        />
      ) : null}
      {status === "loading" ? (
        <p role="status" className="absolute inset-0 flex items-center justify-center text-note text-muted-foreground">
          Loading metrics…
        </p>
      ) : null}
      {status === "failed" ? (
        <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 border border-rule px-4 text-center text-note">
          <p>The metrics widget did not load.</p>
          <p className="flex gap-4">
            <button type="button" className="cursor-pointer underline" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
            <Link href={href} className="underline">Open dashboard</Link>
          </p>
        </div>
      ) : null}
    </div>
  )
}
