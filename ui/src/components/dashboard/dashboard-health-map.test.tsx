import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { DashboardHealthMap } from "@/components/dashboard/dashboard-health-map"
import type { Application } from "@/gen/paprika/v1/api_pb"

function makeApplication(name: string, health: "Healthy" | "Degraded", index: number): Application {
  return {
    name,
    namespace: `team-${index % 4}`,
    phase: health,
    currentStage: index % 2 === 0 ? "production" : "canary",
    revision: "",
    synced: health === "Healthy",
    templateRef: "",
    pipelineRef: "delivery",
    releaseRef: `${name}-release-v1`,
    stages: [],
    strategy: "",
    syncPolicy: "",
    parameters: {},
    sourceHash: "",
    sourceRevision: "",
    health,
    healthChecks: [],
    resources: [],
    resourceHealth: [],
    outOfSync: health === "Healthy" ? 0 : 1,
    prunedResources: 0,
    gates: [],
    project: "commerce",
    conditions: [],
    analysisResults: [],
  } as Application
}

const rankedNames = [
  "zebra-api",
  "amber-worker",
  "quartz-web",
  "beacon-cron",
  "yarrow-api",
  "cobalt-worker",
  "xenon-web",
  "delta-cron",
  "willow-api",
  "ember-worker",
  "violet-web",
  "fjord-cron",
  "umber-api",
  "grove-worker",
  "tango-web",
  "harbor-cron",
  "sable-api",
  "iris-worker",
  "raven-web",
  "juniper-cron",
]

const rankedApplications = rankedNames.map((name, index) =>
  makeApplication(name, index < 12 ? "Degraded" : "Healthy", index),
)

function renderedApplicationNames() {
  const results = screen.getByRole("list", { name: "Application health map results" })
  return within(results)
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label")?.split(" ")[0])
}

describe("DashboardHealthMap", () => {
  it("bounds the preview without changing server rank or excluding loaded apps from counts", () => {
    render(<DashboardHealthMap applications={rankedApplications} applicationTotal={250n} />)

    expect(renderedApplicationNames()).toEqual(rankedNames.slice(0, 8))
    expect(screen.getByRole("button", { name: "Show Degraded applications" })).toHaveTextContent("Degraded12")
    expect(screen.getByRole("button", { name: "Show Healthy applications" })).toHaveTextContent("Healthy8")

    const expand = screen.getByRole("button", { name: "Show all 20 loaded applications" })
    expect(expand).toHaveAttribute("aria-expanded", "false")
    expect(expand).toHaveAttribute("aria-controls", "dashboard-health-map-results")
    expect(screen.getByText("8 of 20 loaded · 250 indexed")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "View all applications as treemap" })).toHaveAttribute(
      "href",
      "/dashboard/applications?view=treemap",
    )
  })

  it("expands in server rank and returns to a compact filtered preview", async () => {
    const user = userEvent.setup()
    render(<DashboardHealthMap applications={rankedApplications} applicationTotal={250n} />)

    await user.click(screen.getByRole("button", { name: "Show all 20 loaded applications" }))
    expect(renderedApplicationNames()).toEqual(rankedNames)
    expect(screen.getByRole("button", { name: "Show compact preview" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )

    await user.click(screen.getByRole("button", { name: "Show Degraded applications" }))
    expect(renderedApplicationNames()).toEqual(rankedNames.slice(0, 8))
    expect(screen.getByRole("button", { name: "Show all 12 loaded applications" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })

  it("preserves the complete lossless fleet query while clearing stale detail state", () => {
    render(
      <DashboardHealthMap
        applications={rankedApplications}
        applicationTotal={250n}
        fleetQuery={[
          "project=zeta%2Fpayments",
          "project=alpha%2Fcore",
          "project=zeta%2Fpayments",
          "cluster=ops%2Fprod",
          "stage=production",
          "stage=canary",
          "stage=production",
          "namespace=platform",
          "namespace=apps",
          "health=healthy",
          "health=degraded",
          "sync=synced",
          "sync=out_of_sync",
          "release=failed",
          "release=complete",
          "rollout=healthy",
          "rollout=degraded",
          "source=helm",
          "source=git",
          "q=checkout",
          "view=queue",
          "group=cluster",
          "size=request_rate",
          "selected=apps%2Fcheckout",
          "zoom=project%3Aalpha",
          "range=24h",
          "unknown=kept",
        ].join("&")}
      />,
    )

    const href = screen.getByRole("link", { name: "View all applications as treemap" }).getAttribute("href")!
    const url = new URL(href, "https://paprika.invalid")
    expect(url.pathname).toBe("/dashboard/applications")
    expect(url.searchParams.getAll("project")).toEqual([
      "zeta/payments",
      "alpha/core",
      "zeta/payments",
    ])
    expect(url.searchParams.getAll("stage")).toEqual(["production", "canary", "production"])
    expect(url.searchParams.getAll("namespace")).toEqual(["platform", "apps"])
    expect(url.searchParams.getAll("health")).toEqual(["healthy", "degraded"])
    expect(url.searchParams.getAll("source")).toEqual(["helm", "git"])
    expect(url.searchParams.get("q")).toBe("checkout")
    expect(url.searchParams.get("group")).toBe("cluster")
    expect(url.searchParams.get("size")).toBe("request_rate")
    expect(url.searchParams.get("range")).toBe("24h")
    expect(url.searchParams.get("view")).toBe("treemap")
    expect(url.searchParams.get("unknown")).toBe("kept")
    expect(url.searchParams.has("selected")).toBe(false)
    expect(url.searchParams.has("zoom")).toBe(false)

    const application = screen.getAllByRole("link", { name: /Degraded in team-/i })[0]
    const detail = new URL(application.getAttribute("href")!, "https://paprika.invalid")
    expect(detail.searchParams.get("unknown")).toBe("kept")
    expect(detail.searchParams.get("application_namespace")).toMatch(/^team-/)
    expect(detail.searchParams.get("application_name")).toBeTruthy()
  })
})
