import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceListTable, buildTree, type FlatTreeNode } from "@/components/dashboard/resource-list-table"

vi.mock("lucide-react", () => {
  const Icon = (p: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...p} />
  return {
    ChevronRight: Icon,
    Box: Icon,
    Server: Icon,
    Activity: Icon,
  }
})

const flat: FlatTreeNode[] = [
  { kind: "Deployment", name: "demo-deploy", namespace: "test-ns", syncStatus: "Synced", health: "Healthy", parentKind: "", parentName: "", managed: true, ready: 2, total: 3 },
  {
    kind: "ReplicaSet",
    name: "demo-deploy-abc12",
    namespace: "test-ns",
    syncStatus: "Synced",
    parentKind: "Deployment",
    parentName: "demo-deploy",
    managed: false,
  },
  {
    kind: "Pod",
    name: "demo-deploy-abc12-xyz34",
    namespace: "test-ns",
    parentKind: "ReplicaSet",
    parentName: "demo-deploy-abc12",
    managed: false,
    phase: "Running",
  },
]

describe("buildTree", () => {
  it("builds parent → children index from flat list using parentKind/parentName", () => {
    const tree = buildTree(flat)
    expect(tree).toHaveLength(1)
    const root = tree[0]
    expect(root.kind).toBe("Deployment")
    expect(root.subRows).toHaveLength(1)
    expect(root.subRows?.[0].kind).toBe("ReplicaSet")
    expect(root.subRows?.[0].subRows?.[0].kind).toBe("Pod")
  })

  it("puts orphan roots first even when listed after their children", () => {
    const shuffled: FlatTreeNode[] = [
      { kind: "Pod", name: "p1", namespace: "ns", parentKind: "Deployment", parentName: "d1" },
      { kind: "Deployment", name: "d1", namespace: "ns" },
    ]
    const tree = buildTree(shuffled)
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe("Deployment")
    expect(tree[0].subRows).toHaveLength(1)
  })

  it("treats orphan children (parent not in list) as roots", () => {
    const orphan: FlatTreeNode[] = [
      { kind: "Pod", name: "loose-pod", namespace: "ns", parentKind: "Deployment", parentName: "missing" },
    ]
    const tree = buildTree(orphan)
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe("Pod")
  })
})

describe("ResourceListTable", () => {
  it("exposes a named resource table with semantic rows and native detail actions", () => {
    render(<ResourceListTable nodes={flat} onSelect={vi.fn()} />)

    const table = screen.getByRole("table", { name: "Application resources" })
    const deployRow = within(table).getByTestId("row-Deployment-demo-deploy")
    const detailsButton = within(deployRow).getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
    })

    expect(deployRow.tagName).toBe("TR")
    expect(deployRow).not.toHaveAttribute("tabindex")
    expect(detailsButton.tagName).toBe("BUTTON")
    expect(detailsButton).toHaveAttribute("type", "button")
  })

  it("selects the resource exactly once per detail action gesture", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceListTable nodes={flat} onSelect={onSelect} />)
    const expander = screen.getByRole("button", {
      name: "Expand children for Deployment demo-deploy",
    })
    const detailsButton = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
    })

    await user.tab()
    expect(expander).toHaveFocus()
    await user.tab()
    expect(detailsButton).toHaveFocus()

    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledTimes(1)

    onSelect.mockClear()
    await user.keyboard(" ")
    expect(onSelect).toHaveBeenCalledTimes(1)

    onSelect.mockClear()
    await user.click(detailsButton)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("uses expander keyboard actions only to expand and collapse the tree", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceListTable nodes={flat} onSelect={onSelect} />)
    const expander = screen.getByRole("button", {
      name: "Expand children for Deployment demo-deploy",
    })

    expect(expander).toHaveAttribute("aria-expanded", "false")
    await user.tab()
    expect(expander).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("button", {
      name: "Collapse children for Deployment demo-deploy",
    })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("row-ReplicaSet-demo-deploy-abc12")).toBeVisible()
    expect(onSelect).not.toHaveBeenCalled()

    await user.keyboard(" ")
    expect(screen.getByRole("button", {
      name: "Expand children for Deployment demo-deploy",
    })).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("row-ReplicaSet-demo-deploy-abc12")).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("renders root rows by default; children appear after expansion", async () => {
    const user = userEvent.setup()
    render(<ResourceListTable nodes={flat} onSelect={vi.fn()} />)

    // Initially only the root (Deployment) renders — children are collapsed.
    expect(screen.getByTestId("row-Deployment-demo-deploy")).toBeInTheDocument()
    expect(screen.queryByTestId("row-ReplicaSet-demo-deploy-abc12")).not.toBeInTheDocument()

    // Expand the root.
    const expandBtn = screen.getByRole("button", { name: /expand/i })
    await user.click(expandBtn)

    expect(await screen.findByTestId("row-ReplicaSet-demo-deploy-abc12")).toBeInTheDocument()
  })

  it("renders empty state when there are no nodes", () => {
    render(<ResourceListTable nodes={[]} onSelect={vi.fn()} />)
    expect(screen.getByText(/No resources to display/i)).toBeInTheDocument()
  })

  it("calls onSelect when a row is clicked", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceListTable nodes={flat} onSelect={onSelect} />)
    await user.click(screen.getByTestId("row-Deployment-demo-deploy"))
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Deployment", name: "demo-deploy" }),
    )
  })

  it("expands and collapses children via the chevron", async () => {
    const user = userEvent.setup()
    render(<ResourceListTable nodes={flat} onSelect={vi.fn()} />)

    // By default React Table starts collapsed, but rows are still rendered (just hidden via styling?).
    // Click the chevron in the Deployment row to expand.
    const deployRow = screen.getByTestId("row-Deployment-demo-deploy")
    const chevron = deployRow.querySelector("button[aria-label]")!
    await user.click(chevron)

    // After expanding, the child rows are visible.
    expect(screen.getByTestId("row-ReplicaSet-demo-deploy-abc12")).toBeVisible()
  })

  it("renders the ready/total column with status color", () => {
    render(<ResourceListTable nodes={flat} onSelect={vi.fn()} />)
    // Deployment row has ready=2, total=3 (partial → amber).
    const row = screen.getByTestId("row-Deployment-demo-deploy")
    const ready = row.querySelector("td:last-child")
    expect(ready).toHaveTextContent("2/3")
  })
})
