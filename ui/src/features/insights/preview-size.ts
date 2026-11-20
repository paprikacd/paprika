"use client"

import { useState } from "react"

/**
 * How the chart editor's preview sizes its tile. Fill uses the whole preview pane. Dashboard size and Compact view draw
 * the tile at the footprint it has on the dashboard, in the standard or the dense viewing grid.
 */
export type PreviewSize = "fill" | "dashboard" | "compact"

export const PREVIEW_SIZE_KEY = "paprika-insights-preview-size"
export const PREVIEW_SIZES: readonly PreviewSize[] = ["fill", "dashboard", "compact"]

/** The viewer's remembered choice. It is a viewing preference, so it is never written to a dashboard document. */
export function readPreviewSize(): PreviewSize {
  try {
    const stored = window.localStorage.getItem(PREVIEW_SIZE_KEY)
    return PREVIEW_SIZES.find(size => size === stored) ?? "fill"
  } catch {
    return "fill"
  }
}

export function writePreviewSize(size: PreviewSize): void {
  try {
    window.localStorage.setItem(PREVIEW_SIZE_KEY, size)
  } catch {
    // Storage can be blocked; the choice then lasts for this editor only.
  }
}

/** The preview size, remembered per viewer. Fill is the default, so the largest useful area stays the first view. */
export function usePreviewSize(): [PreviewSize, (size: PreviewSize) => void] {
  const [size, setSize] = useState<PreviewSize>(() => (typeof window === "undefined" ? "fill" : readPreviewSize()))
  const choose = (next: PreviewSize) => {
    writePreviewSize(next)
    setSize(next)
  }
  return [size, choose]
}
