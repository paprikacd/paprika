"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"

/**
 * The six boards, in the fixed order the overview reads. Hiding is the only
 * layout customisation — there is no drag-reorder — so the order is a constant
 * rather than state.
 */
export const BOARD_IDS = [
  "lifecycle",
  "posture",
  "attention",
  "inflight",
  "triggers",
  "clusters",
] as const

export type BoardId = (typeof BOARD_IDS)[number]

export interface BoardDefinition {
  id: BoardId
  index: string
  /** Short name used on the customise chips. */
  chip: string
  /** Full board title, also used to name its collapse and hide controls. */
  title: string
}

export const BOARD_DEFINITIONS: readonly BoardDefinition[] = [
  {
    id: "lifecycle",
    index: "01",
    chip: "Lifecycle",
    title: "Application lifecycle",
  },
  { id: "posture", index: "02", chip: "Health posture", title: "Health posture" },
  {
    id: "attention",
    index: "03",
    chip: "Needs attention",
    title: "Needs attention",
  },
  { id: "inflight", index: "04", chip: "Rollouts", title: "Rollouts" },
  { id: "triggers", index: "05", chip: "Source triggers", title: "Source triggers" },
  {
    id: "clusters",
    index: "06",
    chip: "Clusters · capacity",
    title: "Clusters · capacity",
  },
]

export type PostureFormat = "bars" | "heatmap"
export type RolloutTab = "inflight" | "recent"
export type HeatGroup = "none" | "project" | "cluster" | "stage" | "namespace"
export type HeatDetail = "full" | "name" | "compact"

export interface OverviewLayout {
  hidden: readonly BoardId[]
  collapsed: readonly BoardId[]
  postureFormat: PostureFormat
  rolloutTab: RolloutTab
  heatGroup: HeatGroup
  heatDetail: HeatDetail
}

export const DEFAULT_LAYOUT: OverviewLayout = {
  hidden: [],
  collapsed: [],
  postureFormat: "heatmap",
  rolloutTab: "inflight",
  heatGroup: "project",
  heatDetail: "full",
}

const STORAGE_KEY = "paprika.overview.layout"

function isBoardId(value: unknown): value is BoardId {
  return BOARD_IDS.includes(value as BoardId)
}

/**
 * Parses whatever is in storage back into a layout. Anything unrecognised is
 * dropped rather than trusted — a board id that no longer exists must not be
 * able to hide a board that does.
 */
export function parseLayout(raw: string | null): OverviewLayout {
  if (!raw) return DEFAULT_LAYOUT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_LAYOUT
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_LAYOUT
  const value = parsed as Partial<Record<keyof OverviewLayout, unknown>>
  return {
    hidden: Array.isArray(value.hidden) ? value.hidden.filter(isBoardId) : [],
    collapsed: Array.isArray(value.collapsed)
      ? value.collapsed.filter(isBoardId)
      : [],
    postureFormat:
      value.postureFormat === "bars" || value.postureFormat === "heatmap"
        ? value.postureFormat
        : DEFAULT_LAYOUT.postureFormat,
    rolloutTab:
      value.rolloutTab === "recent" || value.rolloutTab === "inflight"
        ? value.rolloutTab
        : DEFAULT_LAYOUT.rolloutTab,
    heatGroup:
      value.heatGroup === "none" ||
      value.heatGroup === "project" ||
      value.heatGroup === "cluster" ||
      value.heatGroup === "stage" ||
      value.heatGroup === "namespace"
        ? value.heatGroup
        : DEFAULT_LAYOUT.heatGroup,
    heatDetail:
      value.heatDetail === "full" ||
      value.heatDetail === "name" ||
      value.heatDetail === "compact"
        ? value.heatDetail
        : DEFAULT_LAYOUT.heatDetail,
  }
}

export interface OverviewLayoutController {
  layout: OverviewLayout
  isHidden: (id: BoardId) => boolean
  isOpen: (id: BoardId) => boolean
  toggleHidden: (id: BoardId) => void
  hide: (id: BoardId) => void
  toggleCollapsed: (id: BoardId) => void
  set: (patch: Partial<OverviewLayout>) => void
  reset: () => void
}

/**
 * Board layout is a per-operator preference, not fleet state, so it lives in
 * local storage rather than the URL — the URL is reserved for scope, which is
 * shareable.
 *
 * Storage is read through an external store rather than an effect so that the
 * statically exported HTML and the first client render agree: the server
 * snapshot is always the default layout, and the stored one arrives as a
 * normal store update.
 */
const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cached: OverviewLayout = DEFAULT_LAYOUT

function readStoredLayout(): OverviewLayout {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cached = parseLayout(raw)
  }
  return cached
}

function serverLayout(): OverviewLayout {
  return DEFAULT_LAYOUT
}

function subscribeToLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeLayout(next: OverviewLayout) {
  cached = next
  cachedRaw = JSON.stringify(next)
  try {
    window.localStorage.setItem(STORAGE_KEY, cachedRaw)
  } catch {
    // A browser that refuses storage still gets a working session.
  }
  for (const listener of listeners) listener()
}

export function useOverviewLayout(): OverviewLayoutController {
  const layout = useSyncExternalStore(
    subscribeToLayout,
    readStoredLayout,
    serverLayout
  )

  const set = useCallback((patch: Partial<OverviewLayout>) => {
    writeLayout({ ...readStoredLayout(), ...patch })
  }, [])

  const toggleIn = useCallback((key: "hidden" | "collapsed", id: BoardId) => {
    const current = readStoredLayout()
    const list = current[key]
    writeLayout({
      ...current,
      [key]: list.includes(id)
        ? list.filter((entry) => entry !== id)
        : [...list, id],
    })
  }, [])

  return useMemo(
    () => ({
      layout,
      isHidden: (id) => layout.hidden.includes(id),
      isOpen: (id) => !layout.collapsed.includes(id),
      toggleHidden: (id) => toggleIn("hidden", id),
      hide: (id) => {
        const current = readStoredLayout()
        if (current.hidden.includes(id)) return
        writeLayout({ ...current, hidden: [...current.hidden, id] })
      },
      toggleCollapsed: (id) => toggleIn("collapsed", id),
      set,
      reset: () => writeLayout(DEFAULT_LAYOUT),
    }),
    [layout, set, toggleIn]
  )
}
