# Paprika — Unified CI/CD + Feature Flag System

**Date:** 2026-06-07
**Status:** Draft

## Overview

Paprika is a Kubernetes-native CI/CD and feature flag system that unifies continuous integration, continuous delivery, feature flagging, and release targeting in a single CRD-driven operator. It wraps existing tools (Helm, Kustomize, Argo CD) rather than replacing them.

## Core CRDs

CRD examples show the final state across all phases. Fields marked with a phase label (e.g., `[P2]`) are inert until that phase.

### Pipeline

CI definition. **Phase 1** sources from Git only. Steps execute as a DAG. Produces Artifact objects.

```yaml
kind: Pipeline
spec:
  maxParallel: 10                  # max concurrent steps
  sources:                          # Phase 1: git only. Phase 3: s3, oci
    - type: git
      url: https://github.com/org/repo
  steps:
    - name: build
      image: golang:1.22
      script: make build
      timeout: 600                 # seconds, default 3600
    - name: test
      depends: [build]
      image: golang:1.22
      script: make test
    - name: lint
      depends: [build]
      image: golangci/golangci-lint:v1.55
      script: golangci-lint run
      retry: 2                     # per-step retry count
    - name: deploy-infra          # any image/CLI via script type
      image: hashicorp/terraform:1.7
      script: terraform apply -auto-approve tfplan
  artifacts:
    - name: image
      path: registry.example.com/app:{{ .Tag }}
status:
  phase: Succeeded | Running | Failed
  stepStatuses:
    - name: build
      phase: Succeeded
      startedAt: "2026-06-07T10:00:00Z"
      completedAt: "2026-06-07T10:02:00Z"
    - name: test
      phase: Succeeded
      startedAt: "2026-06-07T10:02:00Z"
      completedAt: "2026-06-07T10:03:00Z"
  lastExecutionTime: "2026-06-07T10:00:00Z"
  lastExecutionID: "build-1234"
```

**Step types:**

| Type | Behavior | Lifecycle | Phase |
|---|---|---|---|
| `script` | Inline command in a container (runs as a Job pod). Any image/CLI. Default timeout: 3600s | Pod lives for step duration, logs captured with `logRef` | P1 |
| `ts` | TypeScript function compiled to WASM, executed in-process | Runs in operator process, sandboxed | P3 |

All step types stream stdout/stderr to a temporary store. Each `.status.stepStatuses[].logRef` references the stored log for that step. Users fetch logs via `pk pipeline logs <pipeline> --step <name>` which reads the log store directly through the K8s API. Logs retained for 7 days.

**DAG execution model:**

- Steps without `depends` run in parallel (up to `maxParallel: 10` default, configurable per Pipeline). When more steps are ready than `maxParallel`, they queue and execute in the order they were defined in the Pipeline spec
- Steps with `depends` run after all listed dependencies complete successfully
- Fan-out: N steps can depend on 1 step (fan-out is implicit)
- Fan-in: 1 step can depend on N steps (fan-in is implicit)
- Conditional execution: steps only run if all dependencies succeed. No skip-on-failure or conditional branch in Phase 1
- Per-step retry: `retry: N` re-runs the step on failure up to N times
- Pipeline-level retry: `spec.retry: N` re-runs the entire pipeline on any step failure (Phase 2+)
- Timeout per step: `timeout: 600` (seconds, default 3600)

### Stage

Environment/ring definition with targeting rules and promotion gates.

```yaml
kind: Stage
spec:
  name: prod-us-east
  ring: 3
  cluster:
    name: prod-us-east-1
    argocd:                        # [P4] Argo CD instance — inert until Phase 4
      server: https://argocd.example.com
      appName: my-app-prod
  templates: [app-template]         # references Template CRD by .metadata.name
  gates:                           # Phase 1: smoke-test, duration. Phase 2+: approval, conftest. Phase 4: rollout-status
    - type: smoke-test
    - type: duration
```

### Release

Unified orchestration object. Ties build → render → promote → verify. Flag support in Phase 2+.

```yaml
kind: Release
spec:
  pipeline: app-pipeline
  target: prod-us-east
  from: staging
  flags: [P2]                      # Phase 2+
    - name: new-checkout-flow
      value: true
    - name: experimental-api
      rollout: 25
  verify:
    - type: rollout-status
      timeout: 300
    - type: smoke-test
      endpoint: /healthz
      timeout: 60
  on_failure:
    action: rollback              # rollback | halt | ignore
    notify: ["slack:#alerts"]
status:
  phase: Promoting | Verifying | Complete | Failed | RolledBack | Superseded
  currentStage: prod-us-east
  promotionHistory:
    - stage: staging
      result: Passed
      manifestSnapshot: paprika-manifest-snapshots/staging-20260607
      timestamp: "2026-06-07T09:00:00Z"
    - stage: prod-us-east
      result: Pending
      timestamp: "2026-06-07T10:00:00Z"
  conditions:
    - type: Verified
      status: "True"
  renderedManifestSnapshot: paprika-manifest-snapshots/prod-us-east-20260607
```

### Flag

Feature flag CRD. Phase 2. Supports boolean, percentage rollout, and experiment (A/B) variants. Tenant-level targeting is Phase 4.

Flags are evaluated **at promotion time** — their state is baked into rendered manifests before deployment. The `resources` field tells the operator which K8s objects to create or prune when a flag transitions between stages, not for runtime toggling.

```yaml
kind: Flag
spec:
  name: new-checkout-flow
  description: Redesigned checkout experience
  owner: checkout-team
  resources:
    - group: networking.k8s.io
      kind: Ingress
      name: app-new-ingress
    - kind: ConfigMap
      name: app-checkout-config
  targeting:
    - stage: dev
      value: true
    - stage: staging
      value: false
    - stage: prod
      value: false
      rollout: 25
status:
  evaluatedAt:
    dev: { value: true, timestamp: "2026-06-07T08:00:00Z", release: "release-42" }
    staging: { value: false, timestamp: "2026-06-07T09:00:00Z", release: "release-43" }
    prod: { value: false, timestamp: "2026-06-07T10:00:00Z", release: "release-44" }
```

**Flag transition detection:** The operator reads the most recent entry in `.status.evaluatedAt` for the target stage to determine the previous value. If no previous entry exists, the default is `false`. This allows the operator to detect `false→true` (include resources) or `true→false` (prune resources) transitions at promotion time.

### Template

Parameterized manifest generation. Phase 1 supports Helm only. Phase 4 adds Kustomize and Raw adapters. When a Stage references multiple Templates, each is rendered independently and applied sequentially in the order listed in `spec.templates`. Manifests from later templates override conflicts with earlier ones (last-write-wins).

```yaml
kind: Template
spec:
  type: helm                     # Phase 1: helm. Phase 4: helm | kustomize | raw
  chart:
    repo: https://charts.example.com
    name: my-app
    version: 3.2.1
  flag_bindings: [P2]            # Phase 2+
    - flag: new-ingress-controller
      target_path: ingress.enabled
      value_map:
        true: "true"
        false: "false"
status:
  lastRendered: "2026-06-07T10:00:00Z"
  lastRenderHash: sha256:def456...
```

### Artifact

References built artifacts. Created automatically by the operator when a Pipeline completes — each entry in `Pipeline.spec.artifacts` produces one Artifact CRD. Phase 1 supports OCI/image artifacts. Phase 3 adds S3 and OCI blob artifacts.

```yaml
kind: Artifact
spec:
  type: oci                       # Phase 1: oci only. Phase 3: oci | s3
  reference: registry.example.com/app:v1.2.3
  digest: sha256:abc123...
  provenance:
    pipeline: app-pipeline
    build: build-1234
status:
  verified: true
```

### Plugin

Extensible WASM-compiled step for custom pipeline logic. Phase 3.

```yaml
kind: Plugin
spec:
  name: snyk-scan
  registry: oci://plugins.example.com/snyk-scan:v1
  inputs:
    image: string
  outputs:
    vulnerabilities: array
```

**Motivating example for WASM/TypeScript (Phase 3):** "Run a custom security scanner that queries an internal API, parses results, and fails the pipeline if critical vulnerabilities are found in a specific package namespace." This requires HTTP calls, JSON parsing, and conditional logic that is unwieldy as inline bash but trivial as a TypeScript function.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Kubernetes                         │
│                                                       │
│  ┌──────────────────────────────────────────┐        │
│  │         Paprika Operator                  │        │
│  │  ┌──────────┐ ┌──────────┐ ┌─────────┐   │        │
│  │  │ Reconciler│ │  Flag    │ │Template │   │        │
│  │  │ Engine    │ │  Engine  │ │ Renderer│   │        │
│  │  └──────────┘ └──────────┘ └─────────┘   │        │
│  │  ┌──────────────────────────────────┐     │        │
│  │  │  Workflow Engine (DAG executor)  │     │        │
│  │  └──────────────────────────────────┘     │        │
│  └──────────────────────────────────────────┘        │
│                                                       │
│  ┌──────────────────────────────────────────┐        │
│  │  CRDs                                      │        │
│  │  Pipeline │ Stage │ Release │ Flag │ ...   │        │
│  └──────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────┘
```

### Deployment Model

| Property | Detail |
|---|---|
| **Scope** | Cluster-scoped operator (watches CRDs across all namespaces). CRDs are cluster-scoped, CR instances can be namespace-scoped |
| **CRD API version** | `paprika.io/v1alpha1` (Phase 1-2), graduates to `v1` at GA. Conversion webhooks between versions |
| **Admission webhooks** | ValidatingWebhookConfiguration for CRD validation (required fields, valid references). MutatingWebhook for default values |
| **High availability** | Operator runs as a Deployment with 2+ replicas. Leader election via `coordination.k8s.io/Leases` with 15s lease duration. Only the leader reconciles |
| **Namespace strategy** | Operator in `paprika-system` namespace. CRs can be in any namespace. Operator uses `paprika.io/namespace` label for multi-tenant isolation |
| **Resource footprint** | Operator requests: 100m CPU, 256Mi memory. Per Pipeline step: 1 Job pod |

### User-Facing API Surface

| Interface | Purpose |
|---|---|
| `kubectl` | Native CRD management — `kubectl apply -f release.yaml` |
| Paprika CLI (`pk`) | Higher-level commands: `pk release promote`, `pk flag toggle`, `pk pipeline logs`, `pk release status`. CLI authenticates via kubeconfig (same as kubectl) and talks directly to the K8s API. No operator HTTP endpoint |
| Status sub-resources | Each CRD exposes `.status` with phase, conditions, timestamps |

### Component Interfaces

| Component | Input | Output | Depends On |
|---|---|---|---|
| **Reconciler Engine** | CRD watch events (any CRD type) | Reconciliation triggers to specific controllers | K8s API server |
| **Workflow Engine** | Pipeline CRD spec | Step execution results, Artifact CRD creation | Reconciler Engine (pipeline triggers) |
| **Flag Engine** | Flag CRD spec + Stage CRD targeting rules | Evaluated flag values per stage (map[string]interface{}) | Reconciler Engine (flag/stage triggers). Optional — no-op when Flag CRDs are absent (Phase 1) |
| **Template Renderer** | Template CRD spec + optional flag values + params from Release | Rendered manifest YAML | Reconciler Engine (template triggers). Flag Engine values optional — renders without flags in Phase 1 |
| **Promotion Controller** | Release CRD spec + rendered manifests (in-process Go struct) + gate results | Stage updates, Release status transitions, rollback actions | Template Renderer (in-process Go function call returning `[]Manifest`). Flag Engine values optional (Phase 1 uses `{}`) |

### Verification Gate Types

| Gate Type | Behavior | Status Source | Phase |
|---|---|---|---|
| `rollout-status` | Polls Argo CD app health for deployed manifests | Argo CD API (`/api/v1/applications/{name}`) | P4 |
| `smoke-test` | Makes HTTP request to specified endpoint. Succeeds on 2xx within timeout | In-cluster HTTP | P1 |
| `conftest` | Runs OPA/Conftest policies against rendered manifests. Succeeds on pass | In-process policy engine | P2 |
| `approval` | Blocks until approved via `pk release approve`. Succeeds on explicit approval | Paprika API | P2 |
| `metric-check` | Queries Prometheus for metric threshold. Succeeds when below threshold | Prometheus API | P3 |
| `duration` | Waits a specified duration before proceeding. Succeeds after elapsed time | In-process timer | P1 |

### Argo CD Integration

Phase 4. The `rollout-status` gate authenticates to Argo CD using:
1. Stage CRD references `argocd.server` URL and `argocd.appName`
2. Auth token from a Secret named `<stage-name>-argocd-token` in the operator namespace
3. Operator polls `GET /api/v1/applications/{appName}` every 10s until `status.health.status == "Healthy"` or timeout
4. Token rotation: operator watches the Secret for changes. If a `401` response is received mid-polling, the gate fails with `ArgoCDAuthExpired`. A new Release must be created after the token is rotated

### Rollback Mechanism

When a Release fails and `on_failure.action == rollback`:

1. **Snapshot storage:** Before each promotion, the operator stores the current rendered manifests as a ConfigMap named `<stage-name>-manifest-snapshot` with labels `paprika.io/stage` and `paprika.io/release`
2. **Rollback execution:** The operator applies the previous snapshot's manifests to the target cluster
3. **Flag state reversion** [P2]: The Flag CRD's `.status.evaluatedAt` is reverted to the previous Release's entry
4. **Release status:** transitions to `RolledBack` with `.status.conditions` set to `{ type: RolledBack, reason: VerificationFailed, message: "rollout-status timed out" }`
5. **Notification:** If `notify` is configured, the operator sends the alert (Slack webhook)

### Data Flow

```
Developer push → Pipeline (build + test) → Artifact(s)
                                              ↓
                              Template rendering (per Stage)
                                              ↓
                              Flag evaluation [P2] (per Stage)
                                              ↓
                              Release (promote through rings)
                                              ↓
                              Verification gates → promotion or rollback
```

### Flag Conflict Resolution

When two Releases target the same Flag with different values:

1. The Release targeting a **later ring** (higher stage number) wins
2. If both target the same ring, the **most recently created** Release wins
3. The losing Release's status is set to `Superseded`
4. The operator logs the conflict and emits a K8s Event
5. The Flag CRD's `.status.evaluatedAt` reflects the winning value

### Reconciliation on Restart

On operator startup (leader only):
1. Reconcile all CRDs from the API server
2. For each Release in `Promoting` or `Verifying` phase: restart from the last known checkpoint (`.status.conditions`)
3. In-flight Pipeline steps are retried with exponential backoff (1s, 2s, 4s, max 30s)
4. Orphaned Artifacts (no referencing Release) are garbage collected after 24h

## Flag Evaluation Model

Phase 2+. Flags are evaluated at promotion time. Flag state is baked into rendered manifests before deployment. The `resources` field on a Flag CRD is used for **post-promotion resource lifecycle management** — the operator detects changes by comparing against `.status.evaluatedAt[stage]`:

- `false → true`: Operator includes flag-bound resources in rendered manifests
- `true → false`: Operator prunes flag-bound resources from the cluster (after promotion completes)
- No previous entry: treated as `false` (resources are included if flag is `true`)

| Variant | Behavior |
|---|---|
| boolean | On/off per stage |
| percentage | Gradual rollout (integer 0-100) — operator computes deterministic hash of release-ID to assign cohort |
| experiment | A/B variant — operator renders variant A or B based on percentage split |

**Tenant-level targeting** (Phase 4): Each tenant gets their own rendered manifest set. The operator renders templates per tenant cohort, producing N manifest variants for a single promotion. This is a multi-variate promotion — the Release produces one manifest set per tenant group.

## Multi-Language Runtime

- **YAML CRDs** for declarative pipeline definitions — P1
- **TypeScript** (compiled to WASM) for imperative pipeline logic — P3
- **WASM runtime** in-process (wazero/wasmtime) — sandboxed, deterministic, fast
- **Any image as script step** — native binaries (Terraform, Docker, complex CLIs) run directly via the `script` step type with any container image — P1

## Template Adapters

| Type | Behavior | Phase |
|---|---|---|
| helm | Wraps `helm template`, injects flags as `.Values` via `flag_bindings` | P1 |
| kustomize | Wraps `kustomize build`, rewrites `kustomization.yaml` based on flag state | P4 |
| raw | Renders Go templates with flag/param injection | P4 |

## Error Handling

| Condition | Behavior |
|---|---|
| Verification gate failure | Configurable: rollback (revert to previous manifest snapshot), halt (terminal fail — new Release required), or ignore (proceed) |
| Verification `halt` action | Release enters terminal `Failed` phase. No automatic recovery. User must create a new Release |
| Verification timeout | Same as failure, with timeout per gate (default 300s) |
| Flag conflict (two Releases) | Later ring or newer Release wins; losing Release → `Superseded` |
| Pipeline step failure | DAG halts, dependent steps skipped, error recorded in Pipeline CRD status |
| Git/S3/OCI fetch failure | Step retries with exponential backoff (1s, 2s, 4s, max 30s, 5 attempts), then fails |
| Operator crash restart | Reconcile all CRDs, restart in-flight Releases from last checkpoint |
| Network partition | Operator marks unreachable clusters as `Degraded`, halts promotions |
| Concurrent Release to same Stage | Queued — only one Release per Stage can be `Promoting` at a time. Subsequent Releases are `Pending` |
| Resource leak on flag prune | Orphaned resources logged and tagged `paprika.io/owner: <flag-name>`. Operator emits K8s Event |
| Artifact digest mismatch | Release fails with `ArtifactVerificationFailed`. Requires manual reconciliation |
| Template deleted mid-Release | Release fails with `TemplateNotFound`. Manual intervention required |
| Flag deleted mid-promotion [P2] | Release completes without flag evaluation. Flag-dependent resources are left as-is |
| Argo CD token expired mid-poll [P4] | Gate fails with `ArgoCDAuthExpired`. New Secret + new Release required |

## Testing Strategy

| Level | Scope | Method |
|---|---|---|
| **Unit** | Controller logic, flag evaluation, template rendering | Go tests with fake K8s client (`client-go/testing`) |
| **CRD validation** | CRD schema enforcement | `kubectl apply` with invalid CRs against envtest env |
| **Integration** | Operator + CRDs + real K8s (envtest) | envtest suite testing full reconcile loops |
| **E2E** | Full Pipeline → Release → promotion flow | Kind cluster, deploy operator, run CRs, assert status transitions |
| **Migration** | CRD version upgrades | Apply old CRDs, create CRs, upgrade CRDs, verify data integrity |

## Observability

- Release CRD status reflects phase (building, rendering, promoting, verifying, complete, failed, rolled-back, superseded)
- Standard K8s Events on Release, Pipeline, and Flag resources
- Operator metrics: release duration, promotion latency, flag toggle frequency, failure rate by stage
- Flag change audit trail: who, when, which stage, previous value — stored as Flag CRD `.status.evaluatedAt`
- Prometheus metrics endpoint on port 8080 `/metrics`

## Security

- **Source authentication:** Git repos, OCI registries, S3 buckets, and Slack webhooks authenticate via Secrets in the operator namespace. Pipeline CRD references secrets via `spec.sourceAuth[].secretRef.name`. Phase 1 supports `git` auth (SSH key or token), Phase 3 adds S3/OCI auth
- Least-privilege operator with per-Pipeline/Release ServiceAccounts
- WASM sandbox for TS plugins — no host access unless explicitly granted
- Artifact signature/digest verification from OCI/S3 sources
- Promotion gates with optional approval steps
- RBAC on CRDs: developers can create/view Releases but only SRE can approve promotion gates
- Argo CD auth via Secrets (argocd-token) — never in CRD specs

## Implementation Phases

| Phase | Scope | Dependencies |
|---|---|---|
| **1 — Core CI/CD** | Pipeline CRD (git source, script steps) + Workflow Engine (DAG executor) + Stage CRD + Release CRD + Template Renderer (Helm only) + Promotion Controller (no flag support) + Smoke-test and Duration gates + manifest snapshot + rollback | None |
| **2 — Feature Flags** | Flag CRD + Flag Engine + flag bindings in Template Renderer + flag resource lifecycle (create/prune via `.status.evaluatedAt` comparison) + Approval and Conftest gates | Phase 1 |
| **3 — Multi-Source & Plugins** | S3/OCI artifact sources + Plugin CRD + WASM runtime + TypeScript→WASM compilation + ts step type + Metric-check gate | Phase 1 |
| **4 — Multi-Template & Tenants** | Kustomize adapter + Raw YAML adapter + tenant-level targeting (multi-variate) + percentage rollouts + experiment variants + Argo CD rollout-status gate | Phase 2 |

### Migration Between Phases

| Transition | Action |
|---|---|
| P1 → P2 | Apply new Flag CRD. Existing Releases continue without flag evaluation. New Releases can reference flags |
| P2 → P3 | Apply Plugin CRD and WASM runtime. Existing Pipelines continue without plugin steps |
| P3 → P4 | Apply new Template types and Argo CD integration. Existing Stages continue with existing template type |
| CRD version upgrade (`v1alpha1` → `v1`) | Conversion webhook handles bidirectionally. Existing CRs are preserved |
