import type { ReactNode } from "react"

import { ScopeBar } from "@/components/layout/scope-bar"
import { Sidebar } from "@/components/layout/sidebar"

export function AppShell({ children }: { children: ReactNode }) {
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
