import type { Layout, LayoutItem } from "react-grid-layout"
import type { Widget } from "./schema"

/** Columns in the saved grid. Matches the canvas and the widget schema. */
export const GRID_COLUMNS = 12

export type LayoutMove = "left" | "right" | "up" | "down"

/**
 * The settled layout, or why the widget cannot move or resize that way. `partner` is the widget it moved past, and
 * `passed` is every widget that moved with it (the partner included), in reading order.
 */
export type LayoutEdit = { layout: Layout; partner?: string; passed?: string[] } | { blocked: string }

interface Box { x: number; y: number; w: number; h: number }

export const LAYOUT_KEYSHORTCUTS = "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"

const MOVE_KEYS = new Map<string, LayoutMove>([["ArrowLeft", "left"], ["ArrowRight", "right"], ["ArrowUp", "up"], ["ArrowDown", "down"]])
const RESIZE_KEYS = new Map<string, readonly [number, number]>([["ArrowLeft", [-1, 0]], ["ArrowRight", [1, 0]], ["ArrowUp", [0, -1]], ["ArrowDown", [0, 1]]])

/** Alt+Arrow moves a widget one column, or one row through the flow. */
export function layoutMoveForKey(key: string): LayoutMove | undefined {
  return MOVE_KEYS.get(key)
}

/** Alt+Shift+Arrow changes a widget's width or height by one step: [dw, dh]. */
export function layoutResizeForKey(key: string): readonly [number, number] | undefined {
  return RESIZE_KEYS.get(key)
}

/** The saved document positions as grid items. */
export function savedLayout(widgets: readonly Pick<Widget, "id" | "layout">[]): Layout {
  return widgets.map((widget) => ({ i: widget.id, x: widget.layout.x, y: widget.layout.y, w: widget.layout.w, h: widget.layout.h }))
}

/** A widget's place in words, for announcements: "row 2, columns 1 to 6". */
export function gridPlacement(box: Box): string {
  const columns = box.w === 1 ? `column ${box.x + 1}` : `columns ${box.x + 1} to ${box.x + box.w}`
  return `row ${box.y + 1}, ${columns}`
}

/**
 * Why each Layout-tab move is unavailable. The inspector edits the saved grid, not the projection on screen, so it is
 * offered at every canvas width; only the saved arrangement's own edges and neighbours block a move.
 */
export function layoutMoveBlockers(widgets: readonly Pick<Widget, "id" | "layout">[], id: string): Partial<Record<LayoutMove, string>> {
  const layout = savedLayout(widgets)
  const blockers: Partial<Record<LayoutMove, string>> = {}
  for (const move of ["left", "right", "up", "down"] as const) {
    const edit = moveLayout(layout, id, move)
    if ("blocked" in edit) blockers[move] = edit.blocked
  }
  return blockers
}

/** Columns share at least one grid column. */
function sharesColumns(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

/** Reading order of the saved layout: top to bottom, then left to right, with the id breaking exact ties. */
function readingOrder(a: LayoutItem, b: LayoutItem): number {
  return a.y - b.y || a.x - b.x || (a.i < b.i ? -1 : a.i > b.i ? 1 : 0)
}

/**
 * Settles every widget in column flow. `id` takes `target`, and it sits after the widgets in `passed` that
 * it moved past (on the same side they were saved on) and before the others. Each widget then rests at the
 * lowest row below every earlier widget in its columns, so the result is already stable under the vertical
 * compactor: a swapped widget does not snap back.
 */
function arrange(layout: Layout, id: string, target: Box, passed: ReadonlySet<string>): Layout {
  const order = [...layout].sort(readingOrder)
  const rank = new Map(order.map((item, index) => [item.i, index]))
  const rankOf = (key: string) => rank.get(key) ?? 0
  const later = new Map<string, string[]>(layout.map((item) => [item.i, []]))
  const waiting = new Map<string, number>(layout.map((item) => [item.i, 0]))
  const before = (first: string, second: string) => {
    later.get(first)!.push(second)
    waiting.set(second, waiting.get(second)! + 1)
  }
  for (let p = 0; p < order.length; p++) {
    for (let q = p + 1; q < order.length; q++) {
      const a = order[p]
      const b = order[q]
      if (a.i !== id && b.i !== id && sharesColumns(a, b)) before(a.i, b.i)
    }
  }
  for (const other of layout) {
    if (other.i === id || !sharesColumns(other, target)) continue
    const below = rankOf(other.i) > rankOf(id)
    if (below === passed.has(other.i)) before(other.i, id)
    else before(id, other.i)
  }
  const sizes = new Map<string, Box>(layout.map((item) => [item.i, item.i === id ? target : item]))
  const remaining = new Set(order.map((item) => item.i))
  const settled = new Map<string, Box>()
  const placed: Box[] = []
  while (remaining.size) {
    const ready = [...remaining].filter((key) => waiting.get(key) === 0)
    // Overlapping saved widgets never disagree about their order, so a cycle cannot form. Keep the saved order if one did.
    const key = (ready.length ? ready : [...remaining]).sort((a, b) => rankOf(a) - rankOf(b))[0]
    remaining.delete(key)
    for (const next of later.get(key)!) waiting.set(next, waiting.get(next)! - 1)
    const box = sizes.get(key)!
    let y = 0
    for (const other of placed) if (sharesColumns(other, box)) y = Math.max(y, other.y + other.h)
    const at = { x: box.x, y, w: box.w, h: box.h }
    placed.push(at)
    settled.set(key, at)
  }
  return layout.map((item) => ({ ...item, ...settled.get(item.i)! }))
}

/** The nearest widget above or below `subject` that shares its columns, in reading order. */
function neighbour(layout: Layout, subject: LayoutItem, move: "up" | "down"): LayoutItem | undefined {
  const side = move === "down" ? 1 : -1
  let nearest: LayoutItem | undefined
  for (const item of layout) {
    if (item.i === subject.i || !sharesColumns(item, subject) || Math.sign(readingOrder(item, subject)) !== side) continue
    if (!nearest || Math.sign(readingOrder(item, nearest)) === -side) nearest = item
  }
  return nearest
}

/**
 * The widgets an up or down move passes: the partner, plus each other widget in the subject's columns that lies on
 * the same side and in the same band. Moving down, that band is every widget starting above the partner's bottom
 * edge. Moving up, it is every widget still reaching below the partner's top edge. The band moves as one, so a row
 * of widgets never splits.
 */
function passedBand(layout: Layout, subject: LayoutItem, partner: LayoutItem, move: "up" | "down"): string[] {
  const side = move === "down" ? 1 : -1
  return layout
    .filter((item) => item.i === partner.i || (item.i !== subject.i && sharesColumns(item, subject) && Math.sign(readingOrder(item, subject)) === side
      && (move === "down" ? item.y < partner.y + partner.h : item.y + item.h > partner.y)))
    .sort(readingOrder)
    .map((item) => item.i)
}

/**
 * Moves a widget one column left or right, or moves it past the nearest widget above or below that shares its
 * columns, along with the band that widget belongs to (see `passedBand`). Blocked moves name the reason, so a
 * control can show it instead of doing nothing.
 */
export function moveLayout(layout: Layout, id: string, move: LayoutMove): LayoutEdit {
  const subject = layout.find((item) => item.i === id)
  if (!subject) return { blocked: "This widget is not on the canvas" }
  if (move === "up" || move === "down") {
    const partner = neighbour(layout, subject, move)
    if (!partner) return { blocked: move === "down" ? "Nothing below this widget in its columns" : "Nothing above this widget in its columns" }
    const passed = passedBand(layout, subject, partner, move)
    return { layout: arrange(layout, id, subject, new Set(passed)), partner: partner.i, passed }
  }
  const x = subject.x + (move === "left" ? -1 : 1)
  if (x < 0) return { blocked: "Already at the left edge of the canvas" }
  if (x + subject.w > GRID_COLUMNS) return { blocked: "Already at the right edge of the canvas" }
  return { layout: arrange(layout, id, { ...subject, x }, new Set()) }
}

/** Widens or heightens (or narrows and shortens) a widget by whole grid steps, within its size limits. */
export function resizeLayout(layout: Layout, id: string, dw: number, dh: number): LayoutEdit {
  const subject = layout.find((item) => item.i === id)
  if (!subject) return { blocked: "This widget is not on the canvas" }
  const w = subject.w + dw
  const h = subject.h + dh
  if (w > Math.min(subject.maxW ?? GRID_COLUMNS, GRID_COLUMNS - subject.x)) return { blocked: "Already reaches the right edge of the canvas" }
  if (w < (subject.minW ?? 1)) return { blocked: `Already at the minimum width of ${subject.minW ?? 1} ${(subject.minW ?? 1) === 1 ? "column" : "columns"}` }
  if (h > (subject.maxH ?? GRID_COLUMNS)) return { blocked: `Already at the maximum height of ${subject.maxH ?? GRID_COLUMNS} rows` }
  if (h < (subject.minH ?? 1)) return { blocked: `Already at the minimum height of ${subject.minH ?? 1} ${(subject.minH ?? 1) === 1 ? "row" : "rows"}` }
  return { layout: arrange(layout, id, { x: subject.x, y: subject.y, w, h }, new Set()) }
}

/**
 * The layout while `id` is dragged to `at`. Crossing another widget's vertical midpoint, in the drag direction and
 * within its columns, moves the dragged widget past it. Anything else keeps the saved order, so a drop into
 * empty space still compacts upward.
 */
export function dragLayout(layout: Layout, id: string, at: Box): Layout {
  const subject = layout.find((item) => item.i === id)
  if (!subject) return layout
  const passed = new Set<string>()
  for (const item of layout) {
    if (item.i === id || !sharesColumns(item, at)) continue
    const midpoint = item.y + item.h / 2
    const side = readingOrder(item, subject)
    if (at.y > subject.y && side > 0 && at.y >= midpoint) passed.add(item.i)
    if (at.y < subject.y && side < 0 && at.y <= midpoint) passed.add(item.i)
  }
  return arrange(layout, id, at, passed)
}

/**
 * The compactor's answer while `id` is dragged, for react-grid-layout's preview and its drop. It keeps the grid's
 * own items (and their size limits) and replaces only their positions.
 */
export function dragSettle(saved: Layout, items: Layout, id: string): Layout {
  const dragged = items.find((item) => item.i === id)
  if (!dragged || !saved.some((item) => item.i === id)) return items
  const settled = new Map(dragLayout(saved, id, dragged).map((item) => [item.i, item]))
  return items.map((item) => {
    const next = settled.get(item.i)
    return next ? { ...item, x: next.x, y: next.y, w: next.w, h: next.h, moved: false } : item
  })
}
