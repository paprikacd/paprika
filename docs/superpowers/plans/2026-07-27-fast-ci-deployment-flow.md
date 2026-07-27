# Fast CI and Deployment Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver parallel fast validation and promote one validated `linux/amd64` commit image through GHCR to VKE.

**Architecture:** Consolidate push/PR validation and master image publication into one dependency graph. Keep VKE deployment as a downstream workflow that consumes the exact triggering SHA, while nightly Kind e2e provides slower end-to-end coverage.

**Tech Stack:** GitHub Actions, Go contract tests, Docker Buildx, Helm, Kind, Next.js/Vitest

---

## Chunk 1: Workflow Contract and Canonical CI

### Task 1: Add the failing workflow contract

**Files:**
- Create: `internal/cicontract/workflows_test.go`

- [ ] Write tests asserting canonical CI jobs, dependency-gated publication, `master`, `linux/amd64`, exact-SHA VKE deployment, manual-only legacy deployments, and scheduled e2e.
- [ ] Run `go test ./internal/cicontract -v` and verify it fails against the old workflows.
- [ ] Commit the red test.

### Task 2: Consolidate fast CI and publication

**Files:**
- Create: `.github/workflows/ci.yml`
- Delete: `.github/workflows/build-push.yml`
- Delete: `.github/workflows/lint.yml`
- Delete: `.github/workflows/test.yml`
- Delete: `.github/workflows/proto-drift.yml`
- Delete: `.github/workflows/test-chart.yml`

- [ ] Add parallel Go test/race, Go lint, UI test/lint/build, generated-code drift, and Helm lint/template jobs with dependency caches.
- [ ] Add a publish job that needs every validation job, runs only for `push` on `master`, and publishes `latest` plus `sha-${GITHUB_SHA}` for `linux/amd64`.
- [ ] Run the contract test and verify the remaining expected failures concern downstream workflows only.

## Chunk 2: Deployment and Slow-Lane Validation

### Task 3: Make deployment consume the validated SHA

**Files:**
- Modify: `.github/workflows/deploy-vke.yml`
- Modify: `.github/workflows/deploy-gke.yml`
- Modify: `.github/workflows/deploy-cloudrun.yml`
- Modify: `.github/workflows/helm-publish.yml`
- Modify: `.github/workflows/test-e2e.yml`

- [ ] Trigger automatic VKE deployment from successful `CI` runs on `master` and check out `workflow_run.head_sha`.
- [ ] Keep explicit manual image-tag deployment intact.
- [ ] Make legacy GKE/Cloud Run deployment manual-only and change Helm publishing to `master`.
- [ ] Add nightly scheduling to the existing on-demand full e2e workflow.
- [ ] Run the contract test and verify it passes.

### Task 4: Update documentation and verify

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] Document the canonical CI, immutable image tags, downstream VKE promotion, and nightly/on-demand e2e.
- [ ] Run `make test-race`, UI test/lint/build, `helm lint`, `helm template`, and `go test ./internal/cicontract -v`.
- [ ] Inspect the final diff for unrelated changes and commit the implementation.
