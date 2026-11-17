"use client"

import { Suspense, type ReactNode } from "react"
import { usePathname } from "next/navigation"

import {
  ConsoleHeader,
  ConsoleScopeProvider,
} from "@/components/layout/console-header"
import { Sidebar } from "@/components/layout/sidebar"
import { SessionNotice } from "@/components/auth/session-notice"

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  // Insights owns its navigation and viewport-sized query workspace. Keeping
  // the fleet shell around it would duplicate navigation and shrink editors.
  if (pathname === "/dashboard/insights" || pathname.startsWith("/dashboard/insights/"))
    return <><SessionNotice />{children}</>

  return (
    <ConsoleScopeProvider>
      <div className="min-h-dvh bg-background">
        <SessionNotice />
        <a
          href="#dashboard-main"
          data-dashboard-skip-link
          className="sr-only fixed top-4 left-4 z-[100] bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground focus:not-sr-only"
        >
          Skip to fleet content
        </a>
        <Sidebar />
        <div data-dashboard-shell-content className="lg:pl-nav">
          {/* The header reads scope from the URL, so it opts out of
              prerendering; the fallback holds the bar's height to stop the
              page shifting when it hydrates. */}
          <Suspense
            fallback={
              <div className="sticky top-14 z-30 h-header border-b border-rule bg-card lg:top-0" />
            }
          >
            <ConsoleHeader />
          </Suspense>
          <main
            id="dashboard-main"
            tabIndex={-1}
            className="min-h-[calc(100dvh-6.5rem)] outline-none lg:min-h-[calc(100dvh-var(--spacing-header))]"
          >
            {children}
          </main>
        </div>
      </div>
    </ConsoleScopeProvider>
  )
}
