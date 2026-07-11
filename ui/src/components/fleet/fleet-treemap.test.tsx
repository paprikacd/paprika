import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FleetTreemap } from "@/components/fleet/fleet-treemap"
import type { FleetMapNode, FleetMapResult } from "@/lib/fleet-client"

describe("FleetTreemap", () => {
  const draw = canvasContext()

  beforeEach(() => {
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
  health: "healthy" | "degraded" | "failed",
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
    measureText: vi.fn(() => ({ width: 60 })),
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
