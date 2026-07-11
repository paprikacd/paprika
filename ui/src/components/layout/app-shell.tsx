import type { ReactNode } from "react"

import { ScopeBar } from "@/components/layout/scope-bar"
import { Sidebar } from "@/components/layout/sidebar"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#dashboard-main"
        data-dashboard-skip-link
        className="sr-only fixed left-4 top-4 z-[100] bg-primary px-4 py-3 text-sm font-semibold text-background focus:not-sr-only"
      >
        Skip to fleet content
      </a>
      <Sidebar />
      <div data-dashboard-shell-content className="lg:pl-64">
        <ScopeBar />
        <main
          id="dashboard-main"
          tabIndex={-1}
          className="min-h-[calc(100dvh-6.5rem)] outline-none lg:min-h-[calc(100dvh-3rem)]"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
