import { useSyncExternalStore } from "react"

const query = "(max-width: 950px)"
function subscribe(listener: () => void) {
  const media = window.matchMedia(query)
  media.addEventListener("change", listener)
  return () => media.removeEventListener("change", listener)
}

export function useMobileNavigation() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}
