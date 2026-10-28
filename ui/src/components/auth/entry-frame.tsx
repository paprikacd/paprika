"use client"

import type { ReactNode } from "react"
import { Blueprint } from "@/components/ui/blueprint"
import { useEntryTheme } from "./entry-theme"
import styles from "./entry-theme.module.css"

export function EntryFrame({ title = "Welcome to Paprika", description = "Your applications, deployments and signals in one place.", children }: { title?: string; description?: string; children: ReactNode }) {
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
            <h1 className="font-cond text-title leading-none font-semibold tracking-[0.01em]">{title}</h1>
            <p className="mt-2 text-note leading-relaxed text-muted-foreground">{description}</p>
          </div>
          <div className="min-h-44 px-5 py-5">{children}</div>
        </Blueprint>
        <p className="mt-4 text-center font-mono text-meta text-muted-foreground">Authenticated access · Paprika control plane</p>
      </div>
    </main>
  </div>
}

export function EntryProgress({ message = "Reconnecting to your workspace…" }: { message?: string }) {
  return <div role="status" className="flex min-h-32 items-center justify-center gap-3 text-note text-muted-foreground">
    <span aria-hidden="true" className="size-4 rounded-full border-2 border-rule border-t-primary motion-safe:animate-spin" />
    {message}
  </div>
}
