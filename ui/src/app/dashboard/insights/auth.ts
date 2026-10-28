import { redirectToLogin } from "@/lib/session-request"

// Keep authentication navigation in the console host; embedded Insights clients
// can report an authentication failure without inheriting this login route.
export function redirectInsightsToLogin() {
  // The session manager has already resolved renewal and cleared only the
  // rejected session. Navigation must never erase a newer account's token.
  redirectToLogin()
}
