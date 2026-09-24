import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Application, Release } from "@/gen/paprika/v1/api_pb"
import { ApplicationHealth } from "./application-health"

afterEach(() => { cleanup(); vi.useRealTimers() })

describe("application health evidence", () => {
  it("keeps missing checks unknown and distinguishes release completion from retained results", () => {
    render(<ApplicationHealth application={new Application({healthCheckDefinitions: [{name: "readiness", expression: "http.statusCode == 200", httpProbe: {url: "https://app.test/ready", expectedStatus: 200, timeout: 5}}]})}
      release={new Release({name: "release-1", phase: "Complete", verificationChecks: [{type: "smoke-test", endpoint: "https://app.test/ready", timeoutSeconds: 60}]})}
      resources={[]} releaseLoading={false} onSelectResource={vi.fn()} />)
    expect(screen.getByText("Not evaluated")).toBeInTheDocument()
    expect(screen.getByText(/Individual gate timings and responses are not retained/)).toBeInTheDocument()
    expect(screen.getByText(/expected HTTP 200/)).toBeInTheDocument()
    expect(screen.getByText("60s limit")).toBeInTheDocument()
    expect(screen.queryByText("Passed")).not.toBeInTheDocument()
  })

  it("shows failure evidence and can filter and inspect unhealthy resources", async () => {
    const select = vi.fn()
    render(<ApplicationHealth application={new Application({
      healthChecks: [{name: "http-ready", status: "Degraded", message: "Expected 200, received 503", checkedAt: BigInt(1750000000), httpStatusCode: 503}],
      resourceHealth: [{namespace: "apps", kind: "Deployment", name: "api", health: "Degraded", message: "1 of 2 replicas ready"}, {namespace: "apps", kind: "Service", name: "api-service", health: "Healthy"}],
    })} release={null} resources={[]} releaseLoading={false} onSelectResource={select} />)
    expect(screen.getByText("Expected 200, received 503")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", {name: "Needs attention"}))
    const table = screen.getByRole("table", {name: "Resource health observations"})
    expect(within(table).queryByText("api-service")).not.toBeInTheDocument()
    await userEvent.click(within(table).getByRole("button", {name: "Deployment api"}))
    expect(select).toHaveBeenCalledWith(expect.objectContaining({name: "api", healthMessage: "1 of 2 replicas ready"}))
  })
})

it("does not present an old successful probe as currently passing", () => {
  vi.useFakeTimers(); vi.setSystemTime(1800000070000)
  render(<ApplicationHealth application={new Application({healthCheckDefinitions:[{name:"deepcheck",interval:"30s"}],healthChecks:[{name:"deepcheck",status:"Healthy",checkedAt:1800000000n}]})} observedAt={1800000070000} release={null} resources={[]} releaseLoading={false} onSelectResource={vi.fn()} />)
  expect(screen.getByText("Waiting for fresh checks")).toBeVisible()
  expect(screen.getByText("Stale")).toBeVisible()
  expect(screen.queryByText("All checks passing")).not.toBeInTheDocument()
})
it("shows current success independently of failed historical SLO observations", () => {
  vi.useFakeTimers(); vi.setSystemTime(1800000010000)
  render(<ApplicationHealth application={new Application({healthCheckDefinitions:[{name:"deepcheck",interval:"30s",slo:{targetPercentage:99.9,window:"30d"}}],healthChecks:[{name:"deepcheck",status:"Healthy",checkedAt:1800000000n,slo:{state:"Collecting",healthy:38n,unhealthy:1n}}]})} observedAt={1800000010000} release={null} resources={[]} releaseLoading={false} onSelectResource={vi.fn()} />)
  expect(screen.getByText("All checks passing")).toBeVisible()
  expect(screen.getByText("Failed probes")).toBeVisible()
  expect(screen.getByText("1")).toBeVisible()
})

it("ages a cached success into stale even when polling delivers no more data", () => {
  vi.useFakeTimers(); vi.setSystemTime(1800000010000)
  render(<ApplicationHealth application={new Application({healthCheckDefinitions:[{name:"deepcheck",interval:"30s",slo:{targetPercentage:99.9,window:"30d"}}],healthChecks:[{name:"deepcheck",status:"Healthy",checkedAt:1800000000n,slo:{state:"Met",lastObservedAt:1800000000n,intervalSeconds:30n}}]})} observedAt={1800000010000} release={null} resources={[]} releaseLoading={false} onSelectResource={vi.fn()} />)
  expect(screen.getByText("All checks passing")).toBeVisible()
  act(() => { vi.advanceTimersByTime(60_000) })
  expect(screen.queryByText("All checks passing")).not.toBeInTheDocument()
  expect(screen.getByText("Waiting for fresh checks")).toBeVisible()
  expect(screen.getByText(/stopped reporting fresh observations/)).toBeVisible()
})
