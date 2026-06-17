# Paprika Feature TODO

This file tracks implemented capabilities and planned features. It consolidates the [unified platform roadmap](docs/superpowers/plans/2026-06-09-unified-platform-roadmap.md), [production roadmap](PRODUCTION_ROADMAP.md), and pending P2 work.

## Implemented

- [x] Pipeline CRD (DAG workflow execution)
- [x] Template CRD (Helm rendering)
- [x] Stage CRD (canary / blue-green progression)
- [x] Release CRD (promotion to stages)
- [x] Application CRD (unified resource owning Pipeline/Template/Stage/Release)
- [x] Multi-source rendering (git, S3, Helm, OCI)
- [x] CEL health checks with HTTP probes
- [x] Resource diff detection (`Application` status resources / outOfSync)
- [x] Resource pruning
- [x] Resource health tracking
- [x] Prometheus metrics
- [x] API / UI dashboard
- [x] Event-driven sync (`paprika.io/sync`, `paprika.io/refresh`)
- [x] Advanced rollout strategies (A/B testing, blue-green, canary, mirroring, header-based routing)
- [x] Analysis Templates and AnalysisRuns
- [x] Notifications (Slack, email, webhook, delivery status)
- [x] OCI source support
- [x] Sync windows (cron-based)
- [x] Self-healing (auto-sync on drift, auto-revert on health failure)
- [x] Feature flags (`FeatureFlag` / `FeatureFlagBinding` CRDs + OpenFeature bridge)

## P2 — Planned Next

These are the next user-facing features queued after the current MVP.

- [ ] **Approval Gates** — manual/webhook/Slack gates between stages; pause promotion until approved
  - Priority: high
  - Status: no detailed plan yet
  - Owner: TBD

- [ ] **Conftest Gates** — Open Policy Agent / Conftest policy checks in the promotion pipeline
  - Priority: medium
  - Status: no detailed plan yet
  - Owner: TBD

- [ ] **Project-Scoped Policy Governance** — enforce `AppProject` boundaries and `Policy` rules in webhooks, controllers, and API; scope authorization by project
  - Priority: high
  - Plan: [docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md](docs/superpowers/plans/2026-06-13-project-scoped-policy-governance.md)
  - Spec: [docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md](docs/superpowers/specs/2026-06-13-project-scoped-policy-governance-design.md)
  - Owner: TBD

- [ ] **`paprika apply -f` CLI** — render manifests locally and submit via `ApplyBundle`; `Policy` CRD; Bubble Tea TUI
  - Priority: high
  - Plan: [docs/superpowers/plans/2026-06-13-paprika-apply.md](docs/superpowers/plans/2026-06-13-paprika-apply.md)
  - Spec: [docs/superpowers/specs/2026-06-13-paprika-apply-design.md](docs/superpowers/specs/2026-06-13-paprika-apply-design.md)
  - Owner: TBD

## Mid-Term

- [ ] **Multi-Cluster Deployment** — deploy to target clusters via `Stage.clusterRef`
- [ ] **App-of-Apps / ApplicationSet** — parent Application or ApplicationSet managing child Applications
- [ ] **HA / Sharded Repo Server** — horizontally scalable source/render service

## Production Hardening (P0/P1)

See [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md) for full details.

- [ ] Informer-based diff engine (avoid `ServerPreferredResources()` on every reconcile)
- [ ] Source cache with Redis + webhook receiver + background poller
- [ ] Helm SDK in-process rendering (replace `helm template` subprocess)
- [ ] Split monolithic controller (`controller-manager`, `api-server`, `repo-server`, `webhook-receiver`)
- [ ] Status-subresource-only updates
- [ ] Multi-cluster connection pooling
- [ ] Redis-backed API / manifest cache
- [ ] Per-Application and per-source rate limiting
- [ ] Security model hardening

## How to Pick Up Work

1. Choose a feature from **P2 — Planned Next**.
2. If a plan exists, follow it and use `superpowers:subagent-driven-development`.
3. If no plan exists, write one first using `superpowers:writing-plans`.
4. Create a feature branch / worktree, implement, and run `make test` + `make lint` before merging.
