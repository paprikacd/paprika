import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import {
  ResourceTree,
  buildTree,
  collapsibleIds,
  resourceSummary,
  resourceSyncLabel,
  type FlatTreeNode,
} from "@/components/dashboard/resource-list-table"

const flat: FlatTreeNode[] = [
  {
    kind: "Deployment",
    name: "demo-deploy",
    namespace: "test-ns",
    syncStatus: "OutOfSync",
    health: "Degraded",
    parentKind: "",
    parentName: "",
    managed: true,
    ready: 2,
    total: 3,
  },
  {
    kind: "ReplicaSet",
    name: "demo-deploy-abc12",
    namespace: "test-ns",
    syncStatus: "Synced",
    health: "Progressing",
    parentKind: "Deployment",
    parentName: "demo-deploy",
    managed: false,
  },
  {
    kind: "Pod",
    name: "demo-deploy-abc12-xyz34",
    namespace: "test-ns",
    syncStatus: "Synced",
    health: "Failed",
    parentKind: "ReplicaSet",
    parentName: "demo-deploy-abc12",
    managed: false,
    phase: "CrashLoopBackOff",
  },
]

/** The board owns collapse state, so the harness stands in for it. */
function Harness({
  nodes = flat,
  onSelect = vi.fn(),
  initialCollapsed = new Set<string>(),
}: {
  nodes?: FlatTreeNode[]
  onSelect?: (n: { kind: string; name: string }) => void
  initialCollapsed?: Set<string>
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(initialCollapsed)
  return (
    <ResourceTree
      nodes={nodes}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      onSelect={onSelect}
    />
  )
}

describe("buildTree", () => {
  it("builds a parent → children index from parentKind/parentName", () => {
    const tree = buildTree(flat)
    expect(tree).toHaveLength(1)
    expect(tree[0].subRows?.[0].kind).toBe("ReplicaSet")
    expect(tree[0].subRows?.[0].subRows?.[0].kind).toBe("Pod")
  })

  it("treats a child whose parent is absent as a root, dropping nothing", () => {
    const tree = buildTree([
      { kind: "Pod", name: "loose", namespace: "ns", parentKind: "Deployment", parentName: "gone" },
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe("Pod")
  })
})

describe("collapsibleIds", () => {
  it("closes every parent below the root and leaves the root open", () => {
    expect([...collapsibleIds(flat)]).toEqual(["ReplicaSet/demo-deploy-abc12"])
  })
})

describe("resourceSummary", () => {
  it("assembles a summary only from fields the server actually sent", () => {
    expect(resourceSummary({ kind: "Pod", name: "p", namespace: "ns" })).toBe("")
    expect(
      resourceSummary({
        kind: "Deployment",
        name: "d",
        namespace: "ns",
        ready: 1,
        total: 3,
        message: "4 fields drifted",
      })
    ).toBe("1/3 ready · 4 fields drifted")
  })

  it("never invents a ready count when the server reported no total", () => {
    // A `0/0` would read as a real observation of zero replicas.
    expect(resourceSummary({ kind: "Pod", name: "p", namespace: "ns", ready: 0, total: 0 })).toBe("")
  })
})

describe("resourceSyncLabel", () => {
  it("calls a drifted resource Drifted, not Degraded", () => {
    expect(resourceSyncLabel("OutOfSync")).toBe("Drifted")
    expect(resourceSyncLabel("Synced")).toBe("Synced")
    expect(resourceSyncLabel("")).toBe("Unknown")
  })
})

describe("ResourceTree", () => {
  it("renders one row per resource, fully expanded, with its level", () => {
    render(<Harness />)
    const rows = screen.getAllByRole("row")
    // Three resources plus the column header row.
    expect(rows).toHaveLength(4)
    expect(screen.getByTestId("row-Pod-demo-deploy-abc12-xyz34")).toHaveAttribute(
      "aria-level",
      "3"
    )
  })

  it("hides descendants when a parent collapses and says so on the row", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const collapse = screen.getByRole("button", {
      name: "Collapse ReplicaSet demo-deploy-abc12",
    })
    await user.click(collapse)

    expect(screen.queryByTestId("row-Pod-demo-deploy-abc12-xyz34")).not.toBeInTheDocument()
    expect(screen.getByTestId("row-ReplicaSet-demo-deploy-abc12")).toHaveAttribute(
      "aria-expanded",
      "false"
    )
  })

  it("expands and collapses from the keyboard on the row itself", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const row = screen.getByTestId("row-ReplicaSet-demo-deploy-abc12")
    row.focus()
    await user.keyboard("{ArrowLeft}")
    expect(screen.queryByTestId("row-Pod-demo-deploy-abc12-xyz34")).not.toBeInTheDocument()

    screen.getByTestId("row-ReplicaSet-demo-deploy-abc12").focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByTestId("row-Pod-demo-deploy-abc12-xyz34")).toBeInTheDocument()
  })

  it("opens the inspector on Enter and on click", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<Harness onSelect={onSelect} />)

    await user.click(screen.getByTestId("row-Deployment-demo-deploy"))
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "Deployment", name: "demo-deploy" })
    )

    screen.getByTestId("row-Pod-demo-deploy-abc12-xyz34").focus()
    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "Pod", name: "demo-deploy-abc12-xyz34" })
    )
  })

  it("states each row's health and sync in words, not colour alone", () => {
    render(<Harness />)
    const row = screen.getByTestId("row-Deployment-demo-deploy")
    expect(row).toHaveTextContent("Degraded")
    expect(row).toHaveTextContent("Drifted")
    expect(row).toHaveTextContent("2/3 ready")
  })

  it("says the tree is empty rather than drawing a header over nothing", () => {
    render(<Harness nodes={[]} />)
    expect(screen.getByText(/No managed resources reported/i)).toBeInTheDocument()
    expect(screen.queryByRole("treegrid")).not.toBeInTheDocument()
  })
})
