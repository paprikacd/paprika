import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetHealth, FleetHealthBucket, GetSystemStatusResponse } from "@/gen/paprika/v1/api_pb"

import { FleetSignalStrip } from "./fleet-signal-strip"

describe("FleetSignalStrip", () => {
  it("shows whole-fleet server facts, not invented percentages or trends", () => {
    const status = new GetSystemStatusResponse({
      total: BigInt(57),
      attentionTotal: BigInt(6),
      health: [
        new FleetHealthBucket({ health: FleetHealth.HEALTHY, count: BigInt(41) }),
        new FleetHealthBucket({ health: FleetHealth.PROGRESSING, count: BigInt(6) }),
      ],
    })
    render(<FleetSignalStrip status={status} />)
    const strip = screen.getByRole("region", { name: "Fleet signals" })
    expect(strip).toHaveAttribute("aria-busy", "false")
    expect(strip).toHaveTextContent("Whole-fleet index · counts are not narrowed by view filters")
    expect(within(strip.querySelector('[data-fleet-signal="index"]') as HTMLElement).getByText("57")).toBeInTheDocument()
    expect(within(strip.querySelector('[data-fleet-signal="healthy"]') as HTMLElement).getByText("41")).toBeInTheDocument()
    expect(within(strip.querySelector('[data-fleet-signal="progressing"]') as HTMLElement).getByText("6")).toBeInTheDocument()
    expect(within(strip.querySelector('[data-fleet-signal="attention"]') as HTMLElement).getByText("6")).toBeInTheDocument()
    expect(strip.querySelectorAll("[data-stat-bar],[data-stat-sparkline]")).toHaveLength(0)
  })

  it("does not turn missing fleet status into zero applications", () => {
    render(<FleetSignalStrip status={undefined} />)
    const strip = screen.getByRole("region", { name: "Fleet signals" })
    expect(strip).toHaveAttribute("aria-busy", "true")
    expect(within(strip).getAllByText("—")).toHaveLength(4)
    expect(within(strip).getAllByText("Awaiting fleet index")).toHaveLength(4)
    expect(within(strip).queryByText("0")).not.toBeInTheDocument()
  })
})
