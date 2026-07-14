"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  Activity,
  Boxes,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Rocket,
  Settings,
  User,
  X,
  type LucideIcon,
} from "lucide-react"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"

import { useAuth } from "@/lib/auth-context"
import { fleetHref } from "@/lib/fleet-navigation"
import { cn } from "@/lib/utils"

interface NavigationItem {
  label: string
  icon: LucideIcon
  href?: string
  disabled?: boolean
}

interface NavigationSection {
  label: string
  items: NavigationItem[]
}

const navigationSections: NavigationSection[] = [
  {
    label: "Fleet",
    items: [
      { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
      { label: "Applications", href: "/dashboard/applications", icon: Rocket },
    ],
  },
  {
    label: "Delivery",
    items: [
      { label: "Pipelines", href: "/dashboard#pipelines", icon: GitBranch },
      { label: "Releases", href: "/dashboard/releases", icon: Package },
      { label: "Rollouts", href: "/dashboard/rollouts", icon: Boxes },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Activity", icon: Activity, disabled: true },
      { label: "Admin", icon: Settings, disabled: true },
    ],
  },
]

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

export function Sidebar() {
  const pathname = normalizeDashboardPathname(usePathname())
  const router = useRouter()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [hash, setHash] = useState("")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const mobileHeaderRef = useRef<HTMLElement>(null)
  const desktopSidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const updateHash = () => {
      setHash(window.location.hash)
      setDrawerOpen(false)
    }
    updateHash()
    window.addEventListener("hashchange", updateHash)
    return () => window.removeEventListener("hashchange", updateHash)
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const desktop = window.matchMedia("(min-width: 1024px)")
    const closeAtDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false)
    }
    desktop.addEventListener("change", closeAtDesktop)
    return () => desktop.removeEventListener("change", closeAtDesktop)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return

    const trigger = triggerRef.current
    const previousOverflow = document.body.style.overflow
    const restoreInert = makeElementsInert([
      document.querySelector<HTMLElement>("[data-dashboard-skip-link]"),
      document.querySelector<HTMLElement>("[data-dashboard-shell-content]"),
      mobileHeaderRef.current,
      desktopSidebarRef.current,
    ])
    document.body.style.overflow = "hidden"
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        setDrawerOpen(false)
        return
      }
      if (event.key !== "Tab") return

      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!drawerRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        const destination = event.shiftKey ? last : first
        destination.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !drawerRef.current?.contains(event.target)) {
        closeRef.current?.focus()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("focusin", handleFocusIn)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("focusin", handleFocusIn)
      restoreInert()
      document.body.style.overflow = previousOverflow
      if (trigger?.isConnected) trigger.focus()
    }
  }, [drawerOpen])

  const navigation = (
    <Suspense
      fallback={
        <SidebarNavigation
          pathname={pathname}
          hash={hash}
          releaseHref="/dashboard/releases"
          onNavigate={() => setDrawerOpen(false)}
        />
      }
    >
      <ScopedSidebarNavigation
        pathname={pathname}
        hash={hash}
        router={router}
        onNavigate={() => setDrawerOpen(false)}
      />
    </Suspense>
  )

  return (
    <>
      <header
        ref={mobileHeaderRef}
        data-dashboard-mobile-header
        className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-sidebar-border bg-sidebar px-3 lg:hidden"
      >
        <Suspense fallback={<MobileBrand href="/dashboard" />}><ScopedBrand mobile /></Suspense>
        <button
          ref={triggerRef}
          type="button"
          className="inline-flex size-11 items-center justify-center text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent active:bg-sidebar-accent/80"
          aria-label="Open navigation"
          aria-controls="paprika-mobile-navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      </header>

      <aside
        ref={desktopSidebarRef}
        data-dashboard-desktop-sidebar
        className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex"
      >
        <Suspense fallback={<SidebarBrand href="/dashboard" />}><ScopedBrand /></Suspense>
        {navigation}
        <SidebarFootnote />
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="navigation-backdrop"
            className="absolute inset-0 cursor-default bg-background/80 animate-in fade-in duration-200"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            ref={drawerRef}
            id="paprika-mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Fleet navigation"
            className="relative flex h-dvh w-[min(20rem,calc(100vw-3rem))] flex-col border-r border-sidebar-border bg-sidebar animate-in slide-in-from-left duration-300"
          >
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-3">
              <Suspense fallback={<MobileBrand href="/dashboard" />}><ScopedBrand mobile /></Suspense>
              <button
                ref={closeRef}
                type="button"
                className="inline-flex size-11 items-center justify-center text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent active:bg-sidebar-accent/80"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {navigation}
            <SidebarFootnote />
          </aside>
        </div>
      ) : null}
    </>
  )
}

function ScopedSidebarNavigation({
  pathname,
  hash,
  router,
  onNavigate,
}: {
  pathname: string
  hash: string
  router: ReturnType<typeof useRouter>
  onNavigate: () => void
}) {
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const current = useMemo(() => new URLSearchParams(rawQuery), [rawQuery])
  const releaseHref = fleetHref("/dashboard/releases", current)
  const migratedLegacyHash = useRef("")

  useEffect(() => {
    if (pathname !== "/dashboard" || !["#applications", "#releases"].includes(hash)) {
      migratedLegacyHash.current = ""
      return
    }
    const migration = `${pathname}?${rawQuery}${hash}`
    if (migratedLegacyHash.current === migration) return
    migratedLegacyHash.current = migration
    router.replace(
      hash === "#applications"
        ? fleetHref("/dashboard/applications", current)
        : releaseHref,
    )
  }, [current, hash, pathname, rawQuery, releaseHref, router])

  return (
    <SidebarNavigation
      pathname={pathname}
      hash={hash}
      releaseHref={releaseHref}
      query={rawQuery}
      onNavigate={onNavigate}
    />
  )
}

function normalizeDashboardPathname(pathname: string) {
  if (pathname === "/") return pathname
  return pathname.replace(/\/+$/, "")
}

function makeElementsInert(elements: Array<HTMLElement | null>) {
  const inertElements = elements.filter((element): element is HTMLElement => element !== null)
  const snapshots = Array.from(new Set(inertElements)).map((element) => ({
      element,
      hadAttribute: element.hasAttribute("inert"),
      value: element.getAttribute("inert"),
    }))
  for (const { element } of snapshots) {
    element.setAttribute("inert", "")
  }
  return () => {
    for (const { element, hadAttribute, value } of snapshots) {
      if (hadAttribute) {
        element.setAttribute("inert", value ?? "")
      } else {
        element.removeAttribute("inert")
      }
    }
  }
}

function SidebarNavigation({
  pathname,
  hash,
  releaseHref,
  query = "",
  onNavigate,
}: {
  pathname: string
  hash: string
  releaseHref: string
  query?: string
  onNavigate: () => void
}) {
  return (
    <nav aria-label="Fleet sections" className="flex-1 overflow-y-auto px-3 py-5">
      <div className="space-y-6">
        {navigationSections.map((section) => (
          <section key={section.label} aria-labelledby={`nav-${section.label.toLowerCase()}`}>
            <h2
              id={`nav-${section.label.toLowerCase()}`}
              className="mb-2 px-3 font-mono text-[0.625rem] font-medium uppercase tracking-[0.18em] text-muted-foreground"
            >
              {section.label}
            </h2>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <SidebarItem
                  key={item.label}
                  item={
                    item.label === "Releases"
                      ? { ...item, href: releaseHref }
                      : item.href
                        ? { ...item, href: fleetHref(item.href, new URLSearchParams(query)) }
                        : item
                  }
                  active={isNavigationItemActive(item, pathname, hash)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </nav>
  )
}

function SidebarItem({
  item,
  active,
  onNavigate,
}: {
  item: NavigationItem
  active: boolean
  onNavigate: () => void
}) {
  const Icon = item.icon
  const className = cn(
    "relative flex min-h-11 w-full items-center gap-3 px-3 text-sm font-medium transition-colors duration-150",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-sidebar-primary"
      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent/80",
  )

  if (item.disabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        aria-label={`${item.label}. Available in a later plan`}
        title="Available in a later plan"
        className={cn(className, "cursor-not-allowed opacity-40")}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    )
  }

  return (
    <Link
      href={item.href ?? "/dashboard"}
      aria-current={active ? "page" : undefined}
      className={className}
      onClick={onNavigate}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  )
}

function isNavigationItemActive(item: NavigationItem, pathname: string, hash: string) {
  switch (item.label) {
    case "Overview":
      return pathname === "/dashboard" && !["#pipelines", "#releases", "#applications"].includes(hash)
    case "Applications":
      return (
        pathname.startsWith("/dashboard/application") ||
        (pathname === "/dashboard" && hash === "#applications")
      )
    case "Pipelines":
      return pathname.startsWith("/dashboard/pipelines") || (pathname === "/dashboard" && hash === "#pipelines")
    case "Releases":
      return pathname.startsWith("/dashboard/releases")
    case "Rollouts":
      return pathname.startsWith("/dashboard/rollouts")
    default:
      return false
  }
}

function ScopedBrand({ mobile = false }: { mobile?: boolean }) {
  const searchParams = useSearchParams()
  const href = fleetHref("/dashboard", searchParams)
  return mobile ? <MobileBrand href={href} /> : <SidebarBrand href={href} />
}

function SidebarBrand({ href }: { href: string }) {
  return (
    <div className="flex h-16 items-center border-b border-sidebar-border px-5">
      <Link href={href} className="flex min-h-11 items-center gap-3" aria-label="Paprika operations overview">
        <BrandMark />
        <span>
          <span className="block text-sm font-semibold tracking-tight text-sidebar-foreground">Paprika</span>
          <span className="block font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted-foreground">
            Control plane
          </span>
        </span>
      </Link>
    </div>
  )
}

function MobileBrand({ href }: { href: string }) {
  return (
    <Link href={href} className="flex min-h-11 items-center gap-2.5" aria-label="Paprika operations overview">
      <BrandMark />
      <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">Paprika</span>
    </Link>
  )
}

function BrandMark() {
  return (
    <span className="flex size-8 items-center justify-center rounded-sm bg-primary text-xs font-bold text-primary-foreground">
      P
    </span>
  )
}

function SidebarFootnote() {
  const { user, isLoading, logout } = useAuth()
  if (!isLoading && user) {
    const displayName = user.name || user.email || "Signed in"
    return (
      <div className="border-t border-sidebar-border px-3 py-3">
        <div className="flex min-h-11 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center bg-sidebar-accent text-muted-foreground">
            <User className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-sidebar-foreground">{displayName}</p>
            <p className="font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted-foreground">
              Authenticated
            </p>
          </div>
          <button
            type="button"
            className="inline-flex size-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground active:bg-sidebar-accent/80"
            aria-label="Sign out"
            title="Sign out"
            onClick={logout}
          >
            <LogOut className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="border-t border-sidebar-border px-6 py-4">
      <p className="font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted-foreground">
        Operations console
      </p>
    </div>
  )
}
