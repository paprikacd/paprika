import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { HookStatus, Release } from "@/gen/paprika/v1/api_pb"
import { ReleaseGrid } from "@/components/dashboard/release-table"

describe("ReleaseGrid", () => {
  it("renders rollout, hook, and canary state", () => {
    render(
      <ReleaseGrid
        releases={[
          new Release({
            name: "demo-release",
            namespace: "apps",
            pipeline: "demo-pipeline",
            target: "prod",
            phase: "Canarying",
            currentStage: "prod",
            rolloutRef: "demo-rollout",
            canaryWeight: 50,
            canaryStepIndex: 2,
            renderedManifestSnapshot: "demo-release-snapshot",
            hookStatuses: [
              new HookStatus({
                kind: "Job",
                name: "pre-sync",
                phase: "PreSync",
                status: "Succeeded",
              }),
              new HookStatus({
                kind: "Job",
                name: "post-sync",
                phase: "PostSync",
                status: "Running",
              }),
            ],
          }),
        ]}
      />,
    )

    expect(screen.getByText("demo-rollout")).toBeInTheDocument()
    expect(screen.getByText("Canary 50%")).toBeInTheDocument()
    expect(screen.getByText("step 2")).toBeInTheDocument()
    expect(screen.getByText("demo-release-snapshot")).toBeInTheDocument()
    expect(screen.getByText("Hooks")).toBeInTheDocument()
    expect(screen.getByText("1/2")).toBeInTheDocument()
  })
})
