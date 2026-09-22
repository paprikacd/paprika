import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import {
  buildJsonPatch,
  JsonPatchPane,
  parseUnifiedDiff,
  SplitDiffPane,
  summarizeUnifiedDiff,
  SyncDiffView,
  toSplitRows,
  UnifiedDiffPane,
} from "@/components/dashboard/sync-diff-view"

const sampleDiff = [
  "--- Desired",
  "+++ Live",
  "@@ -1,5 +1,6 @@",
  " apiVersion: apps/v1",
  " kind: Deployment",
  "-  replicas: 1",
  "+  replicas: 2",
  "+  strategy:",
  " metadata:",
  "-  old-label: true",
].join("\n")

describe("unified diff parsing", () => {
  it("summarizes additions, deletions, hunks, and context lines", () => {
    expect(summarizeUnifiedDiff(sampleDiff)).toEqual({
      additions: 2,
      deletions: 2,
      hunks: 1,
      context: 3,
    })
  })

  it("pairs deletions with additions for the split view and keeps context on both sides", () => {
    const rows = toSplitRows(parseUnifiedDiff(sampleDiff))
    const changed = rows.filter((row) => row.left?.kind === "delete" || row.right?.kind === "add")

    expect(changed).toHaveLength(3)
    expect(changed[0].left?.text).toContain("replicas: 1")
    expect(changed[0].right?.text).toContain("replicas: 2")
    // The trailing deletion has no counterpart, so the live side stays empty
    // rather than borrowing an unrelated addition.
    expect(changed[2].left?.text).toContain("old-label: true")
    expect(changed[2].right).toBeUndefined()
  })
})

describe("SyncDiffView", () => {
  it("renders a scan-friendly diff with line numbers and change summary", () => {
    render(<SyncDiffView diff={sampleDiff} />)

    expect(screen.getByText("2 additions")).toBeInTheDocument()
    expect(screen.getByText("2 deletions")).toBeInTheDocument()
    expect(screen.getByText("1 hunk")).toBeInTheDocument()
    expect(screen.getAllByText("Desired").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0)
    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
  })

  it("filters to changed lines without losing file headers", async () => {
    const user = userEvent.setup()
    render(<SyncDiffView diff={sampleDiff} />)

    await user.click(screen.getByRole("button", { name: "Changes only" }))

    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    expect(screen.queryByText(/apiVersion: apps\/v1/)).not.toBeInTheDocument()
    expect(screen.getAllByText("Desired").length).toBeGreaterThan(0)
  })

  it("reports which line filter is active", async () => {
    const user = userEvent.setup()
    render(<SyncDiffView diff={sampleDiff} />)

    await user.click(screen.getByRole("button", { name: "Additions" }))

    expect(screen.getByRole("button", { name: "Additions" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByRole("button", { name: "All lines" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })

  it("renders a calm empty state when manifests match", () => {
    render(<SyncDiffView diff="" />)

    expect(screen.getByText("No differences")).toBeInTheDocument()
    expect(screen.getByText(/live manifest matches desired/i)).toBeInTheDocument()
  })
})

describe("UnifiedDiffPane", () => {
  it("captions the object it is showing", () => {
    render(<UnifiedDiffPane diff={sampleDiff} caption="apps/v1 Deployment · payments/checkout-api" />)

    expect(
      screen.getByText("apps/v1 Deployment · payments/checkout-api"),
    ).toBeInTheDocument()
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
  })

  it("says the manifests match rather than drawing an empty frame", () => {
    render(<UnifiedDiffPane diff="" />)

    expect(screen.getByText("No differences")).toBeInTheDocument()
  })
})

describe("SplitDiffPane", () => {
  it("labels the desired and live sides", () => {
    render(<SplitDiffPane diff={sampleDiff} />)

    expect(screen.getByText("Desired")).toBeInTheDocument()
    expect(screen.getByText("Live")).toBeInTheDocument()
    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
  })
})

describe("buildJsonPatch", () => {
  it("addresses each operation by the pointer the server supplied", () => {
    expect(
      buildJsonPatch([
        { path: "/spec/replicas", desired: "3", ignored: false },
        { path: "/spec/template/spec/containers/0/image", desired: "ghcr.io/acme/api:9f3a", ignored: false },
      ]),
    ).toEqual([
      { op: "replace", path: "/spec/replicas", value: 3 },
      {
        op: "replace",
        path: "/spec/template/spec/containers/0/image",
        value: "ghcr.io/acme/api:9f3a",
      },
    ])
  })

  it("leaves an already-ignored field out of the patch", () => {
    expect(
      buildJsonPatch([
        { path: "/spec/replicas", desired: "3", ignored: true },
        { path: "/spec/paused", desired: "false", ignored: false },
      ]),
    ).toEqual([{ op: "replace", path: "/spec/paused", value: false }])
  })

  it("keeps a non-JSON value as the string the server reported", () => {
    expect(buildJsonPatch([{ path: "/limits/memory", desired: "1Gi" }])).toEqual([
      { op: "replace", path: "/limits/memory", value: "1Gi" },
    ])
  })
})

describe("JsonPatchPane", () => {
  it("renders the derived document", () => {
    render(
      <JsonPatchPane
        operations={[{ op: "replace", path: "/spec/replicas", value: 3 }]}
        caption="1 replace operation derived from the reported drifted fields"
      />,
    )

    expect(screen.getByText(/"path": "\/spec\/replicas"/)).toBeInTheDocument()
    expect(
      screen.getByText("1 replace operation derived from the reported drifted fields"),
    ).toBeInTheDocument()
  })
})
