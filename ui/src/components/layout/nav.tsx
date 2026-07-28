"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, User } from "lucide-react"
import { useAuth } from "@/lib/auth-context"

export function Nav() {
  const pathname = usePathname()
  const { user, isLoading, logout } = useAuth()

  if (pathname.startsWith("/dashboard")) return null

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center gap-2.5" aria-label="Paprika">
          <span className="flex size-7 items-center justify-center rounded-sm bg-primary text-xs font-bold text-primary-foreground">
            P
          </span>
          <span className="text-sm font-semibold tracking-tight">Paprika</span>
        </Link>

        <div className="flex items-center gap-2">
          {isLoading ? null : user ? (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex min-h-11 items-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <User className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline text-xs">{user.name}</span>
              </Link>
              <button
                type="button"
                onClick={logout}
                className="inline-flex size-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-secondary"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
