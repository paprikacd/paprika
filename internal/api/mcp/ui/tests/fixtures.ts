import type { Json } from "../src/model.ts";

export const applications: Json[] = [
  { identity: { namespace: "production", name: "checkout-api" }, health: "FLEET_HEALTH_DEGRADED", sync: "FLEET_SYNC_STATE_OUT_OF_SYNC", driftCount: 1, attentionLabel: "Deployment is not ready", attentionDetail: "Candidate pod cannot pull its image", currentStage: "production" },
  { identity: { namespace: "production", name: "storefront" }, health: "FLEET_HEALTH_HEALTHY", sync: "FLEET_SYNC_STATE_SYNCED", driftCount: 0, currentStage: "production" },
  { identity: { namespace: "staging", name: "payments-worker" }, health: "FLEET_HEALTH_UNKNOWN", sync: "FLEET_SYNC_STATE_UNKNOWN", driftCount: 0, currentStage: "staging" },
];
export const connection: Json = {
  endpoint: "https://paprika.benebsworth.com/mcp", origin: "https://paprika.benebsworth.com", name: "paprika.benebsworth.com",
  account: { name: "Fixture operator", email: "operator@example.test" }, scopes: ["paprika:read"], server: { version: "0.2.0-dev", commit: "a94ec12", date: "2026-10-05T08:39:00Z" },
};
export const starfleetConnection: Json = {
  ...connection, endpoint: "https://paprika.starfleethub.com/mcp", origin: "https://paprika.starfleethub.com", name: "paprika.starfleethub.com", account: { name: "Starfleet fixture operator" },
};
export const launch: Json = {
  connection,
  observedAt: "2026-10-05T08:40:00Z", namespace: "", search: "",
  fleet: { total: 3, health: [{ health: "FLEET_HEALTH_HEALTHY", count: 1 }, { health: "FLEET_HEALTH_DEGRADED", count: 1 }, { health: "FLEET_HEALTH_UNKNOWN", count: 1 }], attentionTotal: 1, attention: [applications[0]], serverVersion: "dev" },
  applications: { applications, total: 3, indexGeneration: 42 },
};
const section = (data: Json[]): Json => ({ status: "complete", data, totalCount: data.length, truncated: false });
export function health(name = "checkout-api", namespace = "production"): Json {
  if (name === "payments-worker") return {
    identity: { name, namespace, project: "commerce" }, observedAt: "2026-10-05T08:40:01Z",
    status: { phase: "Pending", health: "Unknown", healthSource: "controllerReported", synced: false, outOfSync: 0, currentStage: "staging", releaseRef: "", sourceRevision: "", retriesExhausted: null, partial: true },
    conditions: section([{ type: "Healthy", status: "Unknown", reason: "AwaitingResourceEvidence", message: "The controller has not recorded resource health yet." }]),
    healthChecks: { ...section([]), note: "No health check results are recorded." },
    resources: { status: "not_available", sync: section([]), health: section([]), note: "No recorded managed resource evidence is available. This does not establish health." },
    gates: section([]), analysis: section([]),
    drift: { status: "not_configured", state: "DATA_STATE_NOT_CONFIGURED", note: "Drift details are not configured. Zero counts do not establish that the application is synced." },
    releases: { status: "error", error: "Release evidence is unavailable." },
    rollouts: { status: "not_available", note: "Linked rollout references cannot be resolved without releases." },
    investigation: { status: "not_requested" },
  };
  const degraded = name === "checkout-api";
  return {
    identity: { name, namespace, project: "commerce" }, observedAt: "2026-10-05T08:40:01Z",
    status: { phase: degraded ? "Failed" : "Healthy", health: degraded ? "Degraded" : "Healthy", healthSource: "controllerReported", synced: !degraded, outOfSync: degraded ? 1 : 0, currentStage: "production", releaseRef: `${name}-a94ec12`, sourceRevision: "a94ec12b6f32891c", retriesExhausted: degraded, partial: false },
    conditions: section(degraded ? [{ type: "ReleaseRetriesExhausted", status: "True", reason: "ReleaseFailed", message: "Candidate Deployment has no ready replicas.", lastTransitionTime: "2026-10-05T08:32:00Z" }] : []),
    healthChecks: section([{ name: "Public health endpoint", status: degraded ? "Failed" : "Passed", message: degraded ? "The endpoint returned HTTP 503." : "The endpoint returned HTTP 200.", checkedAt: 1791189590, durationMillis: 73 }]),
    resources: { status: "complete", note: "Managed resource status reported by the Application controller.", sync: section([{ kind: "Deployment", name, namespace, status: degraded ? "OutOfSync" : "Synced" }]), health: section([{ kind: "Deployment", name, namespace, health: degraded ? "Degraded" : "Healthy", message: degraded ? "0/2 replicas ready; candidate image cannot be pulled." : "2/2 replicas ready." }]) },
    gates: section([]), analysis: section([]),
    drift: { status: "complete", state: "DATA_STATE_OK", data: { evaluatedAtUnixMs: 1791189590000, driftedCount: degraded ? 1 : 0, resources: section(degraded ? [{ group: "apps", version: "v1", kind: "Deployment", name, namespace, reason: "DRIFT_REASON_FIELD_CHANGED", sync: "FLEET_SYNC_STATE_OUT_OF_SYNC", changedFieldCount: 1, fields: [{ path: "/spec/template/spec/containers/0/image", desired: "ghcr.io/example/checkout:a94ec12", live: "ghcr.io/example/checkout:c492ab8" }] }] : []) } },
    releases: { ...section([{ name: `${name}-a94ec12`, namespace, phase: degraded ? "Failed" : "Complete", createdAt: 1791189300, currentStage: "production", canaryWeight: degraded ? 10 : 100, canaryStepIndex: 2, conditions: section(degraded ? [{ type: "Ready", status: "False", message: "Candidate failed its readiness check." }] : []) }, { name: `${name}-c492ab8`, namespace, phase: "Superseded", createdAt: 1791176400, currentStage: "production", conditions: section([]) }]), totalCount: 2 },
    rollouts: { ...section([]), note: "This release manages canary promotion directly." }, investigation: { status: "not_requested" },
  };
}
export const tree: Json = { nodes: [{ kind: "Deployment", name: "checkout-api", namespace: "production", health: "Degraded", healthMessage: "Candidate image cannot be pulled.", syncStatus: "OutOfSync", ready: 0, total: 2, managed: true }, { kind: "Pod", name: "checkout-api-6c9cb7f-kg92z", namespace: "production", health: "Degraded", phase: "Pending", message: "ImagePullBackOff", parentKind: "Deployment", parentName: "checkout-api", ready: 0, total: 1 }, { kind: "Service", name: "checkout-api", namespace: "production", health: "Healthy", syncStatus: "Synced" }] };
export const investigation: Json = { summary: "The candidate image is unavailable. The rollout cannot become ready until the registry reference is corrected.", findings: [{ title: "Candidate pod cannot pull its image", severity: "CRITICAL", description: "The registry rejected the current image reference.", evidence: [{ source: "Pod events", timestamp: "2026-10-05T08:39:48Z", summary: "Failed to pull image: manifest unknown." }], playbook: ["Check the image digest in the source and confirm that it was pushed.", "Correct the source, then request a sync and watch the release."] }], generatedAtMs: 1791189600000 };
export const logs: Json = { podName: "checkout-api-6c9cb7f-kg92z", containerName: "server", logs: "2026-10-05T08:39:50Z starting server\n2026-10-05T08:39:51Z readiness check failed: upstream connection refused" };
export const result = (data: Json) => ({ content: [], structuredContent: data });
