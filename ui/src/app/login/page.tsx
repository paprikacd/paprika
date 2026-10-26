"use client"

import { Blueprint } from "@/components/ui/blueprint"
import { authReturnDestination } from "@/lib/auth-return-to"
import { consumeReturnTo, useAuth } from "@/lib/auth-context"
import { FormEvent, useEffect, useRef, useState } from "react"

export default function LoginPage() {
  const { user, isLoading, login } = useAuth()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const redirected = useRef(false)

  useEffect(() => {
    if (!isLoading && user && !redirected.current) {
      redirected.current = true
      window.location.href = authReturnDestination(consumeReturnTo())
    }
  }, [isLoading, user])

  if (isLoading) return null
  if (user) return null

  async function handleBasicLogin(e: FormEvent) {
    e.preventDefault()
    setError("")
    setBusy(true)
    try {
      const res = await fetch("/auth/basic-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const text = await res.text()
        setError(text || "Login failed")
        return
      }
      const data = await res.json()
      const { persistAuth } = await import("@/lib/auth-context")
      persistAuth(data.idToken)
      window.location.href = authReturnDestination(consumeReturnTo())
    } catch {
      setError("Network error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="hidden w-nav flex-none flex-col bg-ink-surface text-ink-on lg:flex">
        <div className="border-b border-ink-rule px-4 pt-3.5 pb-3">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/paprika-mark.png" alt="" className="size-6 object-contain" />
            <span className="font-cond text-[19px] leading-none font-bold tracking-[0.14em]">
              PAPRIKA
            </span>
          </div>
          <p className="mt-2 font-mono text-kicker tracking-[0.12em] text-ink-accent uppercase">
            Control plane · sign in
          </p>
        </div>
        <div className="flex-1 px-4 py-5">
          <p className="font-cond text-name leading-snug tracking-[0.02em]">
            One control plane for every delivery.
          </p>
          <p className="mt-2 text-note leading-[1.55] text-ink-muted">
            Applications, releases, rollouts, and the clusters they run on — in
            one operations console.
          </p>
        </div>
        <div className="border-t border-ink-rule px-4 py-3 font-mono text-kicker tracking-[0.12em] text-ink-faint uppercase">
          Operations console
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center p-5">
        <div className="w-full max-w-[430px]">
          <div className="mb-5 flex items-center gap-2.5 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/paprika-mark.png" alt="" className="size-7 object-contain" />
            <span className="font-cond text-[19px] leading-none font-bold tracking-[0.14em]">
              PAPRIKA
            </span>
          </div>

          <Blueprint className="bg-card">
            <div className="border-b border-rule px-4 py-3">
              <h1 className="font-cond text-title leading-none font-semibold tracking-[0.01em]">
                Sign in
              </h1>
              <p className="mt-1.5 text-note text-muted-foreground">
                Manage applications and deployments.
              </p>
            </div>

            <div className="px-4 py-4">
              <form onSubmit={handleBasicLogin} className="space-y-3.5">
                <div className="space-y-1">
                  <label
                    htmlFor="username"
                    className="font-mono text-meta tracking-[0.1em] text-neutral-600 uppercase"
                  >
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    required
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="h-9 w-full border border-rule bg-card px-2.5 text-console text-foreground outline-none placeholder:text-neutral-500 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    placeholder="admin"
                    autoComplete="username"
                  />
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor="password"
                    className="font-mono text-meta tracking-[0.1em] text-neutral-600 uppercase"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-9 w-full border border-rule bg-card px-2.5 text-console text-foreground outline-none placeholder:text-neutral-500 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                    placeholder="password"
                    autoComplete="current-password"
                  />
                </div>

                {error ? (
                  <p
                    role="alert"
                    className="border border-status-failed-line bg-status-failed-fill px-2.5 py-2 text-note text-status-failed-text"
                  >
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-9 w-full cursor-pointer items-center justify-center border border-primary bg-primary px-3 font-cond text-label font-semibold text-primary-foreground hover:bg-steel-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-rule-soft" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-card px-2 font-mono text-kicker tracking-[0.12em] text-neutral-500 uppercase">
                    Or continue with
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void login()}
                className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2.5 border border-rule bg-card px-3 font-cond text-label font-semibold text-foreground hover:bg-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
                Sign in with Google
              </button>
            </div>
          </Blueprint>

          <p className="mt-4 text-center font-mono text-meta text-neutral-600">
            Authenticated access · Paprika control plane
          </p>
        </div>
      </main>
    </div>
  )
}
