// Gamma SideSheet's reference-counted body lock, shared by nested Insights modals.
const locks = new WeakMap<HTMLElement, { count: number; overflow: string }>()

export function lockBodyScroll(body = document.body) {
  const lock = locks.get(body) ?? { count: 0, overflow: body.style.overflow }
  locks.set(body, lock)
  lock.count += 1
  body.style.overflow = "hidden"
  let released = false
  return () => {
    if (released) return
    released = true
    lock.count -= 1
    if (lock.count === 0) {
      body.style.overflow = lock.overflow
      locks.delete(body)
    }
  }
}
