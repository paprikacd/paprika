"use client"

import { useRouter } from "next/navigation"
import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { EntryFrame, EntryProgress } from "@/components/auth/entry-frame"
import { authReturnDestination } from "@/lib/auth-return-to"
import { consumeReturnTo, useAuth } from "@/lib/auth-context"
import { exchangePasswordForSession, forgetLoginPreference, getAuthConfiguration, getServerSessionSnapshot, getSessionSnapshot, readLoginPreference, subscribeSession, type AuthConfiguration } from "@/lib/browser-session"

const primaryButton = "inline-flex min-h-10 w-full cursor-pointer items-center justify-center gap-2.5 border border-primary bg-primary px-3 font-cond text-label font-semibold text-primary-foreground transition-colors hover:bg-steel-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
const textButton = "cursor-pointer text-note text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"

function GoogleIcon() {
  return <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
}

export default function LoginPage() {
  const { user, isLoading, status, error: sessionError, login, retry } = useAuth()
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot)
  const preference = session.revision ? readLoginPreference() : null
  const router = useRouter()
  const [configuration, setConfiguration] = useState<AuthConfiguration | null>(null)
  const [configError, setConfigError] = useState("")
  const [username, setUsername] = useState("")
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const redirected = useRef(false)

  async function loadConfiguration() {
    setConfigError("")
    try { setConfiguration(await getAuthConfiguration()) }
    catch { setConfigError("Sign-in options are temporarily unavailable. Check your connection and retry.") }
  }
  useEffect(() => { void getAuthConfiguration().then(setConfiguration).catch(() => setConfigError("Sign-in options are temporarily unavailable. Check your connection and retry.")) }, [])

  function continueToWorkspace() {
    if (redirected.current) return
    redirected.current = true
    const destination = authReturnDestination(consumeReturnTo())
    if (destination.startsWith("/dashboard/")) router.replace(destination)
    else window.location.assign(destination) // Go-served MCP consent routes.
  }
  useEffect(() => {
    if (!isLoading && user && status === "authenticated" && !redirected.current) {
      redirected.current = true
      const destination = authReturnDestination(consumeReturnTo())
      if (destination.startsWith("/dashboard/")) router.replace(destination)
      else window.location.href = destination
    }
  }, [isLoading, user, status, router])

  async function beginLogin(switchAccount = false) {
    setError(""); setBusy(true)
    try { await login({ switchAccount, loginHint: switchAccount ? undefined : preference?.user.email }) }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t start sign-in. Please try again."); setBusy(false) }
  }
  async function retryConnection() {
    setBusy(true); setError("")
    try { await retry(); await loadConfiguration() }
    catch { setError("We still can’t reach Paprika. Please check your connection and try again.") }
    finally { setBusy(false) }
  }
  async function handleBasicLogin(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true)
    try {
      await exchangePasswordForSession({ username: usernameEdited ? username : preference?.method === "basic" ? preference.user.sub : username, password })
      setPassword("")
      continueToWorkspace()
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t complete sign-in. Please try again.") }
    finally { setBusy(false) }
  }

  const rememberedOIDC = preference?.method === "oidc" && preference.provider === configuration?.oidc.provider
  const accountName = preference?.user.name || preference?.user.email || "your account"
  const progress = isLoading || (status === "authenticated" && !!user)
  return <EntryFrame title={preference ? "Welcome back" : "Welcome to Paprika"}>
    {progress ? <EntryProgress /> : <div className="space-y-4">
      {preference && <div className="flex items-center gap-3 border border-rule-soft bg-inset px-3 py-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-card font-cond text-lg text-foreground">
          {preference.user.picture ? <RememberedAvatar picture={preference.user.picture} name={accountName} /> : accountName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-console font-medium">{accountName}</p>
          {preference.user.name && <p className="truncate text-note text-muted-foreground">{preference.user.email}</p>}
          <p className="mt-1 font-mono text-kicker text-muted-foreground">Last used · {preference.method === "basic" ? "Password" : preference.provider === "google" ? "Google" : "Single sign-on"}</p>
        </div>
      </div>}
      {(error || sessionError || configError) && <div role="alert" className="space-y-3 border border-status-failed-line bg-status-failed-fill px-3 py-3 text-note text-status-failed-text">
        <p>{error || sessionError || configError}</p>
        {(status === "unavailable" || configError) && <button type="button" disabled={busy} className={textButton} onClick={() => void (status === "unavailable" ? retryConnection() : loadConfiguration())}>Retry connection</button>}
      </div>}
      {!configuration && !configError ? <EntryProgress message="Loading sign-in options…" /> : null}
      {configuration?.oidc.enabled && <div className="space-y-3">
        <button type="button" disabled={busy} onClick={() => void beginLogin()} className={primaryButton}>
          {configuration.oidc.provider === "google" && <span className="flex size-6 items-center justify-center rounded-sm bg-white"><GoogleIcon /></span>}
          {busy ? "Connecting…" : rememberedOIDC ? `Continue as ${accountName}` : `Continue with ${configuration.oidc.label}`}
        </button>
        {rememberedOIDC && <button type="button" disabled={busy} onClick={() => void beginLogin(true)} className={`${textButton} block w-full text-center`}>Use another account</button>}
      </div>}
      {configuration?.basic.enabled && <form onSubmit={handleBasicLogin} className="space-y-3.5">
        {configuration.oidc.enabled && <p className="border-t border-rule-soft pt-4 font-mono text-kicker text-muted-foreground">Or use your console account</p>}
        <div className="space-y-1"><label htmlFor="username" className="text-note text-muted-foreground">Username</label><input id="username" type="text" required value={usernameEdited ? username : preference?.method === "basic" ? preference.user.sub : username} onChange={(event) => { setUsernameEdited(true); setUsername(event.target.value) }} className="h-10 w-full border border-rule bg-card px-3 text-console outline-none focus-visible:outline-2 focus-visible:outline-ring" autoComplete="username" /></div>
        <div className="space-y-1"><label htmlFor="password" className="text-note text-muted-foreground">Password</label><input id="password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 w-full border border-rule bg-card px-3 text-console outline-none focus-visible:outline-2 focus-visible:outline-ring" autoComplete="current-password" /></div>
        <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>}
      {configuration && !configuration.oidc.enabled && !configuration.basic.enabled && <p className="text-note text-muted-foreground">Interactive sign-in is not enabled for this console. Contact your administrator.</p>}
      {preference && <div className="border-t border-rule-soft pt-3 text-center"><button type="button" disabled={busy} className={textButton} onClick={forgetLoginPreference}>Forget this account</button></div>}
    </div>}
  </EntryFrame>
}

function RememberedAvatar({ picture, name }: { picture: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <>{name.slice(0, 1).toUpperCase()}</>
  // The provider picture URL is only a display hint, never an identity check.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} />
}
