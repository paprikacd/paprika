import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FleetFilters } from "@/components/fleet/fleet-filters"
import type { FleetFacetBucket } from "@/lib/fleet-client"
import {
  DEFAULT_FLEET_QUERY,
  type FleetQueryPatch,
  type FleetQueryState,
} from "@/lib/fleet-query"

const facets: FleetFacetBucket[] = [
  {
    dimension: "project",
    object: { namespace: "tenant-a", name: "payments" },
    label: "Payments",
    count: BigInt(18),
  },
  {
    dimension: "cluster",
    object: { namespace: "platform", name: "prod-eu" },
    label: "Production EU",
    count: BigInt(9),
  },
  { dimension: "stage", value: "prod", label: "Production", count: BigInt(11) },
  { dimension: "namespace", value: "checkout", label: "checkout", count: BigInt(7) },
  { dimension: "health", value: "degraded", label: "Degraded", count: BigInt(3) },
  { dimension: "sync", value: "out_of_sync", label: "Out of sync", count: BigInt(2) },
  {
    dimension: "release",
    value: "awaiting_approval",
    label: "Awaiting approval",
    count: BigInt(4),
  },
  { dimension: "rollout", value: "paused", label: "Paused", count: BigInt(1) },
  { dimension: "source_type", value: "helm", label: "Helm", count: BigInt(12) },
]

function renderFilters(
  state: FleetQueryState = DEFAULT_FLEET_QUERY,
  onPatch = vi.fn<(patch: FleetQueryPatch) => void>(),
  availableFacets: readonly FleetFacetBucket[] = facets,
) {
  return {
    onPatch,
    ...render(<FleetFilters state={state} facets={availableFacets} onPatch={onPatch} />),
  }
}

describe("FleetFilters", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces search patches for exactly 250 ms", () => {
    vi.useFakeTimers()
    const { onPatch } = renderFilters()
    const search = screen.getByRole("searchbox", { name: "Search applications" })

    fireEvent.change(search, { target: { value: "payments api" } })
    act(() => vi.advanceTimersByTime(249))
    expect(onPatch).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onPatch).toHaveBeenCalledOnce()
    expect(onPatch).toHaveBeenLastCalledWith({ q: "payments api" })
  })

  it("synchronizes the transient search draft when URL-owned state changes", () => {
    vi.useFakeTimers()
    const onPatch = vi.fn<(patch: FleetQueryPatch) => void>()
    const initial = { ...DEFAULT_FLEET_QUERY, q: "payments" }
    const { rerender } = renderFilters(initial, onPatch)
    const search = screen.getByRole("searchbox", { name: "Search applications" })

    fireEvent.change(search, { target: { value: "unfinished draft" } })
    rerender(
      <FleetFilters
        state={{ ...initial, q: "checkout from URL" }}
        facets={facets}
        onPatch={onPatch}
      />,
    )

    expect(screen.getByRole("searchbox", { name: "Search applications" })).toHaveValue(
      "checkout from URL",
    )
    act(() => vi.advanceTimersByTime(250))
    expect(onPatch).not.toHaveBeenCalled()
  })

  it.each([
    ["Health degraded", { health: ["degraded"] }],
    ["Sync out_of_sync", { sync: ["out_of_sync"] }],
    ["Release awaiting_approval", { release: ["awaiting_approval"] }],
    ["Rollout paused", { rollout: ["paused"] }],
    ["Source helm", { sources: ["helm"] }],
  ] as const)("emits only the %s filter patch", async (accessibleName, expectedPatch) => {
    const user = userEvent.setup()
    const { onPatch } = renderFilters()

    await user.click(screen.getByRole("checkbox", { name: accessibleName }))

    expect(onPatch).toHaveBeenCalledOnce()
    expect(onPatch).toHaveBeenLastCalledWith(expectedPatch)
  })

  it("summarizes global scope without rendering a second set of scope editors", () => {
    const state: FleetQueryState = {
      ...DEFAULT_FLEET_QUERY,
      projects: [{ namespace: "tenant-b", name: "legacy.api" }],
      clusters: [{ namespace: "platform", name: "prod-eu" }],
      stages: ["retired"],
      namespaces: ["checkout"],
    }
    const { onPatch } = renderFilters(state)
    const summary = screen.getByRole("group", { name: "Fleet scope summary" })

    expect(within(summary).getByText("Project tenant-b/legacy.api")).toBeInTheDocument()
    expect(within(summary).getByText("Cluster platform/prod-eu")).toBeInTheDocument()
    expect(within(summary).getByText("Stage retired")).toBeInTheDocument()
    expect(within(summary).getByText("Namespace checkout")).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /^Project / })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /^Cluster / })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /^Stage / })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /^Namespace / })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Remove project / })).not.toBeInTheDocument()
    expect(onPatch).not.toHaveBeenCalled()
  })

  it("removes a non-scope selection without replacing global scope", async () => {
    const user = userEvent.setup()
    const state: FleetQueryState = {
      ...DEFAULT_FLEET_QUERY,
      projects: [{ namespace: "tenant-a", name: "payments" }],
      stages: ["dev", "prod"],
      health: ["degraded", "failed"],
    }
    const { onPatch } = renderFilters(state)

    await user.click(screen.getByRole("button", { name: "Remove health degraded" }))

    expect(onPatch).toHaveBeenCalledOnce()
    expect(onPatch).toHaveBeenLastCalledWith({ health: ["failed"] })
  })

  it.each([
    ["Treemap", "matrix", { view: "treemap" }],
    ["Matrix", "treemap", { view: "matrix" }],
    ["Table", "treemap", { view: "table", sort: "name", direction: "asc" }],
    ["Queue", "treemap", { view: "queue", sort: "impact", direction: "desc" }],
  ] as const)(
    "switches to %s with the exact presentation defaults",
    async (label, currentView, expectedPatch) => {
      const user = userEvent.setup()
      const state = { ...DEFAULT_FLEET_QUERY, view: currentView }
      const { onPatch } = renderFilters(state)

      await user.click(screen.getByRole("button", { name: `Show ${label} view` }))

      expect(onPatch).toHaveBeenCalledOnce()
      expect(onPatch).toHaveBeenLastCalledWith(expectedPatch)
    },
  )

  it("changes presentation without copying or losing scoped URL fields", async () => {
    const user = userEvent.setup()
    const state: FleetQueryState = {
      ...DEFAULT_FLEET_QUERY,
      projects: [{ namespace: "tenant-a", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod-eu" }],
      stages: ["prod"],
      namespaces: ["checkout"],
      health: ["degraded"],
      q: "payments",
      selected: { namespace: "checkout", name: "api" },
      zoom: "project:tenant-a/payments",
    }
    const { onPatch } = renderFilters(state)

    await user.click(screen.getByRole("button", { name: "Show Matrix view" }))

    expect(onPatch).toHaveBeenCalledOnce()
    expect(onPatch).toHaveBeenLastCalledWith({ view: "matrix" })
  })

  it("emits grouping and sizing patches from the active canvas controls", () => {
    const onPatch = vi.fn<(patch: FleetQueryPatch) => void>()
    const { rerender } = renderFilters(DEFAULT_FLEET_QUERY, onPatch)

    fireEvent.change(screen.getByRole("combobox", { name: "Group treemap by" }), {
      target: { value: "namespace" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Size applications by" }), {
      target: { value: "request_rate" },
    })
    expect(onPatch).toHaveBeenNthCalledWith(1, { group: "namespace" })
    expect(onPatch).toHaveBeenNthCalledWith(2, { size: "request_rate" })

    rerender(
      <FleetFilters
        state={{ ...DEFAULT_FLEET_QUERY, view: "matrix" }}
        facets={facets}
        onPatch={onPatch}
      />,
    )
    fireEvent.change(screen.getByRole("combobox", { name: "Matrix rows" }), {
      target: { value: "health" },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "Matrix columns" }), {
      target: { value: "stage" },
    })
    expect(onPatch).toHaveBeenNthCalledWith(3, { rows: "health" })
    expect(onPatch).toHaveBeenNthCalledWith(4, { columns: "stage" })
  })

  it("uses semantic groups and 44px minimum interactive targets", () => {
    renderFilters()

    expect(screen.getByRole("group", { name: "Presentation" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Health" })).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Project" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Cluster" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Stage" })).not.toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "Namespace" })).not.toBeInTheDocument()
    expect(screen.getByText("Filter dimensions").closest("details")).not.toHaveAttribute("open")
    expect(screen.getByRole("searchbox", { name: "Search applications" })).toHaveClass("min-h-11")
    expect(screen.getByRole("button", { name: "Show Table view" })).toHaveClass("min-h-11")
    expect(screen.getByRole("checkbox", { name: "Health degraded" }).parentElement).toHaveClass(
      "min-h-11",
    )
  })

  it("ignores high-cardinality scope facets because the shell is their sole editor", () => {
    const manyProjects: FleetFacetBucket[] = Array.from({ length: 200 }, (_, index) => ({
      dimension: "project",
      object: { namespace: "tenant", name: `service-${String(index).padStart(3, "0")}` },
      label: `Service ${index}`,
      count: BigInt(1),
    }))

    renderFilters(DEFAULT_FLEET_QUERY, undefined, manyProjects)

    expect(screen.queryByRole("checkbox", { name: /^Project / })).not.toBeInTheDocument()
    expect(screen.queryByRole("searchbox", { name: "Filter Project options" })).not.toBeInTheDocument()
    expect(screen.queryByText("Service 199")).not.toBeInTheDocument()
  })
})
