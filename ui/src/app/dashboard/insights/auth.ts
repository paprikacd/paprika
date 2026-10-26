import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from "@/lib/auth-context"
import { safeAuthReturnTo } from "@/lib/auth-return-to"
import { clearBrowserQueryCache } from "@/lib/query-provider"

// Keep authentication navigation in the console host; embedded Insights clients
// can report an authentication failure without inheriting this login route.
export function redirectInsightsToLogin() {
  const destination = safeAuthReturnTo(
    window.location.pathname + window.location.search + window.location.hash,
  )
  if (destination) localStorage.setItem("paprika_return_to", destination)
  else localStorage.removeItem("paprika_return_to")
  clearBrowserQueryCache()
  localStorage.removeItem(AUTH_TOKEN_KEY)
  localStorage.removeItem(AUTH_USER_KEY)
  window.location.href = "/login/"
}
