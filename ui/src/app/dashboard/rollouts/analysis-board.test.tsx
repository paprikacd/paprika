import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AnalysisBoard } from "./analysis-board"
import type { AnalysisRow } from "./rollout-model"

function row(patch: Partial<AnalysisRow>): AnalysisRow {
  return {
    key: "k",
    name: "metric",
    query: "",
    tone: "healthy",
    result: "Pass",
    message: "",
    checkedAt: "",
    ...patch,
  }
}

describe("AnalysisBoard", () => {
  it("keeps a partly-filled column and names the cells nothing filled", () => {
    render(
      <AnalysisBoard
        paused={false}
        rows={[
          row({ key: "a", name: "error rate", canary: "0.04" }),
          row({ key: "b", name: "pod restarts" }),
        ]}
      />,
    )

    const table = screen.getByRole("table")
    expect(
      within(table).getByRole("columnheader", { name: "CANARY" }),
    ).toBeInTheDocument()
    expect(within(table).getAllByText("Not reported")).toHaveLength(1)
    expect(within(table).queryByText("0")).not.toBeInTheDocument()
    expect(within(table).queryByText("—")).not.toBeInTheDocument()
  })

  it("explains a failure with the text the check reported, not a template", () => {
    render(
      <AnalysisBoard
        paused
        rows={[
          row({
            key: "a",
            name: "error rate",
            tone: "failed",
            result: "Fail",
            canary: "0.04",
            message: "error rate: 0.04 (threshold 0.02)",
          }),
        ]}
      />,
    )

    expect(
      screen.getByText(/error rate: 0.04 \(threshold 0.02\)/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: /why it paused/i }),
    ).toBeInTheDocument()
  })

  it("does not claim a pause it cannot see when nothing is failing", () => {
    render(
      <AnalysisBoard paused={false} rows={[row({ key: "a" })]} />,
    )

    expect(
      screen.getByRole("heading", { name: "Analysis" }),
    ).toBeInTheDocument()
    expect(screen.getByText("1 metric")).toBeInTheDocument()
  })
})
