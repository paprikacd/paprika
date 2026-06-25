import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { ArtifactRef } from "@/gen/paprika/v1/api_pb"
import { useStepArtifacts } from "@/lib/use-step-artifacts"

function artifact(name: string, producingStep: string): ArtifactRef {
  return new ArtifactRef({ name, producingStep, kind: "oci", phase: "Ready" })
}

describe("useStepArtifacts", () => {
  it("returns only artifacts whose producingStep matches", () => {
    const artifacts = [
      artifact("a-build", "build"),
      artifact("a-test", "test"),
      artifact("b-build", "build"),
      artifact("pipeline-level", ""),
    ]

    const { result } = renderHook(() => useStepArtifacts(artifacts, "build"))

    expect(result.current.map((a) => a.name)).toEqual(["a-build", "b-build"])
  })

  it("returns empty array when no artifacts match", () => {
    const artifacts = [artifact("a-test", "test")]

    const { result } = renderHook(() => useStepArtifacts(artifacts, "build"))

    expect(result.current).toEqual([])
  })

  it("returns empty array for empty artifact list", () => {
    const { result } = renderHook(() => useStepArtifacts([], "build"))

    expect(result.current).toEqual([])
  })

  it("memoizes the result for the same inputs", () => {
    const artifacts = [artifact("a-build", "build")]

    const { result, rerender } = renderHook(() => useStepArtifacts(artifacts, "build"))

    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("returns a new filtered array when artifacts change", () => {
    const artifacts = [artifact("a-build", "build")]

    const { result, rerender } = renderHook(
      ({ arts }) => useStepArtifacts(arts, "build"),
      { initialProps: { arts: artifacts } }
    )

    expect(result.current.map((a) => a.name)).toEqual(["a-build"])

    rerender({ arts: [artifact("a-build", "build"), artifact("c-build", "build")] })

    expect(result.current.map((a) => a.name)).toEqual(["a-build", "c-build"])
  })
})
