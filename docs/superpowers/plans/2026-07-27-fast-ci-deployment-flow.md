# Fast CI and Deployment Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver parallel fast validation and promote the exact validated `linux/amd64` image
digest through GHCR to VKE.

**Architecture:** Consolidate pull-request and `master` push validation, `master` image publication,
and the trusted reusable VKE call into one dependency graph. Publish mutable tags for discovery,
but promote the build output digest. Keep manual deployments digest-only and run slower Kind e2e
nightly or on demand.

**Tech Stack:** GitHub Actions, Go contract tests, Docker Buildx, Helm, Kind, Next.js/Vitest

---

## Chunk 1: Workflow Contract and Canonical CI

### Task 1: Add the failing workflow contract

**Files:**
- Create: `internal/cicontract/workflows_test.go`

- [x] Write tests asserting canonical CI jobs, failure propagation, `master`, `linux/amd64`,
  digest-based VKE deployment, manual-only legacy deployments, and scheduled e2e.
- [x] Run `go test ./internal/cicontract -v` and verify it fails against the old workflows.
- [x] Commit the red test.

### Task 2: Consolidate fast CI and publication

**Files:**
- Create: `.github/workflows/ci.yml`
- Delete: `.github/workflows/build-push.yml`
- Delete: `.github/workflows/lint.yml`
- Delete: `.github/workflows/test.yml`
- Delete: `.github/workflows/proto-drift.yml`
- Delete: `.github/workflows/test-chart.yml`

- [x] Add parallel Go test/race, Go lint, UI test/lint/build, generated-code drift, and Helm
  lint/template jobs with dependency caches.
- [x] Add a publish job that needs every validation job, runs only for `push` on `master`, builds
  `linux/amd64`, publishes `latest` plus `sha-${GITHUB_SHA}` for discovery, and exposes its digest.
- [x] Run the contract test and verify the remaining expected failures concern downstream workflows
  only.

## Chunk 2: Deployment and Slow-Lane Validation

### Task 3: Make deployment consume the validated digest

**Files:**
- Modify: `.github/workflows/deploy-vke.yml`
- Modify: `.github/workflows/deploy-gke.yml`
- Modify: `.github/workflows/deploy-cloudrun.yml`
- Modify: `.github/workflows/helm-publish.yml`
- Modify: `.github/workflows/test-e2e.yml`

- [x] Expose the publish digest and invoke VKE as a trusted local reusable workflow after successful
  publication; retain `github.sha` as the source checkout and remove the separate privileged
  `workflow_run` path.
- [x] Require the exact manual input format
  `ghcr.io/paprikacd/paprika@sha256:<64 lowercase hex>` for VKE, GKE, and Cloud Run.
- [x] Make GKE and Cloud Run manual-only and change Helm publishing to `master`.
- [x] Add nightly scheduling to the existing on-demand full e2e workflow.
- [x] Pin relevant actions and the Kind binary checksum, add bounded job timeouts and permissions,
  and extend the contract tests for these invariants.
- [x] Run the contract test and verify it passes.

### Task 4: Update documentation and verify

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-27-fast-ci-deployment-flow-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-fast-ci-deployment-flow.md`

- [x] Document canonical CI, discovery tags, immutable digest promotion, strict manual inputs, and
  nightly/on-demand e2e.
- [x] Run focused final verification: UI test/lint/build, `helm lint`, `helm template`, workflow
  contract, and Markdown/stale-claim checks.
- [x] Inspect the final diff for unrelated changes and commit the documentation.

## Completion Record

The implementation landed incrementally through `cfe6fd7` (`ci: deploy only trusted image
digests`). The final focused verification passed: 34 workflow contract tests, 19 UI test files / 85
tests, UI lint with no errors (three existing warnings), UI production build, Helm lint (one chart,
zero failures), Helm template rendering, and documentation diff/stale-claim checks.

```sh
(cd ui && npm test && npm run lint && npm run build)
helm lint charts/chart/
helm template paprika charts/chart/
go test ./internal/cicontract -v
git diff --check
```

`make test-race` remains the full Go regression command used by CI; it was not required to complete
the documentation-only final pass.

No live VKE, GKE, or Cloud Run deployment was performed as part of this implementation. The first
merged `master` run still needs operational observation of package publication, OIDC exchange,
digest promotion, rollout, and post-deploy health checks.
