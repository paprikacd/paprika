import { safeAuthReturnTo } from "./auth-return-to"
import { clearRejectedSession, ensureValidSession, getSessionSnapshot, recoverUnauthorized } from "./browser-session"

export function redirectToLogin() {
  if (typeof window === "undefined") return
  // The initiating tab must finish clearing the HttpOnly cookie before a hard
  // navigation can cancel its logout request or its wait for the refresh lock.
  if (getSessionSnapshot().logoutPending) return
  const destination = safeAuthReturnTo(window.location.pathname + window.location.search + window.location.hash)
  try {
    if (destination) localStorage.setItem("paprika_return_to", destination)
    else localStorage.removeItem("paprika_return_to")
  } catch { /* Navigation still works when browser storage is disabled. */ }
  if (window.location.pathname !== "/login/") window.location.href = "/login/"
}

export function sessionIdentity() {
  const snapshot = getSessionSnapshot()
  return JSON.stringify([snapshot.identityKey, snapshot.identityEpoch])
}

// Only callers that know an operation is read-only may opt into replay. Even a
// rejected write is left for the user to retry with its original concurrency guard.
export async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}, replaySafe = false): Promise<Response> {
  let bearer = await ensureValidSession()
  const principal = sessionIdentity()
  const send = () => {
    init.signal?.throwIfAborted()
    const headers = new Headers(init.headers)
    if (bearer) headers.set("Authorization", `Bearer ${bearer}`)
    else headers.delete("Authorization")
    return fetch(input, { ...init, headers })
  }
  const assertIdentity = () => {
    if (sessionIdentity() !== principal) throw new Error("Your session changed. Refresh before continuing.")
  }
  let response = await send()
  assertIdentity()
  if (response.status !== 401) return response

  const renewed = await recoverUnauthorized(bearer)
  if (!renewed) {
    redirectToLogin()
    return response
  }
  assertIdentity()
  if (!replaySafe) throw new Error("Your session was renewed. Please retry this action.")
  bearer = renewed
  response = await send()
  assertIdentity()
  if (response.status === 401) {
    clearRejectedSession(bearer)
    redirectToLogin()
  }
  return response
}
