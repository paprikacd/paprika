import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SVGProps } from "react"
import { DashboardCommandCenter } from "@/components/dashboard/dashboard-command-center"
import type { Application, Pipeline, Release, Rollout } from "@/gen/paprika/v1/api_pb"

vi.mock("lucide-react", () => {
  const Icon = (props: SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...props} />
  return {
    AlertCircle: Icon,
    ArrowUpRight: Icon,
    Boxes: Icon,
    CheckCircle2: Icon,
    CircleDot: Icon,
    Clock3: Icon,
    GitBranch: Icon,
    History: Icon,
    Layers: Icon,
    Search: Icon,
    Shield: Icon,
    Workflow: Icon,
  }
})

function makeApp(partial: Partial<Application>): Application {
  return {
    name: "",
    namespace: "default",
    phase: "Healthy",
    currentStage: "",
    revision: "",
    synced: true,
    templateRef: "",
    pipelineRef: "",
    releaseRef: "",
    stages: [],
    strategy: "",
    syncPolicy: "",
    parameters: {},
    sourceHash: "",
    sourceRevision: "",
    health: "",
    healthChecks: [],
    resources: [],
    resourceHealth: [],
    outOfSync: 0,
    prunedResources: 0,
    gates: [],
    project: "",
    conditions: [],
    analysisResults: [],
    ...partial,
  } as Application
}

const applications = [
  makeApp({
    name: "checkout-api",
    namespace: "prod",
    health: "Degraded",
    phase: "Progressing",
    currentStage: "canary",
    releaseRef: "checkout-api-release",
    outOfSync: 2,
    resourceHealth: [
      { kind: "Deployment", name: "checkout-api", namespace: "prod", health: "Degraded", message: "1 pod crash looping" },
      { kind: "Service", name: "checkout-api", namespace: "prod", health: "Healthy", message: "" },
    ],
  }),
  makeApp({
    name: "ledger-worker",
    namespace: "finance",
    health: "Healthy",
    phase: "Healthy",
    currentStage: "stable",
    releaseRef: "ledger-worker-release",
  }),
  makeApp({
    name: "catalog",
    namespace: "prod",
    health: "Progressing",
    phase: "Canarying",
    currentStage: "canary",
  }),
]

const pipelines = [{ name: "checkout-build", namespace: "prod", phase: "Running" }] as Pipeline[]
const releases = [{ name: "checkout-api-release", namespace: "prod", phase: "Canarying", application: "checkout-api" }] as Release[]
const rollouts = [{ name: "checkout-api-rollout", namespace: "prod", phase: "Progressing" }] as Rollout[]

function renderCommandCenter() {
  return render(
    <DashboardCommandCenter
      applications={applications}
      pipelines={pipelines}
      releases={releases}
      rollouts={rollouts}
      applicationSets={[]}
      policies={[]}
      loading={false}
    />,
  )
}

describe("DashboardCommandCenter", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("searches across cluster objects and remembers selected searches", async () => {
    const user = userEvent.setup()
    renderCommandCenter()

    expect(screen.getByRole("heading", { name: /cluster command center/i })).toBeInTheDocument()

    await user.type(screen.getByRole("searchbox", { name: /search operations/i }), "checkout")

    const results = screen.getByRole("list", { name: /search results/i })
    expect(within(results).getByRole("link", { name: /Application checkout-api/i })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=prod&name=checkout-api",
    )
    expect(within(results).getByRole("link", { name: /Pipeline checkout-build/i })).toBeInTheDocument()
    expect(within(results).getByRole("link", { name: /Rollout checkout-api-rollout/i })).toBeInTheDocument()

    await user.click(within(results).getByRole("link", { name: /Application checkout-api/i }))

    expect(localStorage.getItem("paprika-dashboard-recent-searches")).toContain("checkout")
    expect(screen.getByRole("button", { name: /recent search checkout/i })).toBeInTheDocument()
  })

  it("filters the app health heatmap and links tiles to app drilldown", async () => {
    const user = userEvent.setup()
    renderCommandCenter()

    expect(screen.getByRole("link", { name: /checkout-api Degraded/i })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=prod&name=checkout-api",
    )
    expect(screen.getByRole("link", { name: /ledger-worker Healthy/i })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /show degraded applications/i }))

    expect(screen.getByRole("link", { name: /checkout-api Degraded/i })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /ledger-worker Healthy/i })).not.toBeInTheDocument()
    expect(screen.getByText("prod")).toBeInTheDocument()
    expect(screen.getByText(/1 pod crash looping/i)).toBeInTheDocument()
  })
})
