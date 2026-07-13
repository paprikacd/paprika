import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))

import { ApplicationTable } from "@/components/fleet/application-table"
import { FleetTreemap } from "@/components/fleet/fleet-treemap"
import type {
  FleetApplicationSummary,
  FleetMapNode,
  FleetMapResult,
} from "@/lib/fleet-client"
import { createFleetFocusCoordinator } from "@/lib/fleet-focus"

describe("FleetTreemap", () => {
  const draw = canvasContext()

  beforeEach(() => {
    draw.clearRect.mockClear()
    draw.fillRect.mockClear()
    draw.strokeRect.mockClear()
    draw.fillText.mockClear()
    draw.measureText.mockClear()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      draw as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 960, 520),
    )
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    )
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps the visual surface to one canvas and one keyboard focus controller", async () => {
    const { container } = renderTreemap({
      result: result([application("application:checkout", "checkout", "healthy")]),
      selected: { namespace: "apps", name: "checkout" },
    })

    expect(container.querySelectorAll("canvas")).toHaveLength(1)
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
    expect(container.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0)
    expect(
      screen.getByText(/Table presentation is the complete semantic equivalent/i),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(draw.fillText).toHaveBeenCalledWith(expect.stringContaining("✓"), expect.any(Number), expect.any(Number))
      expect(draw.fillText).toHaveBeenCalledWith(expect.stringMatching(/checkout/i), expect.any(Number), expect.any(Number))
    })
  })

  it("renders every visible health as an ordered text-plus-glyph legend", () => {
    renderTreemap({
      result: result([
        group("group:payments", [
          application("application:checkout", "checkout", "healthy"),
          application("application:ledger", "ledger", "degraded"),
          application("application:worker", "worker", "progressing"),
        ]),
      ]),
    })

    const legend = screen.getByRole("list", { name: "Treemap health legend" })
    const entries = within(legend).getAllByRole("listitem")

    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Degraded"),
      expect.stringContaining("Progressing"),
      expect.stringContaining("Healthy"),
    ])
    entries.forEach((entry) => {
      const glyph = entry.querySelector("[data-health-glyph]")
      expect(glyph).toHaveAttribute("aria-hidden", "true")
      expect(glyph).not.toHaveTextContent(/^\s*$/u)
    })
  })

  it("omits labels from tiny cells instead of clipping them", async () => {
    const roots = Array.from({ length: 1_000 }, (_, index) => {
      const suffix = index.toString().padStart(5, "0")
      return application(`application:tiny-${suffix}`, `tiny-${suffix}`, "healthy")
    })
    renderTreemap({ result: result(roots) })

    await waitFor(() => expect(draw.fillRect.mock.calls.length).toBeGreaterThanOrEqual(1_000))
    expect(draw.fillText).not.toHaveBeenCalledWith(
      expect.stringContaining("tiny-00500"),
      expect.any(Number),
      expect.any(Number),
    )
  })

  it("fits constrained canvas labels with one ellipsis while retaining the full name elsewhere", async () => {
    const fullName = `checkout-${"deployment-".repeat(20)}service`
    renderTreemap({
      result: result([
        application("application:checkout-long", fullName, "degraded"),
      ]),
    })

    await waitFor(() => {
      const fitted = draw.fillText.mock.calls
        .map(([label]) => String(label))
        .find((label) => label.startsWith("! checkout-"))
      expect(fitted).toBeDefined()
      expect(fitted).not.toContain(fullName)
      expect(fitted?.endsWith("…")).toBe(true)
      expect(fitted?.match(/…/gu)).toHaveLength(1)
    })

    const controller = screen.getByRole("application", { name: /fleet treemap/i })
    fireEvent.pointerMove(controller, { clientX: 300, clientY: 220 })
    expect(await screen.findByRole("tooltip")).toHaveTextContent(fullName)
    expect(screen.getByRole("status", { name: /treemap selection/i })).toHaveTextContent(
      fullName,
    )
    expect(
      screen.getByText(/Table presentation is the complete semantic equivalent/i),
    ).toBeInTheDocument()

    render(
      <ApplicationTable
        applications={[tableApplication(fullName)]}
        total={BigInt(1)}
        hasMore={false}
        isLoadingMore={false}
        onLoadMore={vi.fn()}
        onSelectApplication={vi.fn()}
        onFocusedApplication={vi.fn()}
        focusCoordinator={createFleetFocusCoordinator({ announce: vi.fn() })}
        getResultsHeadingTarget={() => null}
      />,
    )

    const tables = screen.getAllByRole("table", { name: "Applications" })
    expect(tables).toHaveLength(1)
    const table = tables[0]
    if (!table) throw new Error("expected the semantic Applications table")
    const rows = within(table).getAllByRole("row")
    expect(rows).toHaveLength(2)
    const dataRows = table.querySelectorAll("[data-row-key]")
    expect(dataRows).toHaveLength(1)
    const dataRow = dataRows[0]
    if (!dataRow) throw new Error("expected one bounded application data row")
    expect(within(dataRow as HTMLElement).getAllByRole("cell")).toHaveLength(6)
    expect(screen.getAllByRole("cell")).toHaveLength(6)
    expect(within(dataRow as HTMLElement).getByText(fullName, { exact: true })).toBeVisible()
    expect(dataRow).toHaveTextContent(fullName)
  })

  it("keeps full fitting canvas labels and names tap, click, and keyboard navigation", async () => {
    renderTreemap({
      result: result([
        application("application:checkout", "checkout", "healthy"),
      ]),
    })

    await waitFor(() => {
      expect(draw.fillText).toHaveBeenCalledWith(
        "✓ checkout",
        expect.any(Number),
        expect.any(Number),
      )
    })
    const instructions = screen.getByText(/Table presentation is the complete semantic equivalent/i)
    expect(instructions).toHaveTextContent(/tap/i)
    expect(instructions).toHaveTextContent(/click/i)
    expect(instructions).toHaveTextContent(/arrows.*home.*end/i)
  })

  it("exposes pointer tooltip and synchronized selected detail without DOM cells", async () => {
    const onSelectApplication = vi.fn()
    renderTreemap({
      result: result([application("application:checkout", "checkout", "degraded")]),
      onSelectApplication,
    })

    const controller = screen.getByRole("application", { name: /fleet treemap/i })
    fireEvent.pointerMove(controller, { clientX: 300, clientY: 220 })

    expect(await screen.findByRole("tooltip")).toHaveTextContent(/checkout/i)
    expect(screen.getByRole("tooltip")).toHaveTextContent(/degraded/i)

    fireEvent.click(controller, { clientX: 300, clientY: 220 })
    expect(onSelectApplication).toHaveBeenCalledWith({ namespace: "apps", name: "checkout" })
    expect(screen.getByRole("status", { name: /treemap selection/i })).toHaveTextContent(
      /checkout.*degraded.*1 target/i,
    )
  })

  it("uses nearest-cell, Home, and End keyboard navigation from the single controller", () => {
    const onSelectApplication = vi.fn()
    renderTreemap({
      result: result([
        group("group:payments", [
          application("application:checkout", "checkout", "healthy"),
          application("application:ledger", "ledger", "failed"),
        ]),
      ]),
      selected: { namespace: "apps", name: "checkout" },
      onSelectApplication,
    })

    const controller = screen.getByRole("application", { name: /fleet treemap/i })
    fireEvent.keyDown(controller, { key: "ArrowRight" })
    expect(onSelectApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "ledger" })

    fireEvent.keyDown(controller, { key: "Home" })
    expect(onSelectApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "checkout" })

    fireEvent.keyDown(controller, { key: "End" })
    expect(onSelectApplication).toHaveBeenLastCalledWith({ namespace: "apps", name: "ledger" })
  })

  it("semantically zooms group headers and lets Escape return to the fleet root", () => {
    const onZoomChange = vi.fn()
    const onSelectApplication = vi.fn()
    const map = result([
      group("group:payments", [application("application:checkout", "checkout", "healthy")]),
    ])
    const { rerender } = render(
      <FleetTreemap
        result={map}
        zoom=""
        onZoomChange={onZoomChange}
        onSelectApplication={onSelectApplication}
        onFocusedApplication={vi.fn()}
      />,
    )
    const controller = screen.getByRole("application", { name: /fleet treemap/i })

    fireEvent.doubleClick(controller, { clientX: 20, clientY: 10 })
    expect(onZoomChange).toHaveBeenCalledWith("group:payments")
    expect(onSelectApplication).not.toHaveBeenCalled()

    rerender(
      <FleetTreemap
        result={map}
        zoom="group:payments"
        onZoomChange={onZoomChange}
        onSelectApplication={onSelectApplication}
        onFocusedApplication={vi.fn()}
      />,
    )
    fireEvent.keyDown(controller, { key: "Escape" })
    expect(onZoomChange).toHaveBeenLastCalledWith("")
  })
})

function renderTreemap(
  overrides: Partial<React.ComponentProps<typeof FleetTreemap>> = {},
) {
  return render(
    <FleetTreemap
      result={result([])}
      zoom=""
      onZoomChange={vi.fn()}
      onSelectApplication={vi.fn()}
      onFocusedApplication={vi.fn()}
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
  health: FleetMapNode["health"][number]["health"],
): FleetMapNode {
  return {
    stableId,
    kind: "application",
    label: name,
    application: { namespace: "apps", name },
    applicationCount: BigInt(1),
    targetCount: BigInt(1),
    health: [{ health, count: BigInt(1) }],
    resourceWeight: BigInt(1),
    requestRateWeight: 1,
    effectiveWeight: 1,
    usedResourceFallback: false,
    children: [],
  }
}

function group(stableId: string, children: FleetMapNode[]): FleetMapNode {
  return {
    stableId,
    kind: "group",
    label: stableId.replace("group:", ""),
    groupValue: stableId.replace("group:", ""),
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

function canvasContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((label: string) => ({ width: Array.from(label).length * 10 })),
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
  }
}

function tableApplication(name: string): FleetApplicationSummary {
  return {
    identity: { namespace: "apps", name },
    project: { namespace: "tenant", name: "payments" },
    targets: [],
    currentStage: "production",
    currentClusterLabel: "omega",
    sourceType: "git",
    sourceRevision: "f8a31b2",
    health: "degraded",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 12,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(1_725_000_000_000),
    capabilities: [],
  }
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
