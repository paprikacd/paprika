import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { SLOSummary } from "@/gen/paprika/v1/api_pb"
import { durationSeconds, uptimeIntervals, UptimeHistory } from "./uptime-history"

const now = 1800014400 // Aligned to a twelve-hour boundary.
function summary() {
  return new SLOSummary({windowSeconds:2592000n,intervalSeconds:30n,expected:86400n,timeline:[{startedAt:BigInt(now),healthy:1n}]})
}
describe("uptime history", () => {
  it("leaves the unobserved window unknown and preserves the only recorded success", () => {
    const periods = uptimeIntervals(summary(), "30d", now)
    expect(periods).toHaveLength(61)
    expect(periods.slice(0, -1).every((p) => p.state === "unknown" && p.healthy === 0)).toBe(true)
    expect(periods.at(-1)?.healthy).toBe(1)
    expect(periods.reduce((n, p) => n + p.healthy + p.failed + p.unknown + p.unobserved, 0)).toBe(86400)
  })
  it("keeps a failed bucket failed even when most observations passed", () => {
    const result = summary()
    result.timeline[0].healthy = 38n
    result.timeline[0].unhealthy = 1n
    result.timeline[0].unknown = 2n
    const periods = uptimeIntervals(result, "30d", now + 1200)
    expect(periods.at(-1)).toMatchObject({state:"failed",healthy:38,failed:1,unknown:2,unobserved:0})
  })
  it("distinguishes partial coverage from fully healthy time", () => {
    const periods = uptimeIntervals(summary(), "30d", now + 1200)
    expect(periods.at(-1)).toMatchObject({state:"partial",healthy:1,unobserved:40})
  })
  it("creates no successes for a new monitor and honors short configured windows", () => {
    const periods = uptimeIntervals(undefined, "1h", now)
    expect(periods.every((p) => p.state === "unknown")).toBe(true)
    expect(periods.reduce((n,p) => n+p.unobserved,0)).toBe(120)
    expect(durationSeconds("1m30s")).toBe(90)
    expect(durationSeconds("broken30s")).toBe(0)
  })
  it("supports arrow keys, boundary keys and larger previous/next controls", async () => {
    const user = userEvent.setup()
    render(<UptimeHistory result={summary()} window="30d" now={now} />)
    const group = screen.getByRole("group",{name:"30d uptime history"})
    const bars = within(group).getAllByRole("button")
    await user.click(bars.at(-1)!)
    await user.keyboard("{Home}")
    expect(bars[0]).toHaveFocus()
    expect(screen.getByRole("button",{name:"Previous interval"})).toBeDisabled()
    await user.keyboard("{ArrowRight}")
    expect(bars[1]).toHaveFocus()
    await user.keyboard("{End}")
    expect(bars.at(-1)).toHaveFocus()
    expect(screen.getByRole("button",{name:"Next interval"})).toBeDisabled()
    await user.click(screen.getByRole("button",{name:"Previous interval"}))
    expect(bars.at(-2)).toHaveAttribute("aria-pressed","true")
  })
})
