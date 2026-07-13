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

  it("preserves the complete canonical fleet query while clearing stale detail state", () => {
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
        ].join("&")}
      />,
    )

    const href = screen.getByRole("link", { name: "View all applications as treemap" }).getAttribute("href")!
    const url = new URL(href, "https://paprika.invalid")
    expect(url.pathname).toBe("/dashboard/applications")
    expect([...url.searchParams]).toEqual([
      ["project", "alpha/core"],
      ["project", "zeta/payments"],
      ["cluster", "ops/prod"],
      ["stage", "canary"],
      ["stage", "production"],
      ["namespace", "apps"],
      ["namespace", "platform"],
      ["health", "degraded"],
      ["health", "healthy"],
      ["sync", "out_of_sync"],
      ["sync", "synced"],
      ["release", "complete"],
      ["release", "failed"],
      ["rollout", "degraded"],
      ["rollout", "healthy"],
      ["source", "git"],
      ["source", "helm"],
      ["q", "checkout"],
      ["group", "cluster"],
      ["size", "request_rate"],
      ["range", "24h"],
      ["view", "treemap"],
    ])
    expect(url.searchParams.has("selected")).toBe(false)
    expect(url.searchParams.has("zoom")).toBe(false)
  })
})
