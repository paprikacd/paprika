"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Boxes,
  GitBranch,
  GitCompareArrows,
  LayoutGrid,
  Layers,
  LogOut,
  Map,
  Menu,
  Rocket,
  Server,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { useAuth } from "@/lib/auth-context"
import { cn } from "@/lib/utils"

interface NavigationItem {
  label: string
  icon: LucideIcon
  href: string
  /** Fleet-wide count shown at the trailing edge. Omitted when unknown. */
  badge?: string
}

interface NavigationSection {
  label: string
  items: NavigationItem[]
}

const navigationSections: NavigationSection[] = [
  {
    label: "Fleet",
    items: [
      { label: "Overview", href: "/dashboard/", icon: LayoutGrid },
      { label: "Applications", href: "/dashboard/applications/", icon: Boxes },
      { label: "Fleet map", href: "/dashboard/map/", icon: Map },
    ],
  },
  {
    label: "Delivery",
    items: [
      { label: "Pipelines", href: "/dashboard/pipelines/", icon: Workflow },
      { label: "Rollouts", href: "/dashboard/rollouts/", icon: Rocket },
      { label: "Sync & diff", href: "/dashboard/diff/", icon: GitCompareArrows },
    ],
  },
  {
    label: "Sources",
    items: [
      { label: "Repositories", href: "/dashboard/repositories/", icon: GitBranch },
      { label: "Templates", href: "/dashboard/templates/", icon: Layers },
      { label: "Clusters", href: "/dashboard/clusters/", icon: Server },
    ],
  },
]

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

export function Sidebar({ counts }: { counts?: Record<string, string> }) {
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
    if (pathname === "/dashboard" && hash === "#applications") {
      router.replace("/dashboard/applications/")
    }
  }, [hash, pathname, router])

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

  return (
    <>
      <header
        ref={mobileHeaderRef}
        data-dashboard-mobile-header
        className="sticky top-0 z-50 flex h-14 items-center justify-between border-b border-ink-rule bg-ink-surface px-3 lg:hidden"
      >
        <MobileBrand />
        <button
          ref={triggerRef}
          type="button"
          className="inline-flex size-11 items-center justify-center text-ink-on transition-colors duration-150 hover:bg-steel-800 active:bg-steel-700"
          aria-label="Open navigation"
          aria-controls="paprika-mobile-navigation"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <Menu className="size-5" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <aside
        ref={desktopSidebarRef}
        data-dashboard-desktop-sidebar
        className="fixed inset-y-0 left-0 z-40 hidden w-nav flex-col bg-ink-surface text-ink-on lg:flex"
      >
        <SidebarBrand />
        <SidebarNavigation
          pathname={pathname}
          counts={counts}
          onNavigate={() => setDrawerOpen(false)}
        />
        <SidebarFootnote />
      </aside>

      {drawerOpen ? (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="navigation-backdrop"
            className="absolute inset-0 cursor-default bg-foreground/50 animate-in fade-in duration-200"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            ref={drawerRef}
            id="paprika-mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Fleet navigation"
            className="relative flex h-dvh w-[min(20rem,calc(100vw-3rem))] flex-col bg-ink-surface text-ink-on animate-in slide-in-from-left duration-300"
          >
            <div className="flex h-14 items-center justify-between border-b border-ink-rule px-3">
              <MobileBrand />
              <button
                ref={closeRef}
                type="button"
                className="inline-flex size-11 items-center justify-center text-ink-on transition-colors duration-150 hover:bg-steel-800 active:bg-steel-700"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-5" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            {/* The drawer is a touch surface, so its rows keep the 44px
                target the dense desktop rail does not need. */}
            <SidebarNavigation
              pathname={pathname}
              counts={counts}
              roomy
              onNavigate={() => setDrawerOpen(false)}
            />
            <SidebarFootnote roomy />
          </aside>
        </div>
      ) : null}
    </>
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
  counts,
  roomy,
  onNavigate,
}: {
  pathname: string
  counts?: Record<string, string>
  roomy?: boolean
  onNavigate: () => void
}) {
  return (
    <nav aria-label="Fleet sections" className="flex-1 overflow-y-auto py-3">
      {navigationSections.map((section) => (
        <section
          key={section.label}
          aria-labelledby={`nav-${section.label.toLowerCase()}`}
          className="mb-3.5"
        >
          <h2
            id={`nav-${section.label.toLowerCase()}`}
            className="px-4 pb-1.5 font-mono text-kicker tracking-[0.18em] text-ink-kicker uppercase"
          >
            {section.label}
          </h2>
          {section.items.map((item) => (
            <SidebarItem
              key={item.label}
              item={item}
              badge={counts?.[item.label] ?? item.badge}
              active={isNavigationItemActive(item, pathname)}
              roomy={roomy}
              onNavigate={onNavigate}
            />
          ))}
        </section>
      ))}
    </nav>
  )
}

function SidebarItem({
  item,
  badge,
  active,
  roomy,
  onNavigate,
}: {
  item: NavigationItem
  badge?: string
  active: boolean
  roomy?: boolean
  onNavigate: () => void
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex w-full items-center gap-[9px] px-4 text-left font-cond text-label font-medium tracking-[0.05em] uppercase transition-colors duration-150",
        roomy ? "min-h-11" : "h-[29px]",
        active
          ? "bg-primary text-primary-foreground"
          : "text-ink-muted hover:bg-steel-800 hover:text-ink-on"
      )}
    >
      <Icon
        className="size-3.5 shrink-0 opacity-85"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <span className="flex-1">{item.label}</span>
      {badge ? (
        <span className="font-mono text-kicker opacity-55">{badge}</span>
      ) : null}
    </Link>
  )
}

function isNavigationItemActive(item: NavigationItem, pathname: string) {
  const href = normalizeDashboardPathname(item.href)
  if (href === "/dashboard") return pathname === "/dashboard"
  // `/dashboard/applications` also owns the single-application detail route.
  if (href === "/dashboard/applications") {
    return pathname.startsWith("/dashboard/application")
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

function SidebarBrand() {
  return (
    <div className="border-b border-ink-rule px-4 pt-3.5 pb-[13px]">
      <Link
        href="/dashboard/"
        className="block"
        aria-label="Paprika operations overview"
      >
        <span className="block font-cond text-count leading-none font-bold tracking-[0.14em]">
          PAPRIKA
        </span>
        <span className="mt-[5px] block font-mono text-kicker tracking-[0.12em] text-ink-accent">
          CONTROL PLANE
        </span>
      </Link>
    </div>
  )
}

function MobileBrand() {
  return (
    <Link
      href="/dashboard/"
      className="flex min-h-11 items-center"
      aria-label="Paprika operations overview"
    >
      <span className="font-cond text-card leading-none font-bold tracking-[0.14em]">
        PAPRIKA
      </span>
    </Link>
  )
}

function SidebarFootnote({ roomy }: { roomy?: boolean }) {
  const { user, isLoading, logout } = useAuth()

  if (isLoading || !user) {
    return (
      <div className="border-t border-ink-rule px-4 py-2.5">
        <p className="font-mono text-kicker tracking-[0.1em] text-ink-faint uppercase">
          Operations console
        </p>
      </div>
    )
  }

  const displayName = user.email || user.name || "Signed in"
  return (
    <div className="flex items-center gap-2 border-t border-ink-rule px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-cond text-console tracking-[0.04em]">
          {displayName}
        </p>
        <p className="font-mono text-kicker tracking-[0.1em] text-ink-faint uppercase">
          Platform · On-call
        </p>
      </div>
      {/* The source design drops sign-out entirely. Removing the only way to
          end a session is a functional regression rather than a style, so it
          stays — quieter, but reachable. */}
      <button
        type="button"
        className={cn(
          "inline-flex shrink-0 items-center justify-center text-ink-faint transition-colors hover:bg-steel-800 hover:text-ink-on",
          roomy ? "size-11" : "size-7"
        )}
        aria-label="Sign out"
        title="Sign out"
        onClick={logout}
      >
        <LogOut className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  )
}
