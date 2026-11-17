"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, User } from "lucide-react"
import { useAuth } from "@/lib/auth-context"

export function Nav() {
  const pathname = usePathname()
  const { user, isLoading, logout } = useAuth()

  // The dashboard owns its shell, and the login page owns its identity frame.
  // A second brand bar above either one reads as a different product.
  const path = pathname.replace(/\/+$/, "")
  if (path === "" || path.startsWith("/dashboard") || path === "/login" || path === "/auth/callback") {
    return null
  }

  return (
    <header className="sticky top-0 z-50 border-b border-rule bg-card">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex min-h-11 items-center gap-2.5" aria-label="Paprika">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/paprika-mark.png" alt="" className="size-6 object-contain" />
          <span className="font-cond text-[19px] leading-none font-bold tracking-[0.14em]">
            PAPRIKA
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {isLoading ? null : user ? (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex min-h-11 items-center gap-1.5 px-2 font-mono text-meta tracking-[0.06em] text-neutral-600 uppercase transition-colors hover:text-foreground"
              >
                <User className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{user.name}</span>
              </Link>
              <button
                type="button"
                onClick={logout}
                className="inline-flex size-11 items-center justify-center text-neutral-600 transition-colors hover:bg-inset hover:text-foreground active:bg-muted"
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
