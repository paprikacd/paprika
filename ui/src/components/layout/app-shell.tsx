import { Suspense, type ReactNode } from "react"

import { ScopeBar } from "@/components/layout/scope-bar"
import { Sidebar } from "@/components/layout/sidebar"
import { FleetScopeProvider } from "@/lib/fleet-scope-context"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<FleetShellFallback />}>
      <FleetScopeProvider>
        <AppShellFrame>{children}</AppShellFrame>
      </FleetScopeProvider>
    </Suspense>
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
        <ScopeBar />
        <main
          id="dashboard-main"
          tabIndex={-1}
          className="min-h-[calc(100dvh-6.5rem)] lg:min-h-[calc(100dvh-3rem)]"
        >
          {children}
        </main>
      </div>
    </div>
  )
}

function FleetShellFallback() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-dvh items-center justify-center bg-background px-6"
    >
      <p role="status" className="text-sm text-muted-foreground">
        Loading fleet scope…
      </p>
    </div>
  )
}
