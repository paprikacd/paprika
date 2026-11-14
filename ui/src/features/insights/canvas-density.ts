"use client"

import { useSyncExternalStore } from "react"

export const CANVAS_DENSITY_KEY = "paprika-insights-compact-view"
const changeEvent = "paprika-insights-compact-view-change"
let fallback = false

function getSnapshot() {
  try { return window.localStorage.getItem(CANVAS_DENSITY_KEY) === "true" }
  catch { return fallback }
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener(changeEvent, listener)
  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener(changeEvent, listener)
  }
}

/** Local viewing preference; it is deliberately absent from dashboard documents. */
export function useCanvasDensity() {
  const dense = useSyncExternalStore(subscribe, getSnapshot, () => false)
  const setDense = (next: boolean) => {
    fallback = next
    try { window.localStorage.setItem(CANVAS_DENSITY_KEY, String(next)) } catch { /* Keep the preference for this session. */ }
    window.dispatchEvent(new Event(changeEvent))
  }
  return { dense, setDense }
}
