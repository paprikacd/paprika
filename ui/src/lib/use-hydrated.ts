"use client"

import { useSyncExternalStore } from "react"

const noSubscription = () => () => {}

/**
 * False for the server render and the hydrating client render, true after.
 * Gate anything read from browser storage on it so the first client render
 * matches the static frame exactly.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false)
}
