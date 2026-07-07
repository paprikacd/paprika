import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  ResourceTable,
  mergeResources,
  type MergedResource,
} from "@/components/dashboard/resource-table"
import type { Application } from "@/gen/paprika/v1/api_pb"
import { Application as ApplicationClass } from "@/gen/paprika/v1/api_pb"

// Suppress icon imports — lucide-react renders SVGs that don't need testing.
vi.mock("lucide-react", () => {
  const Icon = (p: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...p} />
  return {
    CheckCircle2: Icon,
    AlertCircle: Icon,
    XCircle: Icon,
    Clock: Icon,
    Heart: Icon,
    Activity: Icon,
    ChevronRight: Icon,
  }
})

function makeApplication(props: Partial<Application> = {}): Application {
  return new ApplicationClass({
    name: "demo-app",
    namespace: "test-ns",
    phase: "Healthy",
    resources: [
      { kind: "Deployment", name: "demo-deploy", namespace: "test-ns", status: "Synced" },
      { kind: "Service", name: "demo-svc", namespace: "test-ns", status: "OutOfSync" },
    ],
    resourceHealth: [
      { kind: "Deployment", name: "demo-deploy", namespace: "test-ns", health: "Healthy", message: "OK" },
      { kind: "Service", name: "demo-svc", namespace: "test-ns", health: "Degraded", message: "Connection refused" },
    ],
    ...props,
  })
}

describe("mergeResources", () => {
  it("merges sync status and health by kind+name", () => {
    const merged = mergeResources(makeApplication())
    expect(merged).toHaveLength(2)
    const deploy = merged.find((r) => r.kind === "Deployment")!
    expect(deploy.syncStatus).toBe("Synced")
    expect(deploy.health).toBe("Healthy")
    expect(deploy.healthMessage).toBe("OK")
  })

  it("defaults health to Unknown when not present", () => {
    const merged = mergeResources(
      makeApplication({
        resourceHealth: [],
      }),
    )
    expect(merged).toHaveLength(2)
    expect(merged[0].health).toBe("Unknown")
    expect(merged[0].healthMessage).toBe("")
  })

  it("handles empty resources array", () => {
    const merged = mergeResources(makeApplication({ resources: [] }))
    expect(merged).toHaveLength(0)
  })
})

describe("ResourceTable", () => {
  const sampleResources: MergedResource[] = [
    { kind: "Deployment", name: "demo-deploy", namespace: "test-ns", syncStatus: "Synced", health: "Healthy", healthMessage: "" },
    { kind: "Service", name: "demo-svc", namespace: "test-ns", syncStatus: "OutOfSync", health: "Degraded", healthMessage: "refused" },
    { kind: "ConfigMap", name: "demo-cm", namespace: "test-ns", syncStatus: "Missing", health: "Unknown", healthMessage: "" },
  ]

  it("renders all resources with kind, name, and status", () => {
    render(<ResourceTable resources={sampleResources} onSelect={vi.fn()} />)
    expect(screen.getByText("demo-deploy")).toBeInTheDocument()
    expect(screen.getByText("demo-svc")).toBeInTheDocument()
    expect(screen.getByText("demo-cm")).toBeInTheDocument()
    expect(screen.getAllByText("Synced")).toHaveLength(1)
    expect(screen.getAllByText("OutOfSync")).toHaveLength(1)
    expect(screen.getAllByText("Missing")).toHaveLength(1)
  })

  it("renders nothing when resources array is empty", () => {
    const { container } = render(<ResourceTable resources={[]} onSelect={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("calls onSelect with the clicked resource", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceTable resources={sampleResources} onSelect={onSelect} />)

    await user.click(screen.getByText("demo-svc"))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Service", name: "demo-svc" }),
    )
  })
})
