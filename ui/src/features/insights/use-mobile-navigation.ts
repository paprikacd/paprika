import { useSyncExternalStore } from "react"

const query = "(max-width: 950px)"
/** The phone shell: a view of a dashboard on a phone-width viewport. Keyed to the viewport, not the measured canvas. */
export const PHONE_SHELL_QUERY = "(max-width: 600px)"

function subscribeTo(name: string) {
  return (listener: () => void) => {
    const media = window.matchMedia(name)
    media.addEventListener("change", listener)
    return () => media.removeEventListener("change", listener)
  }
}
const subscribe = subscribeTo(query)
const subscribePhone = subscribeTo(PHONE_SHELL_QUERY)

export function useMobileNavigation() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

export function usePhoneShell() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_SHELL_QUERY).matches, () => false)
}
