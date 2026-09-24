import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vitest"
import { Application, DrilldownKind } from "@/gen/paprika/v1/api_pb"
import { RecentCheckIssues, ProbeResponse, responseEvidence } from "./health-check-evidence"
import { operationalLinkBrand, OperationalLinkIcon } from "./operational-link-icon"

afterEach(cleanup)
it("keeps recovered failure evidence available and expands its dependency and response details", async () => {
  render(<RecentCheckIssues application={new Application({ healthChecks: [{ name: "internal-deepcheck", status: "Healthy", recentFailures: [{ checkedAt: 1800000000n, status: "Degraded", reason: "UnexpectedStatus", httpStatusCode: 503, durationMillis: 82n, message: "Expected HTTP 200, received HTTP 503", httpBody: JSON.stringify({checks:[{name:"frontend_backend",ok:true,latency:"2ms"},{name:"database_app",ok:false,error:"dependency unavailable"}]}) }] }] })} />)
  expect(screen.getByText(/including after recovery/)).toBeVisible()
  await userEvent.click(screen.getByText("Unexpected HTTP status"))
  expect(screen.getByText("Expected HTTP 200, received HTTP 503")).toBeVisible()
  const dependencies = screen.getByLabelText("Dependency check results")
  expect(within(dependencies).getByText("database_app")).toBeVisible()
  expect(within(dependencies).getByText("Failed")).toBeVisible()
  await userEvent.click(screen.getByText("Captured response"))
  expect(screen.getByText(/"checks":/)).toBeVisible()
})
it("does not invent diagnostics for historical counts", () => {
  render(<RecentCheckIssues application={new Application({ healthChecks: [{name:"ready", slo:{unhealthy:1n}}] })} />)
  expect(screen.getByText(/past responses cannot be reconstructed/)).toBeVisible()
})
it("renders non-JSON, truncated and HTML responses as plain text", async () => {
  render(<ProbeResponse body={'<script>alert("no")</script>'} truncated />)
  await userEvent.click(screen.getByText("Captured response · excerpt"))
  expect(screen.getByText('<script>alert("no")</script>')).toBeVisible()
  expect(document.querySelector('script')).toBeNull()
  expect(screen.getByText(/Response truncated/)).toBeVisible()
  expect(responseEvidence('{"checks":[null,{"name":"bad","ok":"false"}]}').checks).toEqual([])
})
it("chooses brands for custom Grafana hosts and GitHub without accepting lookalike GitHub domains", () => {
  expect(operationalLinkBrand("https://grafana-ops-example.a.run.app/d/a", "Workload logs")).toBe("grafana")
  expect(operationalLinkBrand("https://monitor.example/d/a", "Grafana dashboard")).toBe("grafana")
  expect(operationalLinkBrand("https://github.com/team/repo", "Source")).toBe("github")
  expect(operationalLinkBrand("https://github.com.example.test", "Source")).toBeUndefined()
  const {container} = render(<OperationalLinkIcon url="https://github.com/team/repo" label="Source" kind={DrilldownKind.REPOSITORY} />)
  expect(container.querySelector('img')).toHaveAttribute('src', '/brands/github.svg')
  expect(container.querySelector('img')).toHaveAttribute('alt', '')
})
