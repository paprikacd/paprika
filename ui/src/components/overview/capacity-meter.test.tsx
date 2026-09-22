import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  CostBasis,
  CostSummary,
  DataState,
  ResourceMeter,
  ResourceUnit,
} from "@/gen/paprika/v1/api_pb"

import { CapacityMeter } from "./capacity-meter"
import { formatCost } from "./clusters-board"

describe("CapacityMeter", () => {
  it("draws requested and allocatable even when nothing measures used", () => {
    render(
      <CapacityMeter
        label="CPU"
        meter={
          new ResourceMeter({
            unit: ResourceUnit.MILLICORES,
            usedState: DataState.NOT_AVAILABLE,
            used: 0,
            requestedState: DataState.OK,
            requested: 61_200,
            allocatableState: DataState.OK,
            allocatable: 72_000,
            unavailableReason: "no metrics provider is configured",
          })
        }
      />
    )

    expect(screen.getByText("— / 61.2 / 72.0 cores")).toBeDefined()
    expect(screen.getByText("used unavailable")).toBeDefined()
    expect(screen.getByText("requested 85%")).toBeDefined()
    expect(screen.getByText("no metrics provider is configured")).toBeDefined()
    expect(
      screen.getByRole("meter", {
        name: "CPU — used not available, requested 85 percent of allocatable",
      })
    ).toBeDefined()
  })

  it("renders nothing but the reason when allocatable itself is missing", () => {
    render(
      <CapacityMeter
        label="MEMORY"
        meter={
          new ResourceMeter({
            unit: ResourceUnit.BYTES,
            usedState: DataState.NOT_AVAILABLE,
            requestedState: DataState.NOT_AVAILABLE,
            allocatableState: DataState.NOT_AVAILABLE,
            unavailableReason: "cluster capacity collection is not configured",
          })
        }
      />
    )

    expect(
      screen.getByText("cluster capacity collection is not configured")
    ).toBeDefined()
    expect(screen.queryByRole("meter")).toBeNull()
    expect(screen.queryByText(/0 GiB/)).toBeNull()
  })

  it("flags requests above 85% of allocatable, and only above", () => {
    const { rerender } = render(
      <CapacityMeter
        label="CPU"
        meter={
          new ResourceMeter({
            unit: ResourceUnit.MILLICORES,
            usedState: DataState.OK,
            used: 34_600,
            requestedState: DataState.OK,
            requested: 61_200,
            allocatableState: DataState.OK,
            allocatable: 72_000,
          })
        }
      />
    )
    expect(screen.getByText("requested 85%").className).not.toContain(
      "font-bold"
    )

    rerender(
      <CapacityMeter
        label="CPU"
        meter={
          new ResourceMeter({
            unit: ResourceUnit.MILLICORES,
            usedState: DataState.OK,
            used: 41_900,
            requestedState: DataState.OK,
            requested: 78_100,
            allocatableState: DataState.OK,
            allocatable: 88_000,
          })
        }
      />
    )
    expect(screen.getByText("requested 89%").className).toContain("font-bold")
  })
})

describe("formatCost", () => {
  const cost = (
    state: DataState,
    basis: CostBasis,
  ) =>
    new CostSummary({
      state,
      basis,
      monthlyAmount: 14_200,
      currency: "USD",
    })

  it("marks a rate-card figure as an estimate and a billing figure as measured", () => {
    expect(
      formatCost(cost(DataState.OK, CostBasis.RATE_CARD_REQUESTED))
    ).toMatch(/^≈ /)
    expect(formatCost(cost(DataState.OK, CostBasis.BILLING))).not.toMatch(/^≈ /)
  })

  it("shows no figure at all when no cost source is configured", () => {
    expect(
      formatCost(cost(DataState.NOT_CONFIGURED, CostBasis.UNSPECIFIED))
    ).toBeNull()
    expect(formatCost(undefined)).toBeNull()
  })
})
