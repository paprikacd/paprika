"use client"

import Link from "next/link"
import { Cpu, LogOut, User } from "lucide-react"
import { useConnection } from "@/lib/connection-context"
import { useAuth } from "@/lib/auth-context"
import { NotificationCenter } from "@/components/notifications/notification-center"
import { Button } from "@/components/ui/button"

const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Rollouts", href: "/dashboard/rollouts" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
  { label: "API", href: "/docs/api" },
]

export function Nav() {
  const { connected } = useConnection()
  const { user, isLoading, login, logout } = useAuth()

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Cpu className="size-4" aria-hidden="true" />
            </span>
            <span className="text-base font-semibold tracking-tight">Paprika</span>
          </Link>
          <nav className="hidden items-center gap-1 sm:flex">
            {navItems.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <NotificationCenter />
          <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${
            connected
              ? "border-success/20 bg-success/10"
              : "border-border/50 bg-muted/50"
          }`}>
            <span className="relative flex size-2">
              {connected && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/40" />
              )}
              <span className={`relative inline-flex size-2 rounded-full ${
                connected ? "bg-success" : "bg-muted-foreground/50"
              }`} />
            </span>
            <span className={`text-xs font-medium ${
              connected ? "text-success" : "text-muted-foreground"
            }`}>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>

          {isLoading ? null : user ? (
            <div className="flex items-center gap-2">
              <Link
                href="/login"
                className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt=""
                    className="size-5 rounded-full"
                  />
                ) : (
                  <User className="size-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{user.name}</span>
              </Link>
              <button
                onClick={logout}
                className="rounded-md p-1.5 text-muted-foreground transition-all hover:text-foreground active:scale-[0.96]"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/90 active:scale-[0.96]"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
