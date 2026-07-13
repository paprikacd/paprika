import { StrictMode } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => {
  const replace = vi.fn()
  return {
    pathname: "/dashboard",
    query: "",
    replace,
    router: { replace },
  }
})

const authState = vi.hoisted(() => ({
  user: null as null | { name: string; picture?: string },
  isLoading: false,
  logout: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
}))

import { AppShell } from "@/components/layout/app-shell"
import { Nav } from "@/components/layout/nav"

describe("AppShell navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboard"
    navigation.query = ""
    navigation.replace.mockReset()
    authState.user = null
    authState.isLoading = false
    authState.logout.mockReset()
    window.history.replaceState({}, "", "/dashboard")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders every working destination with its exact route", () => {
    render(<AppShell>Fleet content</AppShell>)

    const destinations = new Map([
      ["Overview", "/dashboard"],
      ["Applications", "/dashboard/applications"],
      ["Pipelines", "/dashboard#pipelines"],
      ["Releases", "/dashboard/releases"],
      ["Rollouts", "/dashboard/rollouts"],
    ])
    for (const [label, href] of destinations) {
      const link = screen.getByRole("link", { name: label })
      expect(link).toHaveAttribute("href", href)
      expect(link).toHaveClass("min-h-11")
    }

    const main = screen.getByRole("main")
    expect(main).toHaveAttribute("id", "dashboard-main")
    expect(screen.getByRole("link", { name: "Skip to fleet content" })).toHaveAttribute(
      "href",
      "#dashboard-main",
    )
    expect(screen.getByRole("link", { name: "Skip to fleet content" })).toHaveClass(
      "bg-primary",
      "text-background",
    )
    expect(screen.getByRole("link", { name: "Skip to fleet content" })).not.toHaveClass(
      "text-primary-foreground",
    )
  })

  it("preserves authenticated identity and logout in the dashboard shell", async () => {
    const user = userEvent.setup()
    authState.user = { name: "Ada Platform" }
    render(<AppShell>Fleet content</AppShell>)

    expect(screen.getByText("Ada Platform")).toBeInTheDocument()
    const signOut = screen.getByRole("button", { name: "Sign out" })
    expect(signOut).toHaveClass("size-11")
    await user.click(signOut)
    expect(authState.logout).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Open navigation" }))
    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })
    expect(within(drawer).getByText("Ada Platform")).toBeInTheDocument()
    const drawerSignOut = within(drawer).getByRole("button", { name: "Sign out" })
    expect(drawerSignOut).toHaveClass("size-11")
    await user.click(drawerSignOut)
    expect(authState.logout).toHaveBeenCalledTimes(2)
  })

  it("renders Activity and Admin as disabled non-links with roadmap context", () => {
    render(<AppShell>Fleet content</AppShell>)

    for (const label of ["Activity", "Admin"]) {
      expect(screen.queryByRole("link", { name: new RegExp(label, "i") })).not.toBeInTheDocument()
      const button = screen.getByRole("button", {
        name: new RegExp(`${label}.*Available in a later plan`, "i"),
      })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("aria-disabled", "true")
      expect(button).toHaveAttribute("title", "Available in a later plan")
    }
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
    expect(within(drawer).getByRole("link", { name: "Rollouts" })).toHaveFocus()
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
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard/applications")
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
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard/applications")
    })
  })

  it("links Releases to the dedicated route with repeated scope parameters only", () => {
    navigation.pathname = "/dashboard/releases"
    navigation.query =
      "project=team%2Fpayments&project=team%2Fplatform&cluster=platform%2Fprod" +
      "&cluster=platform%2Fcanary&stage=production&stage=canary&namespace=apps" +
      "&namespace=platform&q=dashboard-search&view=queue&group=health&selected=apps%2Fcheckout"
    window.history.replaceState({}, "", `/dashboard/releases?${navigation.query}`)

    render(<AppShell>Release inventory</AppShell>)

    expect(screen.getByRole("link", { name: "Releases" })).toHaveAttribute(
      "href",
      "/dashboard/releases?project=team%2Fpayments&project=team%2Fplatform" +
        "&cluster=platform%2Fcanary&cluster=platform%2Fprod&stage=canary&stage=production" +
        "&namespace=apps&namespace=platform",
    )
    expect(screen.getByRole("link", { name: "Releases" })).toHaveAttribute(
      "aria-current",
      "page",
    )
  })

  it.each([
    { pathname: "/dashboard", url: "/dashboard#releases" },
    { pathname: "/dashboard/", url: "/dashboard/#releases" },
  ])("migrates $url once to the scoped release route under Strict Mode", async ({ pathname, url }) => {
    navigation.pathname = pathname
    navigation.query =
      "project=team%2Fpayments&project=team%2Fplatform&cluster=platform%2Fprod" +
      "&stage=production&namespace=apps&namespace=platform&view=matrix&selected=apps%2Fcheckout"
    window.history.replaceState({}, "", `${url.split("#")[0]}?${navigation.query}#releases`)

    render(
      <StrictMode>
        <AppShell>Fleet content</AppShell>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith(
        "/dashboard/releases?project=team%2Fpayments&project=team%2Fplatform" +
          "&cluster=platform%2Fprod&stage=production&namespace=apps&namespace=platform",
      )
    })
  })

  it("migrates the same legacy release URL once again after leaving and returning", async () => {
    navigation.pathname = "/dashboard"
    navigation.query = "namespace=apps"
    window.history.replaceState({}, "", "/dashboard?namespace=apps#releases")
    const view = () => (
      <StrictMode>
        <AppShell>Fleet content</AppShell>
      </StrictMode>
    )
    const { rerender } = render(view())

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1))

    act(() => {
      navigation.pathname = "/dashboard/releases"
      window.history.replaceState({}, "", "/dashboard/releases?namespace=apps")
      window.dispatchEvent(new HashChangeEvent("hashchange"))
      rerender(view())
    })
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Releases" })).toHaveAttribute(
        "aria-current",
        "page",
      )
    })

    act(() => {
      navigation.pathname = "/dashboard"
      window.history.replaceState({}, "", "/dashboard?namespace=apps#releases")
      window.dispatchEvent(new HashChangeEvent("hashchange"))
      rerender(view())
    })

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(2)
      expect(navigation.replace).toHaveBeenNthCalledWith(
        2,
        "/dashboard/releases?namespace=apps",
      )
    })
  })

  it.each([
    { label: "Overview", pathname: "/dashboard/", hash: "" },
    { label: "Pipelines", pathname: "/dashboard/", hash: "#pipelines" },
    { label: "Releases", pathname: "/dashboard/releases/", hash: "" },
  ])("marks $label active for static-export dashboard URLs", async ({ label, pathname, hash }) => {
    navigation.pathname = pathname
    window.history.replaceState({}, "", `${pathname}${hash}`)
    render(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page")
    })
    for (const other of ["Overview", "Pipelines", "Releases"].filter((item) => item !== label)) {
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
