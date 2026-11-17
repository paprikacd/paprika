"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"

export const WORKSPACE_REFRESH_INTERVAL = 5_000

/** Refresh the shared authoring store without polling hidden tabs or overlapping requests. */
export function useWorkspaceRefresh(
  enabled: boolean,
  refresh: (signal: AbortSignal) => Promise<void>,
): string {
  const latestRefresh = useRef(refresh)
  useLayoutEffect(() => { latestRefresh.current = refresh }, [refresh])
  const [error, setError] = useState("")

  useEffect(() => {
    if (!enabled) return
    let active = true
    let controller: AbortController | undefined
    const run = async () => {
      if (!active || document.hidden || controller) return
      const request = new AbortController()
      controller = request
      try {
        await latestRefresh.current(request.signal)
        if (active && !request.signal.aborted) setError("")
      } catch (reason) {
        if (active && !request.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Workspace updates are unavailable. Retrying automatically.")
      } finally {
        if (controller === request) controller = undefined
      }
    }
    const onVisible = () => {
      if (document.hidden) controller?.abort()
      else void run()
    }
    const onFocus = () => { void run() }
    const timer = setInterval(() => { void run() }, WORKSPACE_REFRESH_INTERVAL)
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onFocus)
    return () => {
      active = false
      clearInterval(timer)
      controller?.abort()
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onFocus)
    }
  }, [enabled])

  return enabled ? error : ""
}
