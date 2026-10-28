"use client"

import { Suspense, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { safeAuthReturnTo } from "@/lib/auth-return-to"
import { writeBrowserStorage } from "@/lib/browser-session"
import { useEntryTheme } from "./entry-theme"
import styles from "./entry-theme.module.css"

export function SessionNotice() {
  return <Suspense fallback={null}><SessionNoticeContent /></Suspense>
}

function SessionNoticeContent() {
  const { status, retry } = useAuth()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const theme = useEntryTheme()
  // Public examples run entirely from local data and need no server session.
  const example = pathname.replace(/\/+$/, "") === "/dashboard/insights" && searchParams.get("example") === "1"
  if (status !== "unavailable" || example) return null
  async function reconnect() {
    setBusy(true); setFailed(false)
    try { await retry() } catch { setFailed(true) } finally { setBusy(false) }
  }
  function signIn() {
    writeBrowserStorage("paprika_return_to", safeAuthReturnTo(window.location.pathname + window.location.search + window.location.hash))
    window.location.href = "/login/"
  }
  return <div role="alert" data-entry-theme={theme} className={`${styles.scope} fixed right-4 bottom-4 left-4 z-[100] mx-auto flex max-w-xl flex-wrap items-center gap-x-4 gap-y-3 border border-rule bg-card px-4 py-3 text-foreground shadow-lg`}>
    <div className="min-w-0 flex-1 text-note"><p className="font-semibold">Connection interrupted</p><p className="mt-1 text-muted-foreground">{failed ? "Still unable to reconnect. Check your connection and retry." : "Your workspace is still here. Reconnect to resume live updates."}</p></div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => void reconnect()} className="cursor-pointer border border-rule px-3 py-2 text-note font-medium hover:bg-inset focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">{busy ? "Reconnecting…" : "Retry connection"}</button>
      <button type="button" disabled={busy} onClick={signIn} className="cursor-pointer text-note underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">Sign in again</button>
    </div>
  </div>
}
