"use client"

import { Check } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Blueprint } from "@/components/ui/blueprint"
import type { AuthUser } from "@/lib/browser-session"
import { useEntryTheme } from "./entry-theme"
import styles from "./entry-theme.module.css"

/**
 * The one surface every step of signing in and connecting wears: login, the
 * provider callback, sign-out and MCP consent. `title={null}` reserves the
 * heading while the page still learns whether this is a returning visitor,
 * so it never flips from one greeting to another. A change of `phase`
 * cross-fades the body instead of swapping it abruptly.
 */
export function EntryFrame({ title = "Welcome to Paprika", description = "Your applications, deployments and signals in one place.", phase, children }: { title?: string | null; description?: ReactNode; phase?: string; children: ReactNode }) {
  const theme = useEntryTheme()
  return <div data-entry-theme={theme} className={`${styles.scope} flex min-h-dvh bg-background`}>
    <aside className="hidden w-nav flex-none flex-col bg-ink-surface text-ink-on lg:flex">
      <div className="border-b border-ink-rule px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/paprika-mark.png" alt="" className="size-6 object-contain" />
          <span className="font-cond text-[19px] leading-none font-bold tracking-[0.14em]">PAPRIKA</span>
        </div>
        <p className="mt-2 font-mono text-kicker tracking-[0.12em] text-ink-accent uppercase">Control plane</p>
      </div>
      <div className="flex-1 px-4 py-5">
        <p className="font-cond text-name leading-snug tracking-[0.02em]">One control plane for every delivery.</p>
        <p className="mt-2 text-note leading-[1.55] text-ink-muted">Applications, releases, rollouts, and the clusters they run on — in one operations console.</p>
      </div>
      <div className="border-t border-ink-rule px-4 py-3 font-mono text-kicker tracking-[0.12em] text-ink-faint uppercase">Operations console</div>
    </aside>
    <main className="flex flex-1 items-center justify-center p-5">
      <div className="w-full max-w-[430px]">
        <div className="mb-5 flex items-center gap-2.5 lg:hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/paprika-mark.png" alt="" className="size-7 object-contain" />
          <span className="font-cond text-[19px] leading-none font-bold tracking-[0.14em]">PAPRIKA</span>
        </div>
        <Blueprint className="bg-card">
          <div className="border-b border-rule px-5 py-5">
            {title === null
              ? <div aria-hidden="true" className={`${styles.skeleton} h-[26px] w-44`} />
              : <h1 key={title} className="font-cond text-title leading-none font-semibold tracking-[0.01em] animate-in fade-in duration-200">{title}</h1>}
            <p className="mt-2 text-note leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <div key={phase} className="min-h-44 px-5 py-5 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out">{children}</div>
        </Blueprint>
        <p className="mt-4 text-center font-mono text-meta text-muted-foreground">Authenticated access · Paprika control plane</p>
      </div>
    </main>
  </div>
}

export function EntryAvatar({ user, className = "size-10" }: { user: Pick<AuthUser, "name" | "email" | "picture">; className?: string }) {
  const [failed, setFailed] = useState(false)
  const label = user.name || user.email || "?"
  return <div className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-card font-cond text-lg text-foreground ring-1 ring-rule-soft`}>
    {user.picture && !failed
      // The provider picture URL is only a display hint, never an identity check.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={user.picture} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} />
      : label.slice(0, 1).toUpperCase()}
  </div>
}

/** The remembered or signed-in account, as one recognisable row. */
export function EntryIdentity({ user, meta }: { user: AuthUser; meta?: ReactNode }) {
  const name = user.name || user.email || "your account"
  return <div className="flex items-center gap-3 border border-rule-soft bg-inset px-3 py-3">
    <EntryAvatar user={user} />
    <div className="min-w-0 flex-1">
      <p className="truncate text-console font-medium">{name}</p>
      {user.name && user.email && <p className="truncate text-note text-muted-foreground">{user.email}</p>}
      {meta && <p className="mt-1 font-mono text-kicker text-muted-foreground">{meta}</p>}
    </div>
  </div>
}

export interface EntryStep { label: string; state: "done" | "active" | "pending" }

/**
 * Waiting, said plainly. The rail is the only motion; an optional identity
 * says who the wait is for, and optional steps say how far along it is. Every
 * step reflects real work in flight; none is staged for effect.
 */
export function EntryProgress({ message = "Opening Paprika…", detail, identity, steps }: { message?: string; detail?: string; identity?: AuthUser | null; steps?: EntryStep[] }) {
  return <div role="status" aria-live="polite" className="flex min-h-32 flex-col justify-center gap-4">
    <div aria-hidden="true" className={styles.rail}><span /></div>
    <div className="flex items-center gap-3">
      {identity && <EntryAvatar user={identity} />}
      <div className="min-w-0">
        <p className="text-console font-medium text-foreground">{message}</p>
        {(detail || identity?.email) && <p className="truncate text-note text-muted-foreground">{detail ?? identity?.email}</p>}
      </div>
    </div>
    {steps && steps.length > 0 && <ol className="space-y-2 border-t border-rule-soft pt-3.5">
      {steps.map((step) => <li key={step.label} data-state={step.state} className={`flex items-center gap-2.5 text-note ${step.state === "active" ? "text-foreground" : "text-muted-foreground"}`}>
        <span aria-hidden="true" className="flex size-4 items-center justify-center">
          {step.state === "done"
            ? <Check className="size-3.5 text-entry-accent" strokeWidth={2.5} />
            : <span className={`size-2 ${step.state === "active" ? `bg-entry-accent ${styles.activeStep}` : "border border-rule"}`} />}
        </span>
        <span>{step.label}</span>
        <span className="sr-only">{step.state === "done" ? "(done)" : step.state === "active" ? "(in progress)" : "(next)"}</span>
      </li>)}
    </ol>}
  </div>
}

/** Placeholder geometry for sign-in options that are still loading. */
export function EntryOptionsSkeleton() {
  return <div aria-hidden="true" className="space-y-3">
    <div className={`${styles.skeleton} h-10 w-full`} />
    <div className={`${styles.skeleton} mx-auto h-3 w-32`} />
  </div>
}

export function relativeSignIn(at: number | undefined, now = Date.now()): string | null {
  if (!at || at > now + 60_000) return null
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 30) return `${days} days ago`
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}
