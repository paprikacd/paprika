import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  query: "",
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

import { FleetHealthHeatmap } from "@/components/fleet/fleet-health-heatmap"
import {
  clipHeatmapCells,
  layoutHeatmap,
  type HeatmapLayoutResult,
} from "@/components/fleet/heatmap-layout"
import type {
  FleetHealthStatus,
  FleetMapNode,
  FleetMapResult,
} from "@/lib/fleet-client"

describe("FleetHealthHeatmap", () => {
  const context = canvasContext()
  let bounds = rect(0, 0, 640, 240)
  let clientBox: { width: number; height: number; left: number; top: number } | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    context.fillStyles.length = 0
    context.strokeStyles.length = 0
    context.paintBatches.length = 0
    bounds = rect(0, 0, 640, 240)
    clientBox = null
    navigation.query = ""
    ResizeObserverMock.instances.length = 0

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => bounds,
    )
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => clientBox?.width ?? bounds.width,
    )
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      () => clientBox?.height ?? bounds.height,
    )
    vi.spyOn(HTMLElement.prototype, "clientLeft", "get").mockImplementation(
      () => clientBox?.left ?? 0,
    )
    vi.spyOn(HTMLElement.prototype, "clientTop", "get").mockImplementation(
      () => clientBox?.top ?? 0,
    )
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0)
      return 41
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("exposes only complete non-identity layout oracles on a viewport-sized canvas", async () => {
    const map = result([
      group("opaque-group-payments", [
        application("opaque-app-checkout", "checkout", "healthy"),
        application("opaque-app-ledger", "ledger", "failed"),
      ]),
    ])
    const { container } = renderHeatmap({ result: map, density: "comfortable" })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled())

    expect(host).toHaveAttribute("data-heatmap-input-count", "2")
    expect(host).toHaveAttribute("data-heatmap-layout-count", "2")
    expect(host.getAttribute("data-heatmap-layout-digest")).toMatch(/^hm1-[0-9a-f]{16}$/u)
    expect(
      host
        .getAttributeNames()
        .filter((name) => name.startsWith("data-heatmap-")),
    ).toEqual([
      "data-heatmap-input-count",
      "data-heatmap-layout-count",
      "data-heatmap-layout-digest",
    ])

    const canvas = within(host).getByTestId("fleet-health-heatmap-canvas") as HTMLCanvasElement
    expect(canvas.width).toBe(1_280)
    expect(canvas.height).toBe(480)
    expect(canvas.style.width).toBe("640px")
    expect(canvas.style.height).toBe("240px")
    expect(container.innerHTML).not.toContain("opaque-app-checkout")
    expect(container.innerHTML).not.toContain("opaque-app-ledger")

    const paintCount = context.clearRect.mock.calls.length
    bounds = rect(0, 0, 320, 100)
    ResizeObserverMock.instances[0]?.callback(
      [],
      ResizeObserverMock.instances[0] as unknown as ResizeObserver,
    )
    await waitFor(() => expect(context.clearRect.mock.calls.length).toBeGreaterThan(paintCount))
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(200)
    expect(canvas.style.width).toBe("320px")
    expect(canvas.style.height).toBe("100px")
  })

  it("lays out and hit-tests from the bordered host content box without horizontal overflow", async () => {
    bounds = rect(10, 20, 640, 240)
    clientBox = { width: 636, height: 234, left: 2, top: 3 }
    renderHeatmap({
      result: result([
        group("opaque-border-group", [
          application("opaque-alpha-border", "alpha", "healthy"),
          application("opaque-beta-border", "beta", "healthy"),
        ]),
      ]),
      density: "comfortable",
      sort: "name",
      direction: "asc",
      selected: { namespace: "apps", name: "beta" },
    })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    const canvas = within(host).getByTestId("fleet-health-heatmap-canvas") as HTMLCanvasElement
    await waitFor(() => {
      expect(canvas.width).toBe(1_272)
      expect(canvas.height).toBe(468)
    })
    expect(canvas.style.width).toBe("636px")
    expect(canvas.style.height).toBe("234px")

    const measuredPaint = context.paintBatches.at(-1)
    expect(measuredPaint).toBeDefined()
    for (const [x, , width] of measuredPaint?.fills ?? []) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x + width).toBeLessThanOrEqual(636)
    }

    fireEvent.pointerMove(host, {
      clientX: bounds.left + clientBox.left + 51,
      clientY: bounds.top + clientBox.top + 30,
    })
    expect(await screen.findByRole("tooltip")).toHaveTextContent("alpha")
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent(
      "alpha",
    )
  })

  it("paints only visible cells while retaining complete virtual geometry", async () => {
    bounds = rect(0, 0, 484, 124)
    clientBox = { width: 480, height: 120, left: 2, top: 2 }
    const applications = Array.from({ length: 10_000 }, (_, index) =>
      application(
        `opaque-secret-${index.toString().padStart(5, "0")}`,
        `app-${index.toString().padStart(5, "0")}`,
        index % 2 === 0 ? "healthy" : "degraded",
      ),
    )
    const roots = [group("opaque-group-all", applications)]
    const { container } = renderHeatmap({
      result: result(roots),
      density: "compact",
      labels: "none",
      sort: "name",
      direction: "asc",
    })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    await waitFor(() => expect(host).toHaveAttribute("data-heatmap-layout-count", "10000"))
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled())

    const canvas = within(host).getByTestId("fleet-health-heatmap-canvas") as HTMLCanvasElement
    await waitFor(() => expect(canvas.height).toBe(240))
    const expectedLayout = layoutHeatmap({
      roots,
      width: 480,
      viewportHeight: 120,
      scrollTop: 0,
      density: "compact",
      labels: "none",
      sort: "name",
      direction: "asc",
    })
    const initialPaint = context.paintBatches.at(-1)
    expect(initialPaint?.fills).toEqual(
      expectedHeatmapFillRects(expectedLayout, 0, 480, 120),
    )
    const virtualContent = host.querySelector("div[aria-hidden='true'][style*='height']") as HTMLElement
    expect(canvas.height).toBe(240)
    expect(Number.parseFloat(virtualContent.style.height)).toBeGreaterThan(120)

    const digest = host.getAttribute("data-heatmap-layout-digest")
    const paintBatchCount = context.paintBatches.length
    host.scrollTop = 1_000
    fireEvent.scroll(host)

    await waitFor(() => expect(context.paintBatches.length).toBeGreaterThan(paintBatchCount))
    const scrolledPaint = context.paintBatches.at(-1)
    expect(scrolledPaint?.fills).toEqual(
      expectedHeatmapFillRects(expectedLayout, 1_000, 480, 120),
    )
    expect(host).toHaveAttribute("data-heatmap-layout-count", "10000")
    expect(host).toHaveAttribute("data-heatmap-layout-digest", digest)
    expect(container.querySelectorAll("[tabindex], button, a, input, select, textarea").length).toBeLessThan(20)
    expect(container.innerHTML).not.toContain("opaque-secret-09999")

    fireEvent.pointerMove(host, { clientX: 6, clientY: 30 })
    expect(await screen.findByRole("tooltip")).toHaveTextContent("app-03360")
  })

  it("reinforces every health fill with the established glyph and pattern vocabulary", async () => {
    const statuses: FleetHealthStatus[] = [
      "failed",
      "degraded",
      "progressing",
      "missing",
      "unknown",
      "healthy",
    ]
    renderHeatmap({
      result: result([
        group(
          "opaque-group-health",
          statuses.map((health) => application(`opaque-${health}`, health, health)),
        ),
      ]),
      density: "comfortable",
      labels: "none",
    })

    await waitFor(() => expect(context.fillRect).toHaveBeenCalled())
    expect(context.fillStyles).toEqual(
      expect.arrayContaining(["#382324", "#382922", "#332e22", "#292623", "#2b2926", "#273126"]),
    )
    expect(context.fillText.mock.calls.map(([text]) => text)).toEqual(
      expect.arrayContaining(["×", "!", "↻", "∅", "?", "✓"]),
    )
    expect(context.setLineDash).toHaveBeenCalledWith(expect.any(Array))
  })

  it("reports exact visible group counts and distributions without semantic app rows", () => {
    const { container } = renderHeatmap({
      result: result([
        group("opaque-a", [
          application("opaque-a-1", "checkout", "failed"),
          application("opaque-a-2", "ledger", "healthy"),
        ], "Payments"),
        group("opaque-b", [
          application("opaque-b-1", "catalog", "progressing"),
        ], "Storefront"),
      ]),
      density: "comfortable",
    })

    const summaries = screen.getByRole("list", { name: "Visible heatmap groups" })
    expect(within(summaries).getAllByRole("listitem")).toHaveLength(2)
    expect(within(summaries).getByText(/Payments · 2 applications · Failed 1 · Healthy 1/u)).toBeVisible()
    expect(within(summaries).getByText(/Storefront · 1 application · Progressing 1/u)).toBeVisible()

    const legend = screen.getByRole("list", { name: "Heatmap health legend" })
    expect(within(legend).getByText(/Failed 1/u)).toBeVisible()
    expect(within(legend).getByText(/Progressing 1/u)).toBeVisible()
    expect(within(legend).getByText(/Healthy 1/u)).toBeVisible()
    expect(container.querySelectorAll("[role='option'], [role='gridcell'], [role='row']")).toHaveLength(0)
  })

  it("paints and summarizes a group header when no application cell intersects the viewport", async () => {
    bounds = rect(0, 0, 240, 10)
    renderHeatmap({
      result: result([
        group("opaque-payments", [
          application("opaque-checkout", "checkout", "healthy"),
        ], "Payments"),
      ]),
      density: "comfortable",
    })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    const canvas = within(host).getByTestId("fleet-health-heatmap-canvas") as HTMLCanvasElement
    await waitFor(() => expect(canvas.height).toBe(20))
    context.fillText.mockClear()
    host.scrollTop = 1
    fireEvent.scroll(host)
    await waitFor(() => {
      expect(context.fillText).toHaveBeenCalledWith(
        expect.stringContaining("Payments"),
        expect.any(Number),
        expect.any(Number),
      )
    })
    expect(screen.getByRole("list", { name: "Visible heatmap groups" })).toHaveTextContent(
      "Payments · 1 application · Healthy 1",
    )
    expect(context.fillText).not.toHaveBeenCalledWith(
      "checkout",
      expect.any(Number),
      expect.any(Number),
    )
  })

  it("keeps a bounded metadata tooltip and semantic focus synchronized", async () => {
    const onFocusedApplication = vi.fn()
    const issue = "Database readiness probe is failing. ".repeat(30)
    const { container } = renderHeatmap({
      result: result([
        group("opaque-group", [
          application("opaque-checkout", "checkout", "healthy"),
          application("opaque-ledger", "ledger", "degraded", {
            issueSummary: issue,
          }),
        ]),
      ]),
      density: "comfortable",
      sort: "name",
      direction: "asc",
      onFocusedApplication,
    })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    fireEvent.focus(host)
    expect(onFocusedApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "checkout" })

    fireEvent.pointerMove(host, { clientX: 638, clientY: 238 })
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.pointerMove(host, { clientX: 80, clientY: 38 })

    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("ledger")
    expect(tooltip).toHaveTextContent("apps")
    expect(tooltip).toHaveTextContent("tenant/payments")
    expect(tooltip).toHaveTextContent("clusters/omega")
    expect(tooltip).toHaveTextContent("production")
    expect(tooltip).toHaveTextContent("Degraded")
    expect(tooltip).toHaveTextContent("Out of sync")
    expect(tooltip).toHaveTextContent("Verifying")
    expect(tooltip).toHaveTextContent("Progressing")
    expect(tooltip).toHaveTextContent("42 managed resources")
    expect(tooltip).toHaveTextContent("2024-08-31T16:00:00.000Z")
    expect(tooltip.textContent?.length).toBeLessThan(900)
    expect(Number.parseFloat(tooltip.style.left)).toBeLessThanOrEqual(392)
    expect(Number.parseFloat(tooltip.style.top)).toBeLessThanOrEqual(96)
    expect(Number.parseFloat(tooltip.style.maxHeight)).toBe(144)
    expect(
      Number.parseFloat(tooltip.style.top) + Number.parseFloat(tooltip.style.maxHeight),
    ).toBeLessThanOrEqual(240)
    expect(tooltip).toHaveClass("pointer-events-auto", "overflow-y-auto", "overscroll-contain")
    expect(tooltip).not.toHaveAttribute("tabindex")
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    Object.defineProperties(tooltip, {
      clientHeight: { configurable: true, value: 144 },
      scrollHeight: { configurable: true, value: 360 },
    })
    expect(tooltip.scrollHeight).toBeGreaterThan(tooltip.clientHeight)
    tooltip.scrollTop = 48
    fireEvent.scroll(tooltip)
    fireEvent.wheel(tooltip, { deltaY: 40 })
    fireEvent.pointerMove(tooltip, { clientX: 638, clientY: 238 })
    fireEvent.click(tooltip, { clientX: 80, clientY: 38 })
    expect(tooltip).toBeInTheDocument()
    expect(tooltip.scrollTop).toBe(48)
    expect(navigation.push).not.toHaveBeenCalled()
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent(
      /ledger.*Degraded/u,
    )
    expect(onFocusedApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "ledger" })
  })

  it("supports none, auto, and all label modes through the shared label fitter", async () => {
    const map = result([
      group("opaque-group", [application("opaque-x", "x", "healthy")]),
    ])
    const rendered = renderHeatmap({
      result: map,
      density: "compact",
      labels: "auto",
    })
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled())
    expect(context.fillText).not.toHaveBeenCalledWith("x", expect.any(Number), expect.any(Number))

    context.fillText.mockClear()
    rendered.rerender(
      <FleetHealthHeatmap
        result={map}
        density="compact"
        labels="all"
        sort="name"
        direction="asc"
      />,
    )
    await waitFor(() => {
      expect(context.fillText).toHaveBeenCalledWith("x", expect.any(Number), expect.any(Number))
    })

    context.fillText.mockClear()
    rendered.rerender(
      <FleetHealthHeatmap
        result={map}
        density="comfortable"
        labels="none"
        sort="name"
        direction="asc"
      />,
    )
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled())
    expect(context.fillText).not.toHaveBeenCalledWith("x", expect.any(Number), expect.any(Number))

    context.fillText.mockClear()
    rendered.rerender(
      <FleetHealthHeatmap
        result={map}
        density="comfortable"
        labels="auto"
        sort="name"
        direction="asc"
      />,
    )
    await waitFor(() => {
      expect(context.fillText).toHaveBeenCalledWith("x", expect.any(Number), expect.any(Number))
    })
  })

  it("uses complete spatial keyboard navigation, scrolls offscreen cells into view, and clears with Escape", async () => {
    bounds = rect(0, 0, 240, 120)
    const onFocusedApplication = vi.fn()
    const applications = Array.from({ length: 300 }, (_, index) =>
      application(
        `opaque-${index.toString().padStart(3, "0")}`,
        `app-${index.toString().padStart(3, "0")}`,
        "healthy",
      ),
    )
    renderHeatmap({
      result: result([group("opaque-group", applications)]),
      density: "compact",
      labels: "none",
      onFocusedApplication,
    })

    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    fireEvent.keyDown(host, { key: "ArrowRight" })
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent("app-001")

    fireEvent.keyDown(host, { key: "End" })
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent("app-299")
    expect(host.scrollTop).toBeGreaterThan(0)
    await waitFor(() => expect(context.clearRect).toHaveBeenCalled())

    fireEvent.keyDown(host, { key: "Home" })
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent("app-000")
    expect(host.scrollTop).toBe(0)

    fireEvent.keyDown(host, { key: "Escape" })
    expect(screen.getByRole("status", { name: "Active heatmap application" })).toHaveTextContent(
      "No application selected",
    )
    expect(onFocusedApplication).toHaveBeenLastCalledWith(null)
  })

  it("exposes bounded complete metadata as keyboard focus moves without pointer input", () => {
    const strongestIssue = "ReplicaSet availability remains below the rollout threshold. ".repeat(20)
    const map = result([
      group("opaque-keyboard-group", [
        application("opaque-alpha-secret", "alpha", "healthy", {
          project: { namespace: "tenant", name: "storefront" },
          currentCluster: { namespace: "clusters", name: "omega" },
          currentStage: "production",
          sync: "synced",
          release: "complete",
          rollout: "healthy",
          managedResources: BigInt(17),
          lastTransitionUnixMs: BigInt(1_725_120_000_000),
          issueSummary: "No active issue",
        }),
        application("opaque-ledger-secret", "ledger", "failed", {
          project: { namespace: "tenant", name: "finance" },
          currentCluster: { namespace: "clusters", name: "sigma" },
          currentStage: "staging",
          sync: "out_of_sync",
          release: "failed",
          rollout: "paused",
          managedResources: BigInt(9),
          lastTransitionUnixMs: BigInt(1_725_120_000_000),
          issueSummary: strongestIssue,
        }),
      ]),
    ])
    const { container } = renderHeatmap({
      result: map,
      density: "comfortable",
      sort: "name",
      direction: "asc",
    })
    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    const status = screen.getByRole("status", { name: "Active heatmap application" })

    fireEvent.focus(host)
    fireEvent.keyDown(host, { key: "ArrowRight" })

    expect(status).toHaveTextContent("ledger")
    expect(status).toHaveTextContent("Namespace apps")
    expect(status).toHaveTextContent("Project tenant/finance")
    expect(status).toHaveTextContent("Cluster clusters/sigma")
    expect(status).toHaveTextContent("Stage staging")
    expect(status).toHaveTextContent("Health Failed")
    expect(status).toHaveTextContent("Sync Out of sync")
    expect(status).toHaveTextContent("Release Failed")
    expect(status).toHaveTextContent("Rollout Paused")
    expect(status).toHaveTextContent("9 managed resources")
    expect(status).toHaveTextContent("Last transition 2024-08-31T16:00:00.000Z")
    expect(status).toHaveTextContent(/Issue ReplicaSet availability remains/u)
    expect(status.textContent?.length).toBeLessThan(700)
    expect(status.textContent).not.toContain("opaque-ledger-secret")

    fireEvent.keyDown(host, { key: "Home" })
    expect(status).toHaveTextContent("alpha")
    expect(status).toHaveTextContent("Project tenant/storefront")
    expect(status).toHaveTextContent("Cluster clusters/omega")
    expect(status).toHaveTextContent("17 managed resources")

    fireEvent.keyDown(host, { key: "End" })
    expect(status).toHaveTextContent("ledger")
    expect(status).toHaveTextContent("Project tenant/finance")
    expect(container.innerHTML).not.toContain("opaque-alpha-secret")
    expect(container.innerHTML).not.toContain("opaque-ledger-secret")
  })

  it("seeds from controlled selection without trapping local hover or keyboard movement", () => {
    const map = result([
      group("opaque-group", [
        application("opaque-catalog", "catalog", "healthy"),
        application("opaque-checkout", "checkout", "healthy"),
        application("opaque-ledger", "ledger", "healthy"),
      ]),
    ])
    const rendered = renderHeatmap({
      result: map,
      density: "comfortable",
      sort: "name",
      direction: "asc",
      selected: { namespace: "apps", name: "checkout" },
    })
    const host = screen.getByRole("application", { name: "Fleet health heatmap" })
    const status = screen.getByRole("status", { name: "Active heatmap application" })
    expect(status).toHaveTextContent("checkout")

    fireEvent.keyDown(host, { key: "ArrowRight" })
    expect(status).toHaveTextContent("ledger")

    fireEvent.pointerMove(host, { clientX: 28, clientY: 38 })
    expect(status).toHaveTextContent("catalog")

    rendered.rerender(
      <FleetHealthHeatmap
        result={map}
        density="comfortable"
        labels="auto"
        sort="name"
        direction="asc"
        selected={{ namespace: "apps", name: "ledger" }}
      />,
    )
    expect(status).toHaveTextContent("ledger")
  })

  it("opens query-preserving application detail on Enter and pointer activation", () => {
    navigation.query = "project=tenant%2Fpayments&namespace=apps&namespace=ops&q=error&custom=keep&view=heatmap"
    const onSelectApplication = vi.fn()
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
    renderHeatmap({
      result: result([
        group("opaque-group", [application("opaque-checkout", "checkout", "healthy")]),
      ]),
      density: "comfortable",
      onSelectApplication,
    })
    const host = screen.getByRole("application", { name: "Fleet health heatmap" })

    fireEvent.keyDown(host, { key: "Enter" })
    expect(onSelectApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "checkout" })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    expectDetailNavigation(navigation.push.mock.calls.at(-1)?.[0])

    navigation.push.mockClear()
    fireEvent.click(host, { clientX: 28, clientY: 38 })
    expect(navigation.push).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expectDetailNavigation(navigation.push.mock.calls[0]?.[0])
  })

  it("renders an actionable empty state with a query-preserving Table route", () => {
    navigation.query = "project=tenant%2Fpayments&namespace=apps&custom=keep&view=heatmap"
    renderHeatmap({ result: result([]) })

    expect(screen.getByRole("status")).toHaveTextContent(/No applications match the active fleet scope/u)
    expect(screen.queryByRole("application", { name: "Fleet health heatmap" })).not.toBeInTheDocument()
    expectTableHref(screen.getByRole("link", { name: /Open complete Table/u }).getAttribute("href"))
  })

  it("fails safely to the complete Table route when layout rejects duplicate identities", async () => {
    navigation.query = "namespace=apps&q=checkout&custom=keep&view=heatmap&selected=apps%2Fcheckout"
    renderHeatmap({
      result: result([
        group("opaque-group", [
          application("duplicate", "checkout", "healthy"),
          application("duplicate", "ledger", "failed"),
        ]),
      ]),
    })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(/Heatmap unavailable/u)
    expect(alert).toHaveTextContent(/complete Table/u)
    expect(screen.queryByRole("application", { name: "Fleet health heatmap" })).not.toBeInTheDocument()
    expectTableHref(within(alert).getByRole("link", { name: /Open complete Table/u }).getAttribute("href"))
  })

  it("fails safely when Canvas is unsupported or a painter throws", async () => {
    navigation.query = "namespace=apps&custom=keep&view=heatmap"
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    const unsupported = renderHeatmap({
      result: result([group("opaque-group", [application("opaque-a", "a", "healthy")])]),
    })
    const unsupportedAlert = await screen.findByRole("alert")
    expect(unsupportedAlert).toHaveTextContent(/Canvas rendering is unavailable/u)
    expectTableHref(within(unsupportedAlert).getByRole("link", { name: /Open complete Table/u }).getAttribute("href"))
    unsupported.unmount()

    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    )
    context.fillRect.mockImplementationOnce(() => {
      throw new Error("GPU context lost")
    })
    renderHeatmap({
      result: result([group("opaque-group-2", [application("opaque-b", "b", "healthy")])]),
    })
    const painterAlert = await screen.findByRole("alert")
    expect(painterAlert).toHaveTextContent(/GPU context lost/u)
    expectTableHref(within(painterAlert).getByRole("link", { name: /Open complete Table/u }).getAttribute("href"))
  })

  it("owns unique description IDs for every heatmap instance", () => {
    render(
      <>
        <FleetHealthHeatmap
          result={result([
            group("opaque-first-group", [
              application("opaque-first-app", "first", "healthy"),
            ]),
          ])}
        />
        <FleetHealthHeatmap
          result={result([
            group("opaque-second-group", [
              application("opaque-second-app", "second", "degraded"),
            ]),
          ])}
        />
      </>,
    )

    const hosts = screen.getAllByRole("application", { name: "Fleet health heatmap" })
    expect(hosts).toHaveLength(2)
    const allDescriptionIds: string[] = []
    for (const host of hosts) {
      const ids = host.getAttribute("aria-describedby")?.split(/\s+/u) ?? []
      expect(ids).toHaveLength(2)
      allDescriptionIds.push(...ids)
      const ownRegion = host.closest("[role='region']")
      for (const id of ids) {
        const description = document.getElementById(id)
        expect(description).not.toBeNull()
        expect(ownRegion).toContainElement(description)
      }
    }
    expect(new Set(allDescriptionIds).size).toBe(4)
  })

  it("disconnects its observer and window listeners on unmount", () => {
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHeatmap({
      result: result([group("opaque-group", [application("opaque-a", "a", "healthy")])]),
    })
    expect(ResizeObserverMock.instances).toHaveLength(1)
    expect(add).toHaveBeenCalledWith("resize", expect.any(Function))

    unmount()

    expect(ResizeObserverMock.instances[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function))
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(41)
  })
})

function renderHeatmap(
  overrides: Partial<React.ComponentProps<typeof FleetHealthHeatmap>> = {},
) {
  return render(
    <FleetHealthHeatmap
      result={result([])}
      density="auto"
      labels="auto"
      sort="health"
      direction="desc"
      {...overrides}
    />,
  )
}

function result(roots: FleetMapNode[]): FleetMapResult {
  return {
    roots,
    total: roots.reduce((total, root) => total + root.applicationCount, BigInt(0)),
    indexGeneration: BigInt(7),
    facets: [],
  }
}

function application(
  stableId: string,
  name: string,
  health: FleetHealthStatus,
  metadata: Partial<NonNullable<FleetMapNode["applicationMetadata"]>> = {},
): FleetMapNode {
  return {
    stableId,
    kind: "application",
    label: name,
    application: { namespace: "apps", name },
    applicationCount: BigInt(1),
    targetCount: BigInt(1),
    health: [{ health, count: BigInt(1) }],
    resourceWeight: BigInt(42),
    requestRateWeight: 1,
    effectiveWeight: 42,
    usedResourceFallback: false,
    children: [],
    applicationMetadata: {
      project: { namespace: "tenant", name: "payments" },
      currentCluster: { namespace: "clusters", name: "omega" },
      currentStage: "production",
      sync: "out_of_sync",
      release: "verifying",
      rollout: "progressing",
      driftedResources: BigInt(3),
      missingResources: BigInt(1),
      managedResources: BigInt(42),
      lastTransitionUnixMs: BigInt(1_725_120_000_000),
      issueSummary: "Readiness is below threshold",
      ...metadata,
    },
  }
}

function group(
  stableId: string,
  children: FleetMapNode[],
  label = stableId.replace("opaque-", ""),
): FleetMapNode {
  return {
    stableId,
    kind: "group",
    label,
    groupValue: label,
    applicationCount: BigInt(children.length),
    targetCount: BigInt(children.length),
    health: [{ health: "healthy", count: BigInt(children.length) }],
    resourceWeight: BigInt(children.length),
    requestRateWeight: children.length,
    effectiveWeight: children.length,
    usedResourceFallback: false,
    children,
  }
}

function expectDetailNavigation(href: unknown) {
  expect(typeof href).toBe("string")
  const url = new URL(String(href), "http://paprika.local")
  expect(url.pathname).toBe("/dashboard/application")
  expect(url.searchParams.get("application_namespace")).toBe("apps")
  expect(url.searchParams.get("application_name")).toBe("checkout")
  expect(url.searchParams.get("project")).toBe("tenant/payments")
  expect(url.searchParams.getAll("namespace")).toEqual(["apps", "ops"])
  expect(url.searchParams.get("q")).toBe("error")
  expect(url.searchParams.get("custom")).toBe("keep")
  expect(url.searchParams.get("view")).toBe("heatmap")
}

function expectTableHref(href: string | null) {
  const url = new URL(href ?? "", "http://paprika.local")
  expect(url.pathname).toBe("/dashboard/applications")
  expect(url.searchParams.get("view")).toBe("table")
  expect(url.searchParams.get("custom")).toBe("keep")
  expect(url.searchParams.get("selected")).toBeNull()
}

function expectedHeatmapFillRects(
  layout: HeatmapLayoutResult,
  requestedScrollTop: number,
  width: number,
  viewportHeight: number,
): number[][] {
  const scrollTop = Math.min(
    Math.max(0, requestedScrollTop),
    Math.max(0, layout.virtualHeight - viewportHeight),
  )
  const bottom = scrollTop + viewportHeight
  const headers = layout.groups
    .filter(
      (group) =>
        group.y + group.headerHeight > scrollTop && group.y < bottom,
    )
    .map((group) => [0, group.y - scrollTop, width, group.headerHeight])
  const cells = clipHeatmapCells(
    layout.cells,
    layout.virtualHeight,
    scrollTop,
    viewportHeight,
  ).map((cell) => [
    cell.x + 0.75,
    cell.y - scrollTop + 0.75,
    cell.width - 1.5,
    cell.height - 1.5,
  ])
  return [...headers, ...cells]
}

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = []
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
}

function canvasContext() {
  const fillStyles: string[] = []
  const strokeStyles: string[] = []
  const paintBatches: Array<{ clear: number[]; fills: number[][] }> = []
  const context = {
    fillStyles,
    strokeStyles,
    paintBatches,
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((label: string) => ({ width: Array.from(label).length * 6 })),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
  }
  context.clearRect.mockImplementation((...values: number[]) => {
    paintBatches.push({ clear: values, fills: [] })
  })
  context.fillRect.mockImplementation((...values: number[]) => {
    fillStyles.push(String(context.fillStyle))
    paintBatches.at(-1)?.fills.push(values)
  })
  context.strokeRect.mockImplementation(() => strokeStyles.push(String(context.strokeStyle)))
  return context
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  }
}
