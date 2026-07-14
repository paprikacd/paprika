import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DashboardHealthMap } from "@/components/dashboard/dashboard-health-map"
import type {
  FleetHealthStatus,
  FleetMapNode,
  FleetMapResult,
} from "@/lib/fleet-client"

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  query: "",
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

describe("DashboardHealthMap", () => {
  beforeEach(() => {
    navigation.push.mockReset()
    navigation.query = ""
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      canvasContext() as unknown as CanvasRenderingContext2D,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders every complete map leaf with no sampled preview or application cards", () => {
    const result = completeMap(250)

    const { container } = render(
      <DashboardHealthMap
        result={result}
        status="ready"
        density="compact"
        labels="none"
        sort="health"
        direction="desc"
      />,
    )

    expect(screen.getByText("250 applications in this complete map")).toBeInTheDocument()
    expect(screen.getByRole("application", { name: "Fleet health heatmap" })).toHaveAttribute(
      "data-heatmap-layout-count",
      "250",
    )
    expect(container.querySelectorAll("[data-application-card]")).toHaveLength(0)
    expect(screen.queryByText(/loaded applications/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument()
  })

  it("keeps a failed map actionable with Retry and a lossless complete Table fallback", () => {
    const retry = vi.fn()
    const fleetQuery = [
      "project=tenant%2Fpayments",
      "cluster=platform%2Fomega",
      "stage=production",
      "namespace=apps",
      "q=checkout",
      "health=degraded",
      "group=namespace",
      "density=compact",
      "labels=all",
      "selected=apps%2Fcheckout",
      "unknown=kept",
    ].join("&")

    render(
      <DashboardHealthMap
        status="error"
        fleetQuery={fleetQuery}
        onRetry={retry}
      />,
    )

    expect(screen.getByRole("alert", { name: "Application health map unavailable" })).toHaveTextContent(
      "The complete fleet map could not be loaded",
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry application health map" }))
    expect(retry).toHaveBeenCalledTimes(1)

    const fallback = new URL(
      screen.getByRole("link", { name: "Open complete Table view" }).getAttribute("href")!,
      "https://paprika.invalid",
    )
    expect(fallback.pathname).toBe("/dashboard/applications")
    expect(fallback.searchParams.get("view")).toBe("table")
    expect(fallback.searchParams.getAll("project")).toEqual(["tenant/payments"])
    expect(fallback.searchParams.getAll("namespace")).toEqual(["apps"])
    expect(fallback.searchParams.get("q")).toBe("checkout")
    expect(fallback.searchParams.get("group")).toBe("namespace")
    expect(fallback.searchParams.get("density")).toBe("compact")
    expect(fallback.searchParams.get("labels")).toBe("all")
    expect(fallback.searchParams.get("unknown")).toBe("kept")
    expect(fallback.searchParams.has("selected")).toBe(false)
  })

  it("never presents a cached map as current when its refresh has failed", () => {
    const retry = vi.fn()

    render(
      <DashboardHealthMap
        result={completeMap(3)}
        status="unavailable"
        onRetry={retry}
      />,
    )

    expect(
      screen.getByRole("alert", { name: "Application health map unavailable" }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("application", { name: "Fleet health heatmap" })).not.toBeInTheDocument()
  })

  it("explains an empty scoped fleet and clears only global scope in one action", () => {
    const fleetQuery = [
      "project=tenant%2Fpayments",
      "cluster=platform%2Fomega",
      "stage=production",
      "namespace=apps",
      "health=failed",
      "view=heatmap",
      "group=health",
      "density=comfortable",
      "labels=none",
      "unknown=kept",
    ].join("&")

    render(
      <DashboardHealthMap
        result={completeMap(0)}
        status="empty"
        fleetQuery={fleetQuery}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent("No applications match this fleet scope")
    const clear = new URL(
      screen.getByRole("link", { name: "Clear fleet scope" }).getAttribute("href")!,
      "https://paprika.invalid",
    )
    expect(clear.pathname).toBe("/dashboard")
    for (const field of ["project", "cluster", "stage", "namespace"]) {
      expect(clear.searchParams.has(field)).toBe(false)
    }
    expect(clear.searchParams.getAll("health")).toEqual(["failed"])
    expect(clear.searchParams.get("view")).toBe("heatmap")
    expect(clear.searchParams.get("group")).toBe("health")
    expect(clear.searchParams.get("density")).toBe("comfortable")
    expect(clear.searchParams.get("labels")).toBe("none")
    expect(clear.searchParams.get("unknown")).toBe("kept")
  })
})

function completeMap(count: number): FleetMapResult {
  const applications = Array.from({ length: count }, (_, index) =>
    application(
      `opaque-application-${index.toString().padStart(5, "0")}`,
      `application-${index.toString().padStart(5, "0")}`,
      index % 5 === 0 ? "failed" : "healthy",
    ),
  )
  return {
    roots: count === 0 ? [] : [group("health:complete", applications)],
    total: BigInt(count),
    indexGeneration: BigInt(7),
    facets: [
      {
        dimension: "health",
        value: "healthy",
        label: "Healthy",
        count: BigInt(count - Math.ceil(count / 5)),
      },
      {
        dimension: "health",
        value: "failed",
        label: "Failed",
        count: BigInt(Math.ceil(count / 5)),
      },
    ],
  }
}

function application(
  stableId: string,
  name: string,
  health: FleetHealthStatus,
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
    requestRateWeight: 0,
    effectiveWeight: 1,
    usedResourceFallback: false,
    children: [],
  }
}

function group(stableId: string, children: FleetMapNode[]): FleetMapNode {
  return {
    stableId,
    kind: "group",
    label: "Complete fleet",
    groupValue: "complete",
    applicationCount: BigInt(children.length),
    targetCount: BigInt(children.length),
    health: [],
    resourceWeight: BigInt(children.length),
    requestRateWeight: 0,
    effectiveWeight: children.length,
    usedResourceFallback: false,
    children,
  }
}

function canvasContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    measureText: (value: string) => ({ width: value.length * 6 }),
  }
}
