# Paprika Reliability, Troubleshooting, and Deployment Speed Design

## Goal

Improve Paprika's ability to keep releases reliable, explain failures quickly, and reduce unnecessary deployment latency without introducing a parallel control plane.

## Tranche 1 Scope

This tranche adds durable, low-risk foundations:

- Release progress watchdog conditions for stuck or slow releases.
- Application preflight conditions before release creation.
- Repo-server/source-render timing and cache evidence.
- Documentation and metrics that make the above visible to operators.

Later tranches can build richer UI affordances, GitHub workflow ingestion, persistent InvestigationRun CRDs, adaptive canary policies, and node pre-pull workflows on top of these foundations.

## Architecture

Paprika should use existing status and event surfaces wherever possible. `Application.status.conditions` and `Release.status.conditions` already flow through the API and UI, so tranche 1 stores diagnostic state there instead of changing CRD schemas. Metrics use the existing OpenTelemetry meter and Prometheus exporter.

The release controller owns release-local progress diagnostics. The application controller owns preflight checks that decide whether it is safe to create a release. Repo-server/render cache instrumentation belongs in the rendering layer and must not affect rendered output.

## Reliability Features

### Release Watchdog

Each non-terminal release gets a `Progressing` condition:

- `False/Stalled` when the current phase has exceeded a phase-specific threshold without a meaningful condition transition.
- `True/WithinBudget` when the phase is still within budget.
- `True/Terminal` when a terminal phase is reached.

The first implementation only records conditions and metrics; it does not auto-fail or rollback. That keeps behaviour safe while making stuck states obvious.

### Application Preflight

Before creating a new release, Paprika evaluates cheap, deterministic checks:

- Target stage exists.
- Required app source fields are present.
- Health check HTTP URLs are syntactically valid.
- Referenced `secretEnv.existingSecret` exists.
- Referenced `imagePullSecrets[*].name` secrets exist.

Failure blocks release creation with `Application.status.conditions[type=ReleasePreflight]` set to `False`. Success sets it to `True`.

## Troubleshooting Features

### Diagnostic Conditions

Conditions should be written as operator-readable evidence. Messages include what was checked and the next useful action, not just an error string.

### Source/Render Evidence

Repo-server and cached renderer metrics record:

- Manifest cache hits and misses.
- Render cache operation errors.
- Source resolve duration and errors.

These metrics are enough to distinguish "cluster rollout slow" from "repo resolution or rendering slow".

## Deployment Speed Features

Tranche 1 improves speed indirectly by exposing cache behaviour and preventing doomed releases earlier. Follow-up tranches should add:

- Git webhook prefetch and exact app invalidation.
- Sparse/partial checkout where supported.
- Per-repo source resolution concurrency limits.
- Adaptive canary timing based on change risk.

## Testing

Unit tests cover:

- Preflight success/failure cases.
- Release watchdog condition transitions.
- Render cache hit/miss metrics path where practical.

Operational validation covers:

- `helm lint charts/chart/ --values deploy/test-values.yaml`
- targeted Go tests for changed packages
- deployment to `paprika-e2e`
- live application health checks

