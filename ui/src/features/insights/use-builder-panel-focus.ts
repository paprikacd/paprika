import { useEffect, useRef } from "react"

/** Focus follows explicit panel/widget transitions, never typing or viewport changes. */
export function useBuilderPanelFocus(identity: string | null) {
  const panel = useRef<HTMLElement>(null)
  const previousIdentity = useRef<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (identity === previousIdentity.current) return
    const wasOpen = previousIdentity.current !== null
    previousIdentity.current = identity
    if (identity === null) {
      const target = opener.current
      opener.current = null
      if (
        target?.isConnected &&
        !target.closest("[inert]") &&
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
    const target = element.querySelector<HTMLElement>("h2") ?? element
    target.tabIndex = -1
    element.scrollTop = 0
    target.focus({ preventScroll: true })
    if (window.matchMedia("(max-width: 1100px)").matches)
      element.scrollIntoView?.({ block: "start", behavior: "auto" })
  }, [identity])
  return panel
}
