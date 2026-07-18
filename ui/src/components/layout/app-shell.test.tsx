import { readFileSync } from "node:fs"
import path from "node:path"
import { StrictMode, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => {
  const replace = vi.fn()
  return {
    pathname: "/dashboard",
    query: "",
    suspendSearchParams: false,
    searchParamsSuspension: new Promise<never>(() => undefined),
    replace,
    router: { replace },
  }
})

const authState = vi.hoisted(() => ({
  user: null as null | { name: string; picture?: string },
  isLoading: false,
  logout: vi.fn(),
}))

const fleetRpc = vi.hoisted(() => ({
  queryFleetMap: vi.fn(),
}))

const validAdminSession = {
  subject: "alice@example.com",
  accessMode: "kubernetes-port-forward-admin",
  idleExpiresAt: "2099-07-18T05:10:00Z",
  absoluteExpiresAt: "2099-07-18T05:30:00Z",
}

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => {
    if (navigation.suspendSearchParams) throw navigation.searchParamsSuspension
    return new URLSearchParams(navigation.query)
  },
}))

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
}))

vi.mock("@/lib/fleet-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fleet-client")>()
  return {
    ...actual,
    queryFleetMap: fleetRpc.queryFleetMap,
  }
})

import { AppShell } from "@/components/layout/app-shell"
import { Nav } from "@/components/layout/nav"
import { useFleetScope } from "@/lib/fleet-scope-context"
import { useFleetData } from "@/lib/use-fleet-data"

const uiRoot = process.cwd().endsWith(`${path.sep}ui`)
  ? process.cwd()
  : path.resolve(process.cwd(), "ui")

function renderShell(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  })
  return {
    queryClient,
    ...render(ui, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }),
  }
}

function ApplicationsMapProbe() {
  const { state } = useFleetScope()
  const fleet = useFleetData({
    ...state,
    view: "treemap",
    density: "comfortable",
    labels: "all",
  })
  return <output data-testid="applications-map-status">{fleet.status}</output>
}

function cssRule(selector: string) {
  const css = readFileSync(path.join(uiRoot, "src/app/globals.css"), "utf8")
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ""
}

describe("AppShell navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/dashboard"
    navigation.query = ""
    navigation.suspendSearchParams = false
    navigation.replace.mockReset()
    authState.user = null
    authState.isLoading = false
    authState.logout.mockReset()
    fleetRpc.queryFleetMap.mockReset()
    fleetRpc.queryFleetMap.mockResolvedValue({
      roots: [],
      total: BigInt(0),
      indexGeneration: BigInt(1),
      facets: [],
    })
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, { status: 404 }),
      ),
    )
    window.history.replaceState({}, "", "/dashboard")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders every working destination with its exact route", () => {
    navigation.query = "namespace=apps&view=heatmap&unknown=kept"
    renderShell(<AppShell>Fleet content</AppShell>)

    const destinations = new Map([
      ["Overview", "/dashboard?namespace=apps&view=heatmap&unknown=kept"],
      ["Applications", "/dashboard/applications?namespace=apps&view=heatmap&unknown=kept"],
      ["Pipelines", "/dashboard?namespace=apps&view=heatmap&unknown=kept#pipelines"],
      ["Releases", "/dashboard/releases?namespace=apps&view=heatmap&unknown=kept"],
      ["Rollouts", "/dashboard/rollouts?namespace=apps&view=heatmap&unknown=kept"],
    ])
    for (const [label, href] of destinations) {
      const link = screen.getByRole("link", { name: label })
      expect(link).toHaveAttribute("href", href)
      expect(link).toHaveClass("min-h-11")
    }

    const main = screen.getByRole("main")
    expect(main).toHaveAttribute("id", "dashboard-main")
  })

  it("keeps an explicit ordinary session unmarked", async () => {
    renderShell(<AppShell>Fleet content</AppShell>)

    await waitFor(() =>
      expect(
        screen.queryByText("Session security status unknown"),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.queryByText(
        "Kubernetes port-forward admin session · unrestricted Paprika access",
      ),
    ).not.toBeInTheDocument()
  })

  it("keeps the admin marker across the shell without obscuring mobile controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(validAdminSession), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )

    const { container } = renderShell(<AppShell>Fleet content</AppShell>)

    const banner = await screen.findByRole("status", {
      name: "Kubernetes port-forward admin session",
    })
    const rail = container.querySelector("[data-dashboard-sticky-rail]")
    const scope = screen.getByRole("region", { name: "Current fleet scope" })
    expect(rail).toHaveClass("sticky", "top-14", "lg:top-0")
    expect(rail).toContainElement(banner)
    expect(rail).toContainElement(scope)
    expect(
      banner.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Open navigation" }))
      .toBeInTheDocument()
    expect(screen.getByRole("main")).toHaveTextContent("Fleet content")
  })

  it("keeps unknown session security visible while the fleet shell remains usable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(
        new TypeError("admin session probe failed"),
      ),
    )

    renderShell(<AppShell>Fleet content</AppShell>)

    expect(
      await screen.findByRole("alert", {
        name: "Session security status unknown",
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled()
    expect(screen.getByRole("region", { name: "Current fleet scope" }))
      .toBeInTheDocument()
    expect(screen.getByRole("main")).toHaveTextContent("Fleet content")
  })

  it("mounts one shared scope provider and reuses one semantic map request with Applications", async () => {
    navigation.pathname = "/dashboard/applications"
    navigation.query =
      "project=team%2Fpayments&namespace=apps&q=checkout&group=namespace" +
      "&view=heatmap&density=compact&labels=none"
    const { queryClient } = renderShell(
      <AppShell>
        <ApplicationsMapProbe />
      </AppShell>,
    )

    await waitFor(() =>
      expect(screen.getByTestId("applications-map-status")).toHaveTextContent("empty"),
    )

    expect(fleetRpc.queryFleetMap).toHaveBeenCalledOnce()
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["fleet", "map"] }),
    ).toHaveLength(1)
  })

  it("renders interactive scope controls in order and clears only fleet scope", async () => {
    const user = userEvent.setup()
    navigation.query =
      "project=team%2Fpayments&cluster=platform%2Fprod&stage=production" +
      "&namespace=apps&page=4&selected=apps%2Fcheckout&unknown=kept"
    fleetRpc.queryFleetMap.mockResolvedValue({
      roots: [],
      total: BigInt(0),
      indexGeneration: BigInt(1),
      facets: [
        {
          dimension: "project",
          object: { namespace: "team", name: "payments" },
          label: "Payments",
          count: BigInt(12),
        },
        {
          dimension: "cluster",
          object: { namespace: "platform", name: "prod" },
          label: "Production",
          count: BigInt(9),
        },
        {
          dimension: "stage",
          value: "production",
          label: "Production",
          count: BigInt(9),
        },
        {
          dimension: "namespace",
          value: "apps",
          label: "apps",
          count: BigInt(7),
        },
      ],
    })

    const { container } = renderShell(<AppShell>Fleet content</AppShell>)
    const scope = screen.getByRole("region", { name: "Current fleet scope" })
    await waitFor(() =>
      expect(
        within(scope).getByRole("button", {
          name: "Projects, Payments, 1 result",
        }),
      ).toBeInTheDocument(),
    )

    const controlNames = within(scope)
      .getAllByRole("button")
      .slice(0, 4)
      .map((button) => button.getAttribute("aria-label"))
    expect(controlNames).toEqual([
      "Projects, Payments, 1 result",
      "Clusters, Production, 1 result",
      "Stages, Production, 1 result",
      "Namespaces, apps, 1 result",
    ])
    expect(
      container.querySelector("[data-fleet-scope-scroll]"),
    ).toHaveClass("overflow-x-auto", "overscroll-x-contain")
    expect(
      container.querySelector("[data-fleet-scope-controls]"),
    ).toHaveClass("min-w-max")

    await user.click(
      within(scope).getByRole("button", { name: "Clear fleet scope" }),
    )
    expect(navigation.replace).toHaveBeenCalledWith(
      "/dashboard?unknown=kept",
      { scroll: false },
    )
    expect(
      within(scope).getByRole("button", {
        name: /Projects, All projects, loading results/i,
      }),
    ).toHaveFocus()
  })

  it("lets global Clear cancel an unobserved local selection before the next selection", async () => {
    const user = userEvent.setup()
    fleetRpc.queryFleetMap.mockResolvedValue({
      roots: [],
      total: BigInt(2),
      indexGeneration: BigInt(1),
      facets: [
        {
          dimension: "stage",
          value: "canary",
          label: "canary",
          count: BigInt(1),
        },
        {
          dimension: "stage",
          value: "staging",
          label: "staging",
          count: BigInt(1),
        },
      ],
    })
    const { rerender } = renderShell(<AppShell>Fleet content</AppShell>)

    const scope = screen.getByRole("region", { name: "Current fleet scope" })
    const allStages = await within(scope).findByRole("button", {
      name: "Stages, All stages, 2 results",
    })
    await user.click(allStages)
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, canary/i }),
    )

    await user.click(
      within(scope).getByRole("button", { name: "Clear fleet scope" }),
    )
    const intermediate = new URL(
      navigation.replace.mock.calls[0][0],
      "https://paprika.test",
    )
    navigation.query = intermediate.searchParams.toString()
    rerender(<AppShell>Fleet content</AppShell>)

    const resetStages = await within(scope).findByRole("button", {
      name: "Stages, All stages, loading results",
    })
    await user.click(resetStages)
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, staging/i }),
    )

    const destination = new URL(
      navigation.replace.mock.calls.at(-1)![0],
      "https://paprika.test",
    )
    expect(destination.searchParams.getAll("stage")).toEqual(["staging"])
  })

  it("invalidates a pending picker selection when popstate resets to the observed scope", async () => {
    const user = userEvent.setup()
    navigation.query = "stage=canary"
    fleetRpc.queryFleetMap.mockResolvedValue({
      roots: [],
      total: BigInt(3),
      indexGeneration: BigInt(1),
      facets: ["canary", "production", "staging"].map((value) => ({
        dimension: "stage" as const,
        value,
        label: value,
        count: BigInt(1),
      })),
    })
    renderShell(
      <StrictMode>
        <AppShell>Fleet content</AppShell>
      </StrictMode>,
    )

    const scope = screen.getByRole("region", { name: "Current fleet scope" })
    await user.click(
      await within(scope).findByRole("button", {
        name: "Stages, canary, 3 results",
      }),
    )
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, production/i }),
    )
    expect(
      screen.getByRole("checkbox", { name: /Stages, production/i }),
    ).toBeChecked()

    act(() => window.dispatchEvent(new PopStateEvent("popstate")))

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Stages, production/i }),
      ).not.toBeChecked(),
    )
    await user.click(
      screen.getByRole("checkbox", { name: /Stages, staging/i }),
    )

    const destination = new URL(
      navigation.replace.mock.calls.at(-1)![0],
      "https://paprika.test",
    )
    expect(destination.searchParams.getAll("stage")).toEqual([
      "canary",
      "staging",
    ])
    expect(destination.searchParams.has("stage", "production")).toBe(false)
  })

  it("surfaces an ambiguous legacy detail URL instead of making scope controls look inert", async () => {
    const user = userEvent.setup()
    navigation.pathname = "/dashboard/application"
    navigation.query =
      "namespace=apps&namespace=platform&name=checkout&unknown=kept"
    fleetRpc.queryFleetMap.mockResolvedValue({
      roots: [],
      total: BigInt(0),
      indexGeneration: BigInt(1),
      facets: [
        {
          dimension: "namespace",
          value: "apps",
          label: "apps",
          count: BigInt(1),
        },
        {
          dimension: "namespace",
          value: "platform",
          label: "platform",
          count: BigInt(1),
        },
      ],
    })
    renderShell(<AppShell>Application detail</AppShell>)

    const scope = screen.getByRole("region", { name: "Current fleet scope" })
    await user.click(
      within(scope).getByRole("button", { name: "Clear fleet scope" }),
    )

    expect(navigation.replace).not.toHaveBeenCalled()
    expect(within(scope).getByRole("alert")).toHaveTextContent(
      "This legacy detail URL has multiple namespaces. Open a canonical detail link before changing fleet scope.",
    )
  })

  it("keeps the navigable dashboard shell visible while fleet scope suspends", () => {
    navigation.suspendSearchParams = true

    renderShell(<AppShell>Fleet content</AppShell>)

    expect(
      screen.getByRole("link", { name: "Skip to fleet content" }),
    ).toHaveAttribute("href", "#dashboard-main")
    expect(
      screen.getAllByRole("link", { name: "Paprika operations overview" }),
    ).not.toHaveLength(0)
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "/dashboard",
    )
    const scopeFallback = screen.getByRole("region", {
      name: "Current fleet scope",
    })
    expect(scopeFallback).toHaveAttribute("aria-busy", "true")
    expect(scopeFallback).toHaveTextContent("All projects")
    expect(scopeFallback).toHaveTextContent("All clusters")
    expect(scopeFallback).toHaveTextContent("All stages")
    expect(scopeFallback).toHaveTextContent("All namespaces")
    expect(within(scopeFallback).queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByRole("main")).toHaveAttribute("id", "dashboard-main")
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading fleet scope…",
    )
    expect(screen.queryByText("Fleet content")).not.toBeInTheDocument()
  })

  it("uses one explicit skip-link hook with a fixed clipped and focus-visible contract", () => {
    renderShell(<AppShell>Fleet content</AppShell>)

    const skipLink = screen.getByRole("link", { name: "Skip to fleet content" })
    const main = screen.getByRole("main")
    expect(skipLink).toHaveAttribute("href", "#dashboard-main")
    expect(main).not.toHaveClass("outline-none")
    expect(skipLink.className.split(/\s+/)).toEqual([
      "dashboard-skip-link",
      "bg-primary",
      "px-4",
      "py-3",
      "text-sm",
      "font-semibold",
      "text-background",
    ])
    expect(skipLink.className).not.toMatch(/(?:^|\s)sr-only(?:\s|$)/)
    expect(skipLink.className).not.toContain("focus:not-sr-only")

    const hiddenRule = cssRule(".dashboard-skip-link")
    expect(hiddenRule).toMatch(/position:\s*fixed\s*;/)
    expect(hiddenRule).toMatch(/left:\s*1rem\s*;/)
    expect(hiddenRule).toMatch(/top:\s*1rem\s*;/)
    expect(hiddenRule).toMatch(/z-index:\s*100\s*;/)
    expect(hiddenRule).toMatch(/width:\s*1px\s*;/)
    expect(hiddenRule).toMatch(/height:\s*1px\s*;/)
    expect(hiddenRule).toMatch(/overflow:\s*hidden\s*;/)
    expect(hiddenRule).toMatch(/white-space:\s*nowrap\s*;/)
    expect(hiddenRule).toMatch(/clip-path:\s*inset\(50%\)\s*;/)

    const focusRule = cssRule(".dashboard-skip-link:focus-visible")
    expect(focusRule).toMatch(/display:\s*flex\s*;/)
    expect(focusRule).toMatch(/align-items:\s*center\s*;/)
    expect(focusRule).toMatch(/width:\s*auto\s*;/)
    expect(focusRule).toMatch(/height:\s*auto\s*;/)
    expect(focusRule).toMatch(/min-height:\s*44px\s*;/)
    expect(focusRule).toMatch(/overflow:\s*visible\s*;/)
    expect(focusRule).toMatch(/white-space:\s*normal\s*;/)
    expect(focusRule).toMatch(/clip-path:\s*inset\(0\)\s*;/)
  })

  it("preserves authenticated identity and logout in the dashboard shell", async () => {
    const user = userEvent.setup()
    authState.user = { name: "Ada Platform" }
    renderShell(<AppShell>Fleet content</AppShell>)

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
    renderShell(<AppShell>Fleet content</AppShell>)

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
    renderShell(<AppShell>Fleet content</AppShell>)

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
    renderShell(<AppShell>Fleet content</AppShell>)

    const trigger = screen.getByRole("button", { name: "Open navigation" })
    await user.click(trigger)
    const drawer = screen.getByRole("dialog", { name: "Fleet navigation" })

    trigger.focus()
    expect(within(drawer).getByRole("button", { name: "Close navigation" })).toHaveFocus()
  })

  it("makes the background inert and keeps the backdrop outside the accessibility tree", async () => {
    const user = userEvent.setup()
    const { container } = renderShell(<AppShell>Fleet content</AppShell>)

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
    const { container } = renderShell(<AppShell>Fleet content</AppShell>)

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
    const { rerender } = renderShell(<AppShell>Fleet content</AppShell>)

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
    renderShell(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith("/dashboard/applications")
    })
  })

  it("links Releases to the dedicated route without losing presentation or unknown parameters", () => {
    navigation.pathname = "/dashboard/releases"
    navigation.query =
      "project=team%2Fpayments&project=team%2Fplatform&cluster=platform%2Fprod" +
      "&cluster=platform%2Fcanary&stage=production&stage=canary&namespace=apps" +
      "&namespace=platform&q=dashboard-search&view=queue&group=health&selected=apps%2Fcheckout&unknown=kept"
    window.history.replaceState({}, "", `/dashboard/releases?${navigation.query}`)

    renderShell(<AppShell>Release inventory</AppShell>)

    expect(screen.getByRole("link", { name: "Releases" })).toHaveAttribute(
      "href",
      "/dashboard/releases?project=team%2Fpayments&project=team%2Fplatform" +
        "&cluster=platform%2Fprod&cluster=platform%2Fcanary&stage=production&stage=canary" +
        "&namespace=apps&namespace=platform&q=dashboard-search&view=queue&group=health" +
        "&selected=apps%2Fcheckout&unknown=kept",
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

    renderShell(
      <StrictMode>
        <AppShell>Fleet content</AppShell>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledTimes(1)
      expect(navigation.replace).toHaveBeenCalledWith(
        "/dashboard/releases?project=team%2Fpayments&project=team%2Fplatform" +
          "&cluster=platform%2Fprod&stage=production&namespace=apps&namespace=platform" +
          "&view=matrix&selected=apps%2Fcheckout",
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
    const { rerender } = renderShell(view())

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
    renderShell(<AppShell>Fleet content</AppShell>)

    await waitFor(() => {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page")
    })
    for (const other of ["Overview", "Pipelines", "Releases"].filter((item) => item !== label)) {
      expect(screen.getByRole("link", { name: other })).not.toHaveAttribute("aria-current")
    }
  })

  it("marks deep application routes as part of the Applications section", () => {
    navigation.pathname = "/dashboard/application"
    renderShell(<AppShell>Application detail</AppShell>)

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
