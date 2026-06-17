"use client"

import Link from "next/link"
import { Cpu } from "lucide-react"
import { useConnection } from "@/lib/connection-context"

const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Rollouts", href: "/dashboard/rollouts" },
  { label: "Docs", href: "/docs" },
  { label: "Blog", href: "/blog" },
  { label: "API", href: "/docs/api" },
]

export function Nav() {
  const { connected } = useConnection()
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
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
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
        </div>
      </div>
    </header>
  )
}