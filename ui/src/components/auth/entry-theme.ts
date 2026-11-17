"use client"

import { useSyncExternalStore } from "react"

function subscribe(listener: () => void) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)")
  media?.addEventListener("change", listener)
  window.addEventListener("storage", listener)
  window.addEventListener("paprika-insights-theme-change", listener)
  return () => {
    media?.removeEventListener("change", listener)
    window.removeEventListener("storage", listener)
    window.removeEventListener("paprika-insights-theme-change", listener)
  }
}
function preference(): "light" | "dark" {
  try {
    const saved = window.localStorage.getItem("paprika-insights-theme")
    if (saved === "light" || saved === "dark") return saved
  } catch { /* System appearance works without local storage. */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}
const serverPreference = () => "system" as const
export function useEntryTheme() { return useSyncExternalStore(subscribe, preference, serverPreference) }
