import { Suspense, type ReactNode } from "react"

import {
  ScopeBar,
  ScopeBarFallback,
} from "@/components/layout/scope-bar"
import { AdminSessionBanner } from "@/components/layout/admin-session-banner"
import { Sidebar } from "@/components/layout/sidebar"
import { AdminSessionProvider } from "@/lib/admin-session-context"
import { FleetScopeProvider } from "@/lib/fleet-scope-context"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AdminSessionProvider>
      <AppShellFrame>{children}</AppShellFrame>
    </AdminSessionProvider>
  )
}

function AppShellFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#dashboard-main"
        data-dashboard-skip-link
        className="dashboard-skip-link bg-primary px-4 py-3 text-sm font-semibold text-background"
      >
        Skip to fleet content
      </a>
      <Sidebar />
      <div data-dashboard-shell-content className="lg:pl-64">
        <Suspense fallback={<FleetShellFallback />}>
          <FleetScopeProvider>
            <StickyShellRail>
              <ScopeBar />
            </StickyShellRail>
            <DashboardMain>{children}</DashboardMain>
          </FleetScopeProvider>
        </Suspense>
      </div>
    </div>
  )
}

function FleetShellFallback() {
  return (
    <>
      <StickyShellRail>
        <ScopeBarFallback />
      </StickyShellRail>
      <DashboardMain>
        <div
          aria-busy="true"
          className="flex min-h-[calc(100dvh-6.5rem)] items-center justify-center bg-background px-6 lg:min-h-[calc(100dvh-3rem)]"
        >
          <p role="status" className="text-sm text-muted-foreground">
            Loading fleet scope…
          </p>
        </div>
      </DashboardMain>
    </>
  )
}

function StickyShellRail({ children }: { children: ReactNode }) {
  return (
    <div
      data-dashboard-sticky-rail
      className="sticky top-14 z-30 lg:top-0"
    >
      <AdminSessionBanner />
      {children}
    </div>
  )
}

function DashboardMain({ children }: { children: ReactNode }) {
  return (
    <main
      id="dashboard-main"
      tabIndex={-1}
      className="min-h-[calc(100dvh-6.5rem)] lg:min-h-[calc(100dvh-3rem)]"
    >
      {children}
    </main>
  )
}
