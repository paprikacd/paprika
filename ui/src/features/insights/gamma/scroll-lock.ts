// Gamma SideSheet's reference-counted body lock, shared by nested Insights modals.
interface ScrollLock {
  count: number
  overflow: string
  overflowPriority: string
  paddingRight?: { value: string; priority: string }
}

const locks = new WeakMap<HTMLElement, ScrollLock>()

export function lockBodyScroll(body = document.body) {
  let lock = locks.get(body)
  if (!lock) {
    lock = {
      count: 0,
      overflow: body.style.overflow,
      overflowPriority: body.style.getPropertyPriority("overflow"),
    }
    locks.set(body, lock)
    const document = body.ownerDocument
    const view = document.defaultView
    const locksViewport = body === document.body && view !== null
    const widthBefore = locksViewport ? document.documentElement.clientWidth : 0
    const paddingBefore = locksViewport ? Number.parseFloat(view.getComputedStyle(body).paddingRight) : 0
    body.style.setProperty("overflow", "hidden", lock.overflowPriority)
    // Removing a classic viewport scrollbar can cross a canvas breakpoint and
    // remount queries. Preserve the content width, measuring the actual change
    // so an already reserved scrollbar gutter is not compensated a second time.
    const removedGutter = locksViewport ? document.documentElement.clientWidth - widthBefore : 0
    if (removedGutter > 0 && Number.isFinite(paddingBefore)) {
      lock.paddingRight = {
        value: body.style.paddingRight,
        priority: body.style.getPropertyPriority("padding-right"),
      }
      body.style.setProperty("padding-right", `${paddingBefore + removedGutter}px`, "important")
    }
  }
  lock.count += 1
  let released = false
  return () => {
    if (released) return
    released = true
    lock.count -= 1
    if (lock.count === 0) {
      body.style.setProperty("overflow", lock.overflow, lock.overflowPriority)
      if (lock.paddingRight) {
        body.style.setProperty("padding-right", lock.paddingRight.value, lock.paddingRight.priority)
      }
      locks.delete(body)
    }
  }
}
