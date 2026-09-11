import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FacetToolbar } from "@/components/fleet/facet-toolbar"
import type { FleetFacetBucket } from "@/lib/fleet-client"
import { DEFAULT_FLEET_QUERY, type FleetQueryState } from "@/lib/fleet-query"

function facet(
  dimension: FleetFacetBucket["dimension"],
  value: string,
  label: string,
  count: number,
): FleetFacetBucket {
  return { dimension, value, label, count: BigInt(count) }
}

function state(overrides: Partial<FleetQueryState> = {}): FleetQueryState {
  return { ...DEFAULT_FLEET_QUERY, ...overrides }
}

const facets = [
  facet("health", "degraded", "Degraded", 4),
  facet("health", "failed", "Failed", 2),
  facet("sync", "out_of_sync", "Out of sync", 8),
  facet("stage", "prod", "prod", 25),
  facet("source_type", "helm", "Helm", 33),
]

describe("FacetToolbar", () => {
  it("names each chip with its server-counted bucket", () => {
    render(<FacetToolbar state={state()} facets={facets} onPatch={vi.fn()} />)

    expect(
      screen.getByRole("button", { name: "Degraded, 4 applications" }),
    ).toHaveAttribute("aria-pressed", "false")
    expect(
      screen.getByRole("button", { name: "Out of sync, 8 applications" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Helm, 33 applications" })).toBeInTheDocument()
  })

  it("renders no chip for a dimension the index reported nothing for", () => {
    render(<FacetToolbar state={state()} facets={[]} onPatch={vi.fn()} />)

    expect(screen.getByText("No facets in this scope")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /applications$/ })).not.toBeInTheDocument()
  })

  it("adds a facet to its own query field when pressed", () => {
    const onPatch = vi.fn()
    render(<FacetToolbar state={state()} facets={facets} onPatch={onPatch} />)

    fireEvent.click(screen.getByRole("button", { name: "Degraded, 4 applications" }))

    expect(onPatch).toHaveBeenCalledWith({ health: ["degraded"] })
  })

  it("removes an active facet and shows it as pressed", () => {
    const onPatch = vi.fn()
    render(
      <FacetToolbar
        state={state({ health: ["degraded"] })}
        facets={facets}
        onPatch={onPatch}
      />,
    )

    const chip = screen.getByRole("button", { name: "Degraded, 4 applications" })
    expect(chip).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(chip)

    expect(onPatch).toHaveBeenCalledWith({ health: [] })
  })

  it("clears every facet dimension at once", () => {
    const onPatch = vi.fn()
    render(
      <FacetToolbar
        state={state({ health: ["degraded"], sync: ["out_of_sync"] })}
        facets={facets}
        onPatch={onPatch}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Clear 2 facets" }))

    expect(onPatch).toHaveBeenCalledWith({
      health: [],
      sync: [],
      release: [],
      rollout: [],
      stages: [],
      sources: [],
    })
  })

  it("commits the search box after it settles rather than on every keystroke", () => {
    vi.useFakeTimers()
    try {
      const onPatch = vi.fn()
      render(<FacetToolbar state={state()} facets={facets} onPatch={onPatch} />)

      const input = screen.getByRole("searchbox", {
        name: "Filter applications by name, project, cluster or revision",
      })
      fireEvent.change(input, { target: { value: "check" } })
      fireEvent.change(input, { target: { value: "checkout" } })
      expect(onPatch).not.toHaveBeenCalled()

      vi.advanceTimersByTime(300)
      expect(onPatch).toHaveBeenCalledExactlyOnceWith({ q: "checkout" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a selected facet visible even when it is not one of the top buckets", () => {
    const many = [
      ...Array.from({ length: 8 }, (_, index) =>
        facet("stage", `stage-${index}`, `stage-${index}`, 100 - index),
      ),
      facet("stage", "rare", "rare", 1),
    ]
    render(
      <FacetToolbar state={state({ stages: ["rare"] })} facets={many} onPatch={vi.fn()} />,
    )

    expect(screen.getByRole("button", { name: "rare, 1 applications" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    // Bounded: the long tail past the cap never reaches the DOM.
    expect(screen.queryByRole("button", { name: "stage-7, 93 applications" })).not.toBeInTheDocument()
  })

  it("reports the scope summary it is given", () => {
    render(
      <FacetToolbar
        state={state()}
        facets={facets}
        onPatch={vi.fn()}
        summary="100 loaded / 10000 indexed"
      />,
    )

    expect(screen.getByText("100 loaded / 10000 indexed")).toBeInTheDocument()
  })
})
