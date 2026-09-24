import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Application } from "@/gen/paprika/v1/api_pb"
import { ApplicationSLOs } from "./application-slos"
import { safeOperationalLink } from "./application-operations"

describe("availability objectives", () => {
  it("shows a partial window honestly and opens detailed health from the summary", async () => {
    const open = vi.fn()
    const app = new Application({healthCheckDefinitions:[{name:"deepcheck",interval:"30s",slo:{targetPercentage:99.9,window:"30d"}}]})
    render(<ApplicationSLOs application={app} compact onOpenHealth={open} />)
    expect(screen.getByText("99.9%")).toBeInTheDocument()
    expect(screen.getByText("No observations yet")).toBeInTheDocument()
    expect(screen.getByText(/Collecting the full 30d window/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button",{name:/View uptime/}))
    expect(open).toHaveBeenCalledOnce()
  })
  it("renders failures, missing intervals and a stale monitor in the health evidence", async () => {
    const app = new Application({healthCheckDefinitions:[{name:"deepcheck",slo:{targetPercentage:99.9,window:"30d"}}],healthChecks:[{name:"deepcheck",slo:{state:"Stale",healthy:BigInt(9),unhealthy:BigInt(1),unknown:BigInt(2),availabilityPercentage:90,coveragePercentage:83.333,windowCoveragePercentage:0.01,burnRate:100,errorBudgetRemainingPercentage:98,timeline:[{startedAt:BigInt(1800000000),healthy:BigInt(9),unhealthy:BigInt(1),unknown:BigInt(2)}]}}]})
    render(<ApplicationSLOs application={app} />)
    expect(screen.getByText("Stale")).toBeInTheDocument()
    expect(screen.getByText(/9 healthy · 1 failed · 2 missed/)).toBeInTheDocument()
    expect(screen.getByText(/stopped reporting fresh/)).toBeInTheDocument()
    await userEvent.click(screen.getByText("Uptime observation history"))
    expect(screen.getByRole("table",{name:"Availability observations grouped by time"})).toBeVisible()
  })
  it("rejects unsafe operational link schemes and credentials",()=>{
    expect(safeOperationalLink("https://grafana.example/d/sfh")).toBe(true)
    expect(safeOperationalLink("javascript:alert(1)")).toBe(false)
    expect(safeOperationalLink("https://user:password@example.com")).toBe(false)
  })
})
