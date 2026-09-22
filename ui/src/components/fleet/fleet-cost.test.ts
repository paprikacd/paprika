import { describe, expect, it } from "vitest"

import {
  costBasisLabel,
  formatMonthlyCost,
  isCostEstimate,
} from "@/components/fleet/fleet-cost"

describe("formatMonthlyCost", () => {
  it("abbreviates at the scale an operator reads costs in", () => {
    expect(formatMonthlyCost(980, "USD")).toBe("$980")
    expect(formatMonthlyCost(4130, "USD")).toBe("$4.1k")
    expect(formatMonthlyCost(1_500_000, "USD")).toBe("$1.5M")
  })

  it("never drops the currency", () => {
    expect(formatMonthlyCost(4130, "EUR")).toBe("€4.1k")
    expect(formatMonthlyCost(4130, "AUD")).toBe("AUD 4.1k")
  })

  it("renders nothing for a figure that is not a number", () => {
    expect(formatMonthlyCost(Number.NaN, "USD")).toBe("")
  })
})

describe("cost basis", () => {
  it("separates an estimate from a measurement", () => {
    expect(isCostEstimate("rate_card_requested")).toBe(true)
    expect(isCostEstimate("rate_card_allocatable")).toBe(true)
    expect(isCostEstimate("billing")).toBe(false)
  })

  it("says what the figure was derived from", () => {
    expect(costBasisLabel("rate_card_requested")).toContain("Estimate")
    expect(costBasisLabel("billing")).toBe("Billed spend")
  })
})
