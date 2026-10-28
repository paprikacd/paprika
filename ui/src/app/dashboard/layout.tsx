import type { ReactNode } from "react"

import { AppShell } from "@/components/layout/app-shell"
import { SessionBoundary } from "@/components/auth/session-boundary"

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <SessionBoundary><AppShell>{children}</AppShell></SessionBoundary>
}
