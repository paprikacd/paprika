import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SyncDiffWorkbench } from "@/components/dashboard/sync-diff-workbench"

const application = {
  name: "payments",
  namespace: "prod",
  outOfSync: 2,
  prunedResources: 1,
  resources: [
    { kind: "Deployment", name: "payments-api", namespace: "prod", status: "OutOfSync" },
    { kind: "Service", name: "payments-api", namespace: "prod", status: "Synced" },
    { kind: "ConfigMap", name: "payments-config", namespace: "prod", status: "Missing" },
    { kind: "Job", name: "payments-old-migration", namespace: "prod", status: "Pruned" },
  ],
  resourceHealth: [
    { kind: "Deployment", name: "payments-api", namespace: "prod", health: "Degraded", message: "ReplicaSet unavailable" },
    { kind: "Service", name: "payments-api", namespace: "prod", health: "Healthy", message: "" },
    { kind: "ConfigMap", name: "payments-config", namespace: "prod", health: "Unknown", message: "" },
  ],
}

describe("SyncDiffWorkbench", () => {
  it("summarizes application drift and health pressure", () => {
    render(<SyncDiffWorkbench application={application} onSelectResource={vi.fn()} />)

    expect(screen.getByText("Sync Diff")).toBeInTheDocument()
    expect(screen.getByText("4 resources")).toBeInTheDocument()
    expect(screen.getByText("3 drifted")).toBeInTheDocument()
    expect(screen.getByText("1 degraded")).toBeInTheDocument()
    expect(screen.getByText("1 pruned")).toBeInTheDocument()
  })

  it("filters the diff queue by drift status", async () => {
    const user = userEvent.setup()
    render(<SyncDiffWorkbench application={application} onSelectResource={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: /missing/i }))

    expect(screen.getByText("ConfigMap")).toBeInTheDocument()
    expect(screen.getByText("payments-config")).toBeInTheDocument()
    expect(screen.queryByText("payments-api")).not.toBeInTheDocument()
  })

  it("opens the resource detail drawer from a drift row", async () => {
    const user = userEvent.setup()
    const onSelectResource = vi.fn()
    render(<SyncDiffWorkbench application={application} onSelectResource={onSelectResource} />)

    await user.click(screen.getByRole("button", { name: /open diff for deployment payments-api/i }))

    expect(onSelectResource).toHaveBeenCalledWith({
      kind: "Deployment",
      name: "payments-api",
      namespace: "prod",
      syncStatus: "OutOfSync",
      health: "Degraded",
      healthMessage: "ReplicaSet unavailable",
    })
  })
})
