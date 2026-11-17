const AUTH_RETURN_TO_KEY = "paprika_return_to"

// The destination belongs to the tab that started sign-in, just like its PKCE
// verifier. Other tabs may need to sign in at the same time.
export function readAuthReturnTo(): string | null {
  try { return sessionStorage.getItem(AUTH_RETURN_TO_KEY) } catch { return null }
}

export function writeAuthReturnTo(target: string | null): void {
  try {
    if (target === null) sessionStorage.removeItem(AUTH_RETURN_TO_KEY)
    else sessionStorage.setItem(AUTH_RETURN_TO_KEY, target)
  } catch { /* Sign-in remains available if browser storage is unavailable. */ }
}

export function consumeAuthReturnTo(): string | null {
  const target = readAuthReturnTo()
  writeAuthReturnTo(null)
  return target
}

// Shared by Google callback and basic login. The Observe consent handler is
// served by Go, not Next's trailing-slash static export.
export function safeAuthReturnTo(target: string | null): string | null {
  if (!target || !target.startsWith("/") || target.startsWith("//")) return null
  // Browsers treat backslashes as slashes; reject encoded separators too.
  const path = target.split(/[?#]/, 1)[0]
  if (/[%](?:2f|5c)/i.test(path) || /[\\\u0000-\u0020\u007f]/.test(target)) return null
  try {
    const url = new URL(target, "https://return.invalid")
    if (url.origin !== "https://return.invalid" || url.pathname.startsWith("//")) return null
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "")
    if (pathname === "/login" || pathname.startsWith("/login/") ||
        pathname === "/auth" || pathname.startsWith("/auth/")) return null
    const normalized = url.pathname === "/observe/consent"
      ? url.pathname
      : url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`
    return normalized + url.search + url.hash
  } catch {
    return null
  }
}

export function authReturnDestination(target: string | null): string {
  return safeAuthReturnTo(target) ?? "/dashboard/"
}
