import { useEffect, useRef } from "react"

/**
 * Focus follows explicit panel/widget transitions, never typing or viewport changes.
 *
 * `ready` is false while the panel's lazy content is still a fallback. Focus waits for the content, so it lands on the
 * real heading (not the fallback's container) on the first open, as it does once the chunk is cached.
 */
export function useBuilderPanelFocus(identity: string | null, restoreTarget?: () => HTMLElement | null, ready = true) {
  const panel = useRef<HTMLElement>(null)
  const previousIdentity = useRef<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const awaitingContent = useRef(false)
  useEffect(() => {
    const changed = identity !== previousIdentity.current
    if (!changed && !(awaitingContent.current && ready)) return
    if (changed) {
      const wasOpen = previousIdentity.current !== null
      previousIdentity.current = identity
      awaitingContent.current = false
      if (identity === null) {
        const target = opener.current?.isConnected ? opener.current : restoreTarget?.()
        opener.current = null
        if (
          target?.isConnected &&
          !target.closest("[inert], [hidden]") &&
          !target.matches(":disabled")
        )
          target.focus()
        return
      }
      const element = panel.current
      if (!element) return
      const active = document.activeElement
      // Keep the original opener when a panel button opens another panel. If a
      // different canvas/header control opens it, restore that newer control.
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active.isConnected &&
        (!wasOpen || !element.contains(active))
      ) {
        opener.current = active
      }
    }
    const element = panel.current
    if (!element || identity === null) return
    if (!ready) {
      awaitingContent.current = true
      return
    }
    awaitingContent.current = false
    const target = element.querySelector<HTMLElement>("h2") ?? element
    target.tabIndex = -1
    element.scrollTop = 0
    target.focus({ preventScroll: true })
    if (window.matchMedia("(max-width: 1100px)").matches)
      element.scrollIntoView?.({ block: "start", behavior: "auto" })
  }, [identity, restoreTarget, ready])
  return panel
}
