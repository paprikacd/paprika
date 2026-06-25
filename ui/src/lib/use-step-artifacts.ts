import { useMemo } from "react"

import type { ArtifactRef } from "@/gen/paprika/v1/api_pb"

/**
 * useStepArtifacts filters an artifact list by producingStep.
 * Pass an empty step name to select pipeline-level artifacts.
 */
export function useStepArtifacts(
  artifacts: ArtifactRef[],
  stepName: string
): ArtifactRef[] {
  return useMemo(
    () => artifacts.filter((a) => a.producingStep === stepName),
    [artifacts, stepName]
  )
}
