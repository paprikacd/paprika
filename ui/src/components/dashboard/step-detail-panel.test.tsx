import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { ArtifactRef, Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const buildStep = new Step({ name: "build", image: "", script: "", depends: [] })

function artifact(name: string, producingStep: string, extra: Partial<ArtifactRef> = {}): ArtifactRef {
  return new ArtifactRef({
    name,
    producingStep,
    kind: "oci",
    phase: "Ready",
    resolvedReference: "registry.example.com/app@sha256:abc",
    digest: "sha256:abcdef",
    createdAt: BigInt(1_700_000_000),
    ...extra,
  })
}

describe("StepDetailPanel artifacts section", () => {
  it("does not render Artifacts section when step has no artifacts", () => {
    render(
      <StepDetailPanel
        step={buildStep}
        status={new StepStatus({ name: "build", phase: "Succeeded" })}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        artifacts={[artifact("other-artifact", "test")]}
      />
    )
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument()
  })

  it("renders Artifacts section with cards filtered by producingStep", () => {
    render(
      <StepDetailPanel
        step={buildStep}
        status={new StepStatus({ name: "build", phase: "Succeeded" })}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        artifacts={[
          artifact("build-image", "build"),
          artifact("build-manifest", "build"),
          artifact("test-report", "test"),
        ]}
      />
    )
    expect(screen.getByText("Artifacts")).toBeInTheDocument()
    expect(screen.getByText("build-image")).toBeInTheDocument()
    expect(screen.getByText("build-manifest")).toBeInTheDocument()
    expect(screen.queryByText("test-report")).not.toBeInTheDocument()
  })

  it("renders no Artifacts section when artifacts prop is omitted", () => {
    render(
      <StepDetailPanel
        step={buildStep}
        status={new StepStatus({ name: "build", phase: "Succeeded" })}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument()
  })
})
