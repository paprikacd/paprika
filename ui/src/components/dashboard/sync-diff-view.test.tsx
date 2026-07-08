import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SyncDiffView, summarizeUnifiedDiff } from "@/components/dashboard/sync-diff-view"

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

describe("SyncDiffView", () => {
  it("summarizes additions, deletions, hunks, and context lines", () => {
    expect(summarizeUnifiedDiff(sampleDiff)).toEqual({
      additions: 2,
      deletions: 2,
      hunks: 1,
      context: 3,
    })
  })

  it("renders a scan-friendly diff with line numbers and change summary", () => {
    render(<SyncDiffView diff={sampleDiff} />)

    expect(screen.getByText("2 additions")).toBeInTheDocument()
    expect(screen.getByText("2 deletions")).toBeInTheDocument()
    expect(screen.getByText("1 hunk")).toBeInTheDocument()
    expect(screen.getAllByText("Desired").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0)
    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
    expect(screen.getByText("6")).toBeInTheDocument()
  })

  it("filters to changed lines without losing file headers", async () => {
    const user = userEvent.setup()
    render(<SyncDiffView diff={sampleDiff} />)

    await user.click(screen.getByRole("button", { name: /changes only/i }))

    expect(screen.getByText(/replicas: 1/)).toBeInTheDocument()
    expect(screen.getByText(/replicas: 2/)).toBeInTheDocument()
    expect(screen.queryByText(/apiVersion: apps\/v1/)).not.toBeInTheDocument()
    expect(screen.getAllByText("Desired").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0)
  })

  it("renders a calm empty state when manifests match", () => {
    render(<SyncDiffView diff="" />)

    expect(screen.getByText(/No differences/i)).toBeInTheDocument()
    expect(screen.getByText(/live manifest matches desired/i)).toBeInTheDocument()
  })
})
