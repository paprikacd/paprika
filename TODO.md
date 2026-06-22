# Paprika Feature TODO

This file tracks implemented capabilities and remaining work. It was reconciled against the
actual codebase on 2026-06-20 — most items previously listed as "planned" are now implemented.

## Implemented

### Core platform
- [x] Pipeline CRD (DAG workflow execution)
- [x] Template CRD (Helm rendering, in-process Helm SDK)
- [x] Stage CRD (canary / blue-green progression)
- [x] Release CRD (promotion to stages)
- [x] Application CRD (unified owner of Pipeline/Template/Stage/Release)
- [x] Multi-source rendering (git, S3, Helm, OCI, inline)
- [x] App-of-Apps / ApplicationSet
- [x] Multi-cluster deployment via `Stage.Spec.Cluster` (cluster pool + agent apply path)

### Sync, health, governance
- [x] CEL health checks with HTTP probes
- [x] Resource diff detection (`Application.Status.Resources` / `OutOfSync`)
- [x] Resource pruning; resource health tracking
- [x] Event-driven sync (`paprika.io/sync`, `paprika.io/refresh`)
- [x] Self-healing (auto-sync on drift, auto-revert on health failure)
- [x] Sync windows (cron-based)
- [x] Project-Scoped Policy Governance — enforce `AppProject` boundaries and `Policy` rules in webhooks, controllers, API; project-scoped authorization (OIDC + basic + project authorizer)

### Rollouts & analysis
- [x] Advanced rollout strategies (A/B, blue-green, canary, mirroring, header-based routing)
- [x] Analysis Templates and AnalysisRuns
- [x] Feature flags (`FeatureFlag` / `FeatureFlagBinding` CRDs + OpenFeature bridge)

### Gates (promotion controls)
- [x] **Approval Gates** — manual / webhook / Slack gates between stages; `AwaitingApproval` phase; CLI + UI (PR #17)
- [x] **Conftest / OPA Gates** — user-authored Rego evaluated against rendered manifests before promotion; in-process OPA, fail-closed, retryable (PR #16 — rebased & merge-ready)

### CLI / API / UI / ops
- [x] `paprika apply -f` CLI — render locally, submit via `ApplyBundle`; app-name derivation, idempotent re-apply, supersede previous release
- [x] API + Next.js UI dashboard
- [x] Notifications (Slack, email, webhook, delivery status)
- [x] OCI source support
- [x] Prometheus metrics; Grafana dashboard; PrometheusRules; OpenTelemetry tracing wired into controllers

## Production hardening — status

See [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md) for the original detail (its per-section
"Current" snapshots are pre-refactor and stale). Current status:

**Done**
- [x] Label-selector / informer-based diff engine (no `ServerPreferredResources()` scan)
- [x] Source cache (Redis) + webhook receiver + background poller
- [x] Helm SDK in-process (no `helm template` subprocess)
- [x] Split control plane: `controller-manager`, `api-server`, `repo-server`, `webhook-receiver` (`deploymentMode: split`) with sharding (`internal/sharding`) + split-plane e2e
- [x] Status-subresource updates; `ObservedGeneration` on statuses
- [x] Multi-cluster connection pooling (`ClusterConnectionPool`, context-cancelable)
- [x] Redis-backed manifest cache; per-Application / per-source rate limiting
- [x] HPA + PodDisruptionBudgets per split-plane component

## Genuinely remaining (the real backlog)

All items from the original roadmap have been implemented.

- [x] **HA cross-replica coordination** — Redis-backed replica registry, consistent hash ring, heartbeat with jitter, `ShardFilter` for per-replica resource ownership. Merged to master.

- [x] **API/UI: incremental dashboard updates** — SSE event type parsing, targeted RPC refetch instead of full 5-RPC reload. Merged to master.

## How to Pick Up Work

1. Pick an item from **Genuinely remaining** (the lists above are accurate as of 2026-06-20).
2. If a plan exists, follow it with `superpowers:subagent-driven-development`; otherwise write one with `superpowers:writing-plans`.
3. Work in a feature branch / worktree; run `make manifests generate`, `make lint`, and `make test` before merging (note: `make test` needs the proto plugins — see CI hygiene above).
4. E2E validation runs via the on-demand `E2E Tests` workflow (`gh workflow run test-e2e.yml --ref <branch> -f ginkgo_focus=<focus>`), not on every push.
