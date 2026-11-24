import { createInsightsClient } from "@/features/insights/client"
import { redirectInsightsToLogin } from "@/app/dashboard/insights/auth"
import { clearRejectedSession, ensureValidSession, getSessionSnapshot, recoverUnauthorized } from "@/lib/browser-session"

/** The console's Insights client. The Insights page and embedded widgets share it, so both use one sign-in. */
export const consoleInsightsClient = createInsightsClient(
  "/api/insights",
  () => getSessionSnapshot().idToken,
  redirectInsightsToLogin,
  {
    ensureToken: ensureValidSession,
    recoverUnauthorized,
    clearRejectedSession,
    identity: () => JSON.stringify([getSessionSnapshot().identityKey, getSessionSnapshot().identityEpoch]),
  },
)
