import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => {
  const replace = vi.fn()
  return {
    pathname: "/dashboard",
    search: "",
    replace,
    router: { replace },
  }
})

const authState = vi.hoisted(() => ({
  user: null as null | { name: string; email?: string; picture?: string },
  isLoading: false,
  logout: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
}))

import { AppShell } from "@/components/layout/app-shell"
import { Nav } from "@/components/layout/nav"

describe("AppShell navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboard"
    navigation.search = ""
    navigation.replace.mockReset()
    authState.user = null
    authState.isLoading = false
    authState.logout.mockReset()
    window.history.replaceState({}, "", "/dashboard")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders every destination with its exact static-export route", () => {
    render(<AppShell>Fleet content</AppShell>)

    const destinations = new Map([
      ["Overview", "/dashboard/"],
      ["Applications", "/dashboard/applications/"],
      ["Fleet map", "/dashboard/map/"],
      ["Pipelines", "/dashboard/pipelines/"],
      ["Rollouts", "/dashboard/rollouts/"],
      ["Sync & diff", "/dashboard/diff/"],
      ["Repositories", "/dashboard/repositories/"],
      ["Templates", "/dashboard/templates/"],
      ["Clusters", "/dashboard/clusters/"],
    ])
    // next/link normalises the trailing slash here; `trailingSlash: true`
    // restores it in the export, which e2e asserts against the real build.
    const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "")
    for (const [label, href] of destinations) {
      const actual = screen.getByRole("link", { name: label }).getAttribute("href")
      expect(withoutTrailingSlash(actual ?? "")).toBe(withoutTrailingSlash(href))
    }

    const main = screen.getByRole("main")
    expect(main).toHaveAttribute("id", "dashboard-main")
    const skipLink = screen.getByRole("link", { name: "Skip to fleet content" })
    expect(skipLink).toHaveAttribute("href", "#dashboard-main")
    expect(skipLink).toHaveClass("bg-primary", "text-primary-foreground")
  })

  it("groups destinations under the three fleet sections", () => {
    render(<AppShell>Fleet content</AppShell>)

    for (const section of ["Fleet", "Delivery", "Sources"]) {
      expect(
        screen.getByRole("heading", { name: section, level: 2 }),
      ).toBeInTheDocument()
    }
  })

  it("keeps the dense desktop rail but gives the touch drawer 44px rows", async () => {
    const user = userEvent.setup()
    render(<AppShell>Fleet content</AppShell>)

    expect(screen.getByRole("link", { name: "Overview" })).toHaveClass("h-[29px]")

    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })
    expect(within(drawer).getByRole("link", { name: "Overview" })).toHaveClass(
      "min-h-11",
    )
  })

  it("preserves authenticated identity and logout in the dashboard shell", async () => {
    const user = userEvent.setup()
    authState.user = { name: "Ada Platform", email: "ada@paprika.io" }
    render(<AppShell>Fleet content</AppShell>)

    expect(screen.getByText("ada@paprika.io")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Sign out" }))
    expect(authState.logout).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })
    const drawerSignOut = within(drawer).getByRole("button", { name: "Sign out" })
    // The drawer is a touch surface and keeps the larger target.
    expect(drawerSignOut).toHaveClass("size-11")
    await user.click(drawerSignOut)
    expect(authState.logout).toHaveBeenCalledTimes(2)
  })

  it("traps focus in the mobile drawer, closes on Escape, and restores the trigger", async () => {
    const user = userEvent.setup()
    render(<AppShell>Fleet content</AppShell>)

    const trigger = screen.getByRole("button", { name: "Open navigation" })
    expect(trigger).toHaveClass("size-11")
    trigger.focus()
    await user.click(trigger)

    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })
    const close = within(drawer).getByRole("button", { name: "Close navigation" })
    await waitFor(() => expect(close).toHaveFocus())

    const first = within(drawer).getByRole("link", { name: "Paprika operations overview" })
    first.focus()
    await user.tab({ shift: true })
    expect(within(drawer).getByRole("link", { name: "Clusters" })).toHaveFocus()
    await user.tab()
    expect(first).toHaveFocus()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Fleet navigation" })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("recaptures focus if it is moved behind the open drawer", async () => {
    const user = userEvent.setup()
    render(<AppShell>Fleet content</AppShell>)

    const trigger = screen.getByRole("button", { name: "Open navigation" })
    await user.click(trigger)
    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })

    trigger.focus()
    expect(within(drawer).getByRole("button", { name: "Close navigation" })).toHaveFocus()
  })

  it("makes the background inert and keeps the backdrop outside the accessibility tree", async () => {
    const user = userEvent.setup()
    const { container } = render(<AppShell>Fleet content</AppShell>)

    const content = container.querySelector<HTMLElement>("[data-dashboard-shell-content]")
    const mobileHeader = container.querySelector<HTMLElement>("[data-dashboard-mobile-header]")
    const desktopSidebar = container.querySelector<HTMLElement>("[data-dashboard-desktop-sidebar]")
    const skipLink = screen.getByRole("link", { name: "Skip to fleet content" })
    skipLink.setAttribute("inert", "")

    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    expect(content).toHaveAttribute("inert")
    expect(mobileHeader).toHaveAttribute("inert")
    expect(desktopSidebar).toHaveAttribute("inert")
    expect(skipLink).toHaveAttribute("inert")

    const backdrop = screen.getByTestId("navigation-backdrop")
    expect(backdrop).toHaveAttribute("tabindex", "-1")
    expect(backdrop).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByRole("button", { name: /navigation backdrop/i })).not.toBeInTheDocument()

    await user.click(backdrop)
    expect(screen.queryByRole("dialog", { name: "Fleet navigation" })).not.toBeInTheDocument()
    expect(content).not.toHaveAttribute("inert")
    expect(mobileHeader).not.toHaveAttribute("inert")
    expect(desktopSidebar).not.toHaveAttribute("inert")
    expect(skipLink).toHaveAttribute("inert", "")
  })

  it("closes the mobile modal and restores inert state at the desktop breakpoint", async () => {
    const user = userEvent.setup()
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(min-width: 1024px)",
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
    const { container } = render(<AppShell>Fleet content</AppShell>)

    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    const content = container.querySelector<HTMLElement>("[data-dashboard-shell-content]")
    expect(content).toHaveAttribute("inert")

    act(() => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent)
      }
    })
    expect(screen.queryByRole("dialog", { name: "Fleet navigation" })).not.toBeInTheDocument()
    expect(content).not.toHaveAttribute("inert")
  })

  it("migrates the legacy applications hash once without redirecting the dedicated route", async () => {
    window.history.replaceState({}, "", "/dashboard#applications")
    const { rerender } = render(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard/applications/")
    })

    navigation.pathname = "/dashboard/applications"
    rerender(<AppShell>Dedicated application inventory</AppShell>)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1))
  })

  it("migrates the legacy applications hash from the static-export dashboard path", async () => {
    navigation.pathname = "/dashboard/"
    window.history.replaceState({}, "", "/dashboard/#applications")
    render(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard/applications/")
    })
  })

  it.each([
    { label: "Overview", pathname: "/dashboard/" },
    { label: "Pipelines", pathname: "/dashboard/pipelines/" },
    { label: "Rollouts", pathname: "/dashboard/rollouts/" },
    { label: "Sync & diff", pathname: "/dashboard/diff/" },
    { label: "Fleet map", pathname: "/dashboard/map/" },
  ])("marks $label active for static-export dashboard URLs", async ({ label, pathname }) => {
    navigation.pathname = pathname
    window.history.replaceState({}, "", pathname)
    render(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page")
    })
    for (const other of ["Overview", "Pipelines", "Rollouts"].filter((item) => item !== label)) {
      expect(screen.getByRole("link", { name: other })).not.toHaveAttribute("aria-current")
    }
  })

  it("marks deep application routes as part of the Applications section", () => {
    navigation.pathname = "/dashboard/application"
    render(<AppShell>Application detail</AppShell>)

    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute(
      "aria-current",
      "page",
    )
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current")
  })
})

describe("console header", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboard"
    navigation.search = ""
    navigation.replace.mockReset()
    authState.user = null
    authState.isLoading = false
  })

  it("offers the three fleet scopes and a search field", () => {
    render(<AppShell>Fleet content</AppShell>)

    for (const scope of ["Project", "Cluster", "Stage"]) {
      expect(screen.getByText(scope)).toBeInTheDocument()
    }
    expect(
      screen.getByRole("searchbox", {
        name: "Search applications, resources, revisions and runs",
      }),
    ).toBeInTheDocument()
  })

  it("reports the poll cadence rather than claiming a live stream", () => {
    render(<AppShell>Fleet content</AppShell>)

    // The console has no push channel; the header must not imply one.
    expect(screen.queryByText(/^live/i)).not.toBeInTheDocument()
    expect(screen.getByText(/polling/i)).toBeInTheDocument()
  })

  it("debounces search so typing does not refetch on every keystroke", async () => {
    vi.useFakeTimers()
    try {
      render(<AppShell>Fleet content</AppShell>)

      const search = screen.getByRole("searchbox", {
        name: "Search applications, resources, revisions and runs",
      })

      // Three keystrokes in quick succession must collapse into one navigation.
      for (const value of ["c", "ch", "checkout"]) {
        fireEvent.change(search, { target: { value } })
        act(() => {
          vi.advanceTimersByTime(100)
        })
      }
      expect(navigation.replace).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace.mock.calls[0][0]).toContain("q=checkout")
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers a clear affordance only once a scope is engaged", () => {
    const { rerender } = render(<AppShell>Fleet content</AppShell>)
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument()

    navigation.search = "cluster=prod%2Fprod-eu-1"
    rerender(<AppShell>Fleet content</AppShell>)
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument()
  })
})

describe("root navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/login"
    authState.user = null
    authState.isLoading = false
  })

  it("keeps the minimal brand header on public and authentication routes", () => {
    render(<Nav />)

    expect(screen.getByRole("banner")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Paprika" })).toHaveAttribute("href", "/")
  })

  it("yields dashboard navigation to the unified shell", () => {
    navigation.pathname = "/dashboard/rollouts"
    render(<Nav />)

    expect(screen.queryByRole("banner")).not.toBeInTheDocument()
  })
})
