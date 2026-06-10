# Paprika Unified Platform Roadmap

## Goal
Collapse ArgoCD + Argo Rollouts + Argo Workflows into a single unified platform: Paprika.

## Current State (✅ Done)
- Pipeline CRD (DAG workflow execution)
- Template CRD (Helm rendering)
- Stage CRD (canary/blue-green progression)
- Release CRD (promotion to stages)
- Application CRD (unified resource, owns all of the above)
- Multi-source rendering (git, s3, helm)
- CEL health checks with HTTP probes
- Prometheus metrics
- API/UI dashboard
- Feature flags via parameters

## Critical Gaps (Priority 1)

### 1. Diff Detection (ArgoCD parity)
**What it is:** Compare current cluster state with desired rendered manifest. Show what's synced, out of sync, or missing.

**Why it matters:** This is the core value of ArgoCD. Without it, you have no visibility into drift.

**Implementation:**
- `DiffEngine` package that computes the difference between the rendered manifest and the actual cluster state
- Store diff results in ApplicationStatus (as a `ResourceSync` list)
- API endpoint: `GetDiff` or `GetApplication` with resource details
- UI: show diff indicators on each resource

**Files to create:**
- `engine/diff.go` - diff engine
- `internal/controller/diff.go` - controller integration
- Proto message: `ResourceDiff`
- UI: diff display component

### 2. Resource Pruning
**What it is:** Delete resources that are no longer in the rendered manifest but exist in the cluster.

**Why it matters:** Without pruning, old resources accumulate. This is a core ArgoCD feature.

**Implementation:**
- After `applyManifests`, collect all resources in the rendered manifest
- Compare with existing resources managed by the Application
- Delete orphaned resources that have the same owner labels but are not in the manifest
- Store `prunedResources` in ApplicationStatus

**Files to modify:**
- `internal/controller/release_controller.go` - `applyManifests` + `pruneResources`
- Application controller - `pruneOwnedResources` method

### 3. Resource Health Tracking
**What it is:** Track the health status of each deployed resource (Deployment replicas, Service endpoints, Ingress status, etc.)

**Why it matters:** ArgoCD shows per-resource health. This is essential for understanding why an Application is degraded.

**Implementation:**
- `ResourceHealth` struct in ApplicationStatus
- `HealthChecker` interface for each K8s resource type
- `DeploymentHealthChecker` (replicas vs desired, pod health)
- `ServiceHealthChecker` (endpoints, port health)
- `IngressHealthChecker` (backend, TLS)
- `ConfigMapHealthChecker` (always healthy)
- Store health in `.status.resources` as a list

**Files to create:**
- `health/resources.go` - resource health checkers
- `health/deployment.go` - deployment health
- `health/service.go` - service health
- `health/ingress.go` - ingress health

### 4. Multi-Cluster Deployment
**What it is:** Deploy to different clusters based on Stage.ClusterRef.

**Why it matters:** The Stage CRD already has a `Cluster` field but we don't use it. This is critical for separating staging and prod environments.

**Implementation:**
- `ClusterRef` in Application CRD (kubeconfig, serviceAccount, endpoint)
- `ClusterClient` cache that creates clients for each cluster
- Modify `release_controller.go` to use the target cluster's client for deployment
- Modify `Application` controller to pass cluster client
- UI: show cluster per stage

**Files to modify:**
- `api/v1alpha1/stage_types.go` - extend ClusterRef
- `api/v1alpha1/application_types.go` - add clusterRefs
- `internal/controller/release_controller.go` - multi-cluster apply
- `internal/controller/cluster.go` - cluster client manager

### 5. Approval Gates
**What it is:** Manual approval gates between stages (e.g., prod requires manual approval before deployment).

**Why it matters:** Critical for production workflows. You don't want prod to auto-promote without approval.

**Implementation:**
- `Gate` struct in Application CRD (manual, webhook, slack)
- `GateStatus` in ApplicationStatus
- `Approve` RPC for API (manual approval)
- Controller: when encountering a gate, pause promotion and wait for approval
- UI: show gate status, approve button
- Annotation: `paprika.io/approved` or API call

**Files to modify:**
- `api/v1alpha1/application_types.go` - add Gate
- `internal/controller/application_controller.go` - gate logic
- `internal/api/server.go` - `ApproveGate` RPC
- `ui/src/app/page.tsx` - gate approval UI

### 6. App-of-Apps / ApplicationSet
**What it is:** Parent Application that manages child Applications (e.g., one git repo with multiple app folders).

**Why it matters:** Essential for managing multiple applications at scale.

**Implementation:**
- `ApplicationSet` CRD (generates multiple Applications from a list or git repo)
- `ApplicationSet` controller that creates child Applications
- Template support for ApplicationSets
- UI: show ApplicationSet and child Applications

**Files to create:**
- `api/v1alpha1/applicationset_types.go` - CRD
- `internal/controller/applicationset_controller.go` - controller
- Proto: `ApplicationSet` message
- UI: `ApplicationSetCard` component

## Important Gaps (Priority 2)

### 7. Event-Driven Sync
- GitHub/GitLab webhooks trigger sync on push
- Webhook controller that receives webhooks
- Annotation: `paprika.io/sync` or `paprika.io/refresh`

### 8. Advanced Rollout Strategies
- A/B testing (traffic splitting by header, cookie)
- Blue-green with preview service
- Traffic mirroring
- Header-based routing

### 9. Analysis Templates
- Reusable analysis templates (YAML, stored in config)
- Template references in Application CRD
- Background analysis (continuous health checks)

### 10. Notifications
- Slack/email alerts on sync failure, rollback
- Webhook notifications
- Event streaming

### 11. OCI Support
- Helm charts from OCI registries (e.g., ECR, GCR, Docker Hub)
- `oci://` source type
- Authentication with registry credentials

### 12. Self-Healing
- Auto-sync on drift detection
- Auto-revert when health checks fail

### 13. Sync Windows
- Maintenance windows (e.g., only sync during business hours)
- Cron-based sync scheduling

## Implementation Plan

### Phase 1: Diff Detection + Resource Pruning (Week 1)
- `engine/diff.go` - Diff engine
- `internal/controller/release_controller.go` - apply + prune
- `api/v1alpha1/application_types.go` - `ResourceSync` status
- `ui/` - Diff display

### Phase 2: Resource Health Tracking (Week 1)
- `health/resources.go` - Resource health checkers
- `internal/controller/application_controller.go` - health tracking
- `api/v1alpha1/application_types.go` - `ResourceHealth` status
- `ui/` - Resource health display

### Phase 3: Multi-Cluster Deployment (Week 2)
- `internal/controller/cluster.go` - Cluster client manager
- `internal/controller/release_controller.go` - multi-cluster apply
- `api/v1alpha1/stage_types.go` - ClusterRef
- `ui/` - Cluster per stage

### Phase 4: Approval Gates (Week 2)
- `api/v1alpha1/application_types.go` - Gate
- `internal/controller/application_controller.go` - gate logic
- `internal/api/server.go` - `ApproveGate` RPC
- `ui/` - Gate approval

### Phase 5: App-of-Apps (Week 3)
- `api/v1alpha1/applicationset_types.go` - CRD
- `internal/controller/applicationset_controller.go` - controller
- `ui/` - ApplicationSet display

### Phase 6: Advanced Features (Week 3+)
- Event-driven sync
- Advanced rollout
- Analysis templates
- Notifications
- OCI support
- Self-healing

## Success Criteria

For each phase:
- All new features have e2e tests
- UI displays relevant status
- Documentation updated
- All tests pass

## Next Steps

Start with **Phase 1: Diff Detection + Resource Pruning** — these are the most foundational ArgoCD features and provide immediate value.