"use client"

type PointerPosition = { x: number; y: number; target: EventTarget | null }
type Viewport = { width: number; height: number; left?: number; top?: number }
let latest: PointerPosition | undefined
let users = 0

const remember = (event: PointerEvent) => {
  latest = event.pointerType === "touch" ? undefined : { x: event.clientX, y: event.clientY, target: event.target }
}
const forget = () => { latest = undefined }

/** Track input outside React rendering so the first hover can use its pointer.
 * Subscribers are reference-counted; no document listeners survive unmount. */
export function installTooltipPointerTracking() {
  if (typeof document === "undefined") return () => {}
  if (users++ === 0) {
    document.addEventListener("pointermove", remember, true)
    document.addEventListener("pointerdown", remember, true)
    document.addEventListener("keydown", forget, true)
    window.addEventListener("blur", forget)
  }
  return () => {
    if (--users === 0) {
      document.removeEventListener("pointermove", remember, true)
      document.removeEventListener("pointerdown", remember, true)
      document.removeEventListener("keydown", forget, true)
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

/** Prefer the lower-right quadrant, flip at viewport edges, and leave a 16px
 * pointer gap. Tall previews are capped rather than covering the pointer. */
export function placePointerTooltip(point: { x: number; y: number }, size: { width: number; height: number }, viewport: Viewport) {
  const margin = 12, gap = 16
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin
  const rightPosition = point.x + gap, leftPosition = point.x - gap - size.width
  const useRight = rightPosition + size.width <= right || leftPosition < left
  const x = Math.max(left, Math.min(useRight ? rightPosition : leftPosition, right - size.width))
  const above = Math.max(0, point.y - gap - top), below = Math.max(0, bottom - point.y - gap)
  const useBelow = size.height <= below || (size.height > above && below >= above)
  const maxHeight = Math.min(560, useBelow ? below : above)
  const y = useBelow ? point.y + gap : point.y - gap - Math.min(size.height, maxHeight)
  return { left: x, top: y, placement: `pointer-${useBelow ? "bottom" : "top"}-${useRight ? "right" : "left"}`, maxHeight }
}

/** Convert viewport placement into a transformed fixed portal's local space.
 * Ordinary body portals are unchanged; translated/scaled dialog ancestors are
 * corrected from measured geometry without assuming iframe/page offsets. */
export function correctPortalPosition(position: { left: number; top: number }, actual: { left: number; top: number; width: number; height: number }, layout: { width: number; height: number }) {
  if (actual.width <= 0 || actual.height <= 0 || layout.width <= 0 || layout.height <= 0) return position
  const scaleX = actual.width / layout.width, scaleY = actual.height / layout.height
  return { left: position.left + (position.left - actual.left) / scaleX, top: position.top + (position.top - actual.top) / scaleY }
}
