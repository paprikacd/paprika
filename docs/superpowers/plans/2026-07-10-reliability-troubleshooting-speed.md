# Reliability Troubleshooting Speed Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-tranche reliability, troubleshooting, and deployment speed foundations using existing Paprika condition and metric surfaces.

**Architecture:** The application controller blocks unsafe release creation via `ReleasePreflight` conditions. The release controller records `Progressing` watchdog conditions for non-terminal releases. The render/cache layer emits OTel metrics for cache hit/miss and source/render latency.

**Tech Stack:** Go, controller-runtime, Kubernetes status conditions, OpenTelemetry metrics, Helm.

---

## Chunk 1: Controller Diagnostics

### Task 1: Application release preflight

**Files:**
- Create: `internal/controller/pipelines/preflight.go`
- Create: `internal/controller/pipelines/preflight_test.go`
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] Add a `runReleasePreflight(ctx, app, targetStage)` helper.
- [ ] Validate stage, source, health check URLs, `secretEnv.existingSecret`, and `imagePullSecrets[*].name`.
- [ ] Set `ReleasePreflight=True` on success and `ReleasePreflight=False` on failure.
- [ ] Block release creation when preflight fails.
- [ ] Add unit tests for success, invalid URL, missing secret, and missing image pull secret.

### Task 2: Release progress watchdog

**Files:**
- Create: `internal/controller/pipelines/release_watchdog.go`
- Create: `internal/controller/pipelines/release_watchdog_test.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/metrics/otel.go`

- [ ] Add phase-specific budgets.
- [ ] Calculate current phase age from conditions and transition timestamps.
- [ ] Set `Progressing=True/WithinBudget`, `Progressing=False/Stalled`, or `Progressing=True/Terminal`.
- [ ] Record `paprika.release.watchdog.stalled` counter when a release crosses budget.
- [ ] Requeue stalled releases periodically without changing release phase.

## Chunk 2: Render And Source Timing

### Task 3: Cache and source metrics

**Files:**
- Modify: `internal/metrics/otel.go`
- Modify: `internal/engine/cached_renderer.go`
- Modify: `internal/engine/repo_server_renderer.go`

- [ ] Add OTel counters for manifest cache hits, misses, and errors.
- [ ] Add OTel histogram for source resolve duration.
- [ ] Instrument cached renderer hit/miss/error paths.
- [ ] Instrument repo-server source resolution fallback duration.

## Chunk 3: Validation

### Task 4: Test and deploy

**Files:**
- Verify changed files only.

- [ ] Run targeted Go tests for changed packages.
- [ ] Run `helm lint charts/chart/ --values deploy/test-values.yaml`.
- [ ] Commit and push.
- [ ] Deploy to `paprika-e2e`.
- [ ] Verify non-search apps are Healthy/Synced.

