"use client"

import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { getAuthConfiguration, getServerSessionSnapshot, getSessionSnapshot, subscribeSession } from "@/lib/browser-session"
import { redirectToLogin } from "@/lib/session-request"
import { EntryFrame, EntryProgress } from "./entry-frame"

export function SessionBoundary({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot)
  const pathname = usePathname()
  useEffect(() => {
    if (session.status !== "anonymous" || session.logoutPending) return
    if (pathname.replace(/\/+$/, "") === "/dashboard/insights" && new URLSearchParams(window.location.search).get("example") === "1") return
    let active = true
    void getAuthConfiguration().then(config => {
      // Config-less/unauthenticated deployments and public examples can render
      // without a session. A concurrent sign-in must cancel this navigation.
      if (active && getSessionSnapshot().status === "anonymous" && !getSessionSnapshot().logoutPending && (config.oidc.enabled || config.basic.enabled)) redirectToLogin()
    }).catch(() => { /* The connection notice owns transient recovery. */ })
    return () => { active = false }
  }, [pathname, session.status, session.identityEpoch, session.logoutPending])
  if (session.logoutPending) return <EntryFrame title="Signing you out"><EntryProgress message="Finishing your session…" /></EntryFrame>
  // React Query is cleared by the session manager; remount the console's local
  // component state too so a different account cannot inherit private views.
  return <div key={JSON.stringify([session.identityKey, session.identityEpoch])} className="contents">{children}</div>
}
