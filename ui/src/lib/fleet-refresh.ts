"use client"

import { useCallback, useEffect, useRef } from "react"

export const FLEET_REFRESH_INTERVAL_MS = 60_000
export const FOCUSED_REFRESH_INTERVAL_MS = 15_000
export const MAX_REFRESH_INTERVAL_MS = 120_000

export interface RefreshOptions {
  enabled?: boolean
  onRequestOutcome?: (succeeded: boolean) => void
  refreshOnMount?: boolean
}

export interface BoundedRefreshOptions extends RefreshOptions {
  intervalMs: number
  maxIntervalMs?: number
}

function isPageHidden() {
  return document.visibilityState === "hidden"
}

export function useBoundedRefresh(
  refresh: () => Promise<unknown> | unknown,
  {
    enabled = true,
    intervalMs,
    maxIntervalMs = MAX_REFRESH_INTERVAL_MS,
    onRequestOutcome,
    refreshOnMount = true,
  }: BoundedRefreshOptions
) {
  const refreshRef = useRef(refresh)
  const outcomeRef = useRef(onRequestOutcome)

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    outcomeRef.current = onRequestOutcome
  }, [onRequestOutcome])

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let running = false
    let failureCount = 0
    let timer: number | null = null

    const clearTimer = () => {
      if (timer === null) return
      window.clearTimeout(timer)
      timer = null
    }

    const nextDelay = () =>
      Math.min(maxIntervalMs, intervalMs * 2 ** failureCount)

    const schedule = (delay: number) => {
      clearTimer()
      if (disposed || isPageHidden()) return
      timer = window.setTimeout(() => {
        timer = null
        void runRefresh()
      }, delay)
    }

    async function runRefresh() {
      if (disposed || running || isPageHidden()) return
      clearTimer()
      running = true
      let succeeded = false

      try {
        await refreshRef.current()
        failureCount = 0
        succeeded = true
      } catch {
        failureCount += 1
      } finally {
        try {
          outcomeRef.current?.(succeeded)
        } finally {
          running = false
          schedule(nextDelay())
        }
      }
    }

    const handleVisibilityChange = () => {
      if (isPageHidden()) {
        clearTimer()
        return
      }
      schedule(nextDelay())
    }

    const handleFocus = () => {
      if (isPageHidden()) return
      clearTimer()
      void runRefresh()
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("focus", handleFocus)
    if (refreshOnMount) void runRefresh()
    else schedule(intervalMs)

    return () => {
      disposed = true
      clearTimer()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("focus", handleFocus)
    }
  }, [enabled, intervalMs, maxIntervalMs, refreshOnMount])
}

export function useFleetRefresh(
  refresh: () => Promise<unknown> | unknown,
  options: RefreshOptions = {}
) {
  useBoundedRefresh(refresh, {
    ...options,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })
}

export function useFocusedRefresh(
  refresh: () => Promise<unknown> | unknown,
  options: RefreshOptions = {}
) {
  useBoundedRefresh(refresh, {
    ...options,
    intervalMs: FOCUSED_REFRESH_INTERVAL_MS,
  })
}

/**
 * Gives scheduled, focus, and operator-triggered refreshes one shared in-flight
 * operation so an older response cannot race a newer request into the UI.
 */
export function useSingleFlightRefresh(
  refresh: () => Promise<unknown> | unknown,
): () => Promise<void> {
  const refreshRef = useRef(refresh)
  const activeRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  return useCallback(() => {
    if (activeRef.current) return activeRef.current

    const request = Promise.resolve()
      .then(() => refreshRef.current())
      .then(() => undefined)
    activeRef.current = request
    void request
      .finally(() => {
        if (activeRef.current === request) activeRef.current = null
      })
      .catch(() => {})
    return request
  }, [])
}
