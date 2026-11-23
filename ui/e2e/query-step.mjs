// The step an Insights range query plans, from the same policy the UI and the server share
// (src/features/insights/query-step.ts). The e2e suites use it to predict the step a request carries.
import { DEFAULT_TARGET_POINTS, queryStep } from "../src/features/insights/query-step.ts";

// A Prometheus provider without config.step has this minimum (the server default). No live provider sets one.
export const PROMETHEUS_MINIMUM_STEP_SECONDS = 15;

// plannedStep is the step, in seconds, for a range in seconds, at the provider's minimum step.
export function plannedStep(spanSeconds, minStepSeconds = PROMETHEUS_MINIMUM_STEP_SECONDS) {
  return queryStep(spanSeconds, DEFAULT_TARGET_POINTS, minStepSeconds);
}
