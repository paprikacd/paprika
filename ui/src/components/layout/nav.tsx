"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, User, LayoutDashboard, BookOpen, GitBranch } from "lucide-react"
import { useAuth } from "@/lib/auth-context"

export function Nav() {
  const pathname = usePathname()
  const { user, isLoading, logout } = useAuth()

  const isLanding = pathname === "/"
  const isAuthPage = pathname === "/login" || pathname.startsWith("/auth/")

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl supports-backdrop-blur:bg-background/60">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
            P
          </span>
          <span className="text-sm font-semibold tracking-tight">Paprika</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {user ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
            >
              <LayoutDashboard className="size-3.5" />
              Dashboard
            </Link>
          ) : isLanding ? (
            <>
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
              >
                <LayoutDashboard className="size-3.5" />
                Dashboard
              </Link>
              <a
                href="https://github.com/paprikacd/paprika"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
              >
                <GitBranch className="size-3.5" />
                GitHub
              </a>
            </>
          ) : null}
        </nav>

        <div className="flex items-center gap-2">
          {isLoading ? null : user ? (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {user.picture ? (
                  <img src={user.picture} alt="" className="size-5 rounded-full" />
                ) : (
                  <User className="size-3.5" />
                )}
                <span className="hidden sm:inline text-xs">{user.name}</span>
              </Link>
              <button
                onClick={logout}
                className="rounded-md p-1.5 text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
                title="Sign out"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          ) : (
            !isAuthPage && (
              <Link
                href="/login"
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.96]"
              >
                Sign in
              </Link>
            )
          )}
        </div>
      </div>
    </header>
  )
}
