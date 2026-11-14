"use client"

import { placePointerPosition } from "./tooltip-position"

type PointerPosition = { x: number; y: number; target: EventTarget | null }
type Viewport = { width: number; height: number; left?: number; top?: number }
let latest: PointerPosition | undefined
let users = 0
let keyboardActive = false

const remember = (event: PointerEvent) => {
  latest = keyboardActive || event.pointerType === "touch" ? undefined : { x: event.clientX, y: event.clientY, target: event.target }
}
const forget = () => { latest = undefined; keyboardActive = false }
const move = (event: PointerEvent) => { keyboardActive = false; remember(event) }
// Layout changes can emit pointerover without motion. Keyboard inspection must
// keep its placement until an actual move or press returns control to the mouse.
const keyboard = () => { forget(); keyboardActive = true }

/** Removing a pinned panel can expose a mark under a stationary pointer. */
export const isTooltipHoverSuppressed = () => keyboardActive

/** Track input outside React rendering so the first hover can use its pointer.
 * Subscribers are reference-counted; no document listeners survive unmount. */
export function installTooltipPointerTracking() {
  if (typeof document === "undefined") return () => {}
  if (users++ === 0) {
    // pointerover precedes React pointer-enter and may be the only event
    // when scrolling brings a mark under a stationary cursor.
    document.addEventListener("pointerover", remember, true)
    document.addEventListener("pointermove", move, true)
    document.addEventListener("pointerdown", move, true)
    document.addEventListener("keydown", keyboard, true)
    window.addEventListener("blur", forget)
  }
  return () => {
    if (--users === 0) {
      document.removeEventListener("pointerover", remember, true)
      document.removeEventListener("pointermove", move, true)
      document.removeEventListener("pointerdown", move, true)
      document.removeEventListener("keydown", keyboard, true)
      window.removeEventListener("blur", forget)
      forget()
    }
  }
}

/** Only use a pointer currently over this anchor, including after scrolling. */
export function pointerOverAnchor(anchor: Element) {
  if (!latest || !(latest.target instanceof Node) || !anchor.contains(latest.target)) return undefined
  const bounds = anchor.getBoundingClientRect()
  return latest.x >= bounds.left && latest.x <= bounds.right && latest.y >= bounds.top && latest.y <= bounds.bottom ? latest : undefined
}

/** Compatibility entry point; all pointer placement uses the shared owner. */
export function placePointerTooltip(point: { x: number; y: number }, size: { width: number; height: number }, viewport: Viewport) {
  return placePointerPosition(point, size, viewport)
}

/** Convert viewport placement into a transformed fixed portal's local space.
 * Ordinary body portals are unchanged; translated/scaled dialog ancestors are
 * corrected from measured geometry without assuming iframe/page offsets. */
export function correctPortalPosition(position: { left: number; top: number }, actual: { left: number; top: number; width: number; height: number }, layout: { width: number; height: number }, origin = { x: 0, y: 0 }) {
  if (actual.width <= 0 || actual.height <= 0 || layout.width <= 0 || layout.height <= 0) return position
  const scaleX = actual.width / layout.width, scaleY = actual.height / layout.height
  return { left: position.left + (position.left - actual.left - actual.width * origin.x) / scaleX, top: position.top + (position.top - actual.top - actual.height * origin.y) / scaleY }
}
