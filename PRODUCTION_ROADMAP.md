# Paprika Production Readiness Roadmap

> **Status (updated 2026-06-20):** The per-section "Current" snapshots below are **pre-refactor
> and stale** — they describe the codebase as a small-scale MVP. In reality, nearly all the P0/P1
> items below are now implemented (label-selector diff engine, Redis source cache, in-process Helm
> SDK, split control plane + sharding, status subresources, multi-cluster connection pooling,
> rate limiting, OIDC/basic/project auth, tracing, HPA + PDBs). The accurate current status and
> the genuinely-remaining gaps live in [TODO.md](TODO.md) ("Production hardening — status" and
> "Genuinely remaining"). This document is retained for historical context; treat its "Current"
> and "Required Fix" blocks as already-addressed unless listed as remaining in TODO.md.

## Current State: MVP → ArgoCD-Scale Production

The codebase has solid foundations but is currently architected for small-scale, single-cluster deployments. To operate at ArgoCD scale (10,000+ applications, 100+ clusters, millions of resources), fundamental architectural changes are required.

## Critical Scaling Bottlenecks (P0)

### 1. O(n) Diff Engine — Highest Priority
**Current:** `engine/diff.go` calls `ServerPreferredResources()` and lists **every namespaced resource** on every Application reconcile.

**Impact:** With 10,000 applications reconciling every 5s, you list the entire cluster repeatedly. This will DDoS the Kubernetes API server.

**Required Fix:**
- Index desired resources by owner reference (Application)
- Track live resources via label selector (`app.paprika.io/name=<app>`)
- Use an informer-based cache instead of List calls
- Only diff resources the Application actually owns

### 2. No Source Cache / Webhook Support
**Current:** Git source re-clones on every template render. S3 re-downloads on every render. No commit cache, no webhook listener.

**Impact:** Every Application reconcile triggers git clone/fetch or S3 HEAD. At scale this saturates bandwidth and source APIs.

**Required Fix:**
- Central `SourceCache` service with Redis backend
- Webhook receiver for GitHub/GitLab/Bitbucket push events
- Background poller with exponential backoff and ETag support
- Cache rendered manifests keyed by commit hash

### 3. Shelling Out to Helm Binary
**Current:** `engine/template.go` executes `helm template`, `helm repo add`, `helm repo update` via `exec.CommandContext`.

**Impact:** Cannot scale — subprocess creation is slow, no chart caching at process level, concurrent helm runs corrupt repo cache.

**Required Fix:**
- Use Helm SDK (`helm.sh/helm/v3/pkg/action`) in-process
- Chart museum/cache with persistent volume or object storage
- Repository index caching with TTL
- Lock chart downloads to prevent race conditions

### 4. Single Monolithic Controller
**Current:** One Deployment with `replicas: 1`, all controllers in one process. API server embedded in operator.

**Impact:** Cannot scale horizontally. Leader election only allows one active replica. API and controller compete for resources.

**Required Fix:**
- Split into separate deployments: `controller-manager`, `api-server`, `repo-server`, `webhook-receiver`
- Implement controller sharding by namespace hash or application ID
- Redis-backed work queue for cross-replica coordination
- HorizontalPodAutoscaler for each component

### 5. Status Subresource Anti-Patterns
**Current:** Controllers update entire objects (not just status), causing unnecessary etcd writes and revision churn.

**Impact:** etcd write amplification, watch storm cascades, conflicts between controllers.

**Required Fix:**
- Use `client.MergeFrom` + `r.Status().Update()` exclusively for status changes
- Add `ObservedGeneration` to all status types
- Separate spec and status update paths

## High-Priority Production Gaps (P1)

### 6. No Multi-Cluster Connection Pooling
**Current:** `ClusterClientManager` creates new dynamic client per reconcile from kubeconfig secret.

**Impact:** Constant TLS handshakes, no connection reuse, slow reconciliation across many clusters.

**Required Fix:**
- Cluster registry CRD with connection pool management
- Cache clients by kubeconfig secret hash
- Connection health checks and circuit breakers
- Separate cluster-agent DaemonSet for remote clusters

### 7. Missing Caching Layer
**Current:** Every API call hits Kubernetes API server directly. No Redis, no local cache.

**Impact:** API server becomes bottleneck, UI is slow, controllers redundant work.

**Required Fix:**
- Redis deployment for:
  - Source state cache
  - Rendered manifest cache
  - Cluster resource cache snapshot
  - Event bus for inter-controller communication
  - Rate limiting counters

### 8. No Rate Limiting or Backoff
**Current:** Fixed `MaxConcurrentReconciles`, no per-resource rate limiting, no global throttling.

**Impact:** Thundering herd on source APIs, retry loops spike API server.

**Required Fix:**
- Per-Application rate limiter (token bucket)
- Per-source rate limiter (git host, S3 bucket)
- Global controller rate limiter
- Exponential backoff with jitter for failures

### 9. Security Model Gaps
**Current:**
- No authentication/authorization in API server
- Operator has broad cluster-admin RBAC
- S3 hardcodes test credentials
- No audit logging
- TLS config uses `InsecureSkipVerify` in analysis

**Required Fix:**
- OIDC/JWT auth for API server
- RBAC policy engine (Casbin or OPA)
- Project-scoped permissions
- Audit logging to stdout/file
- Secret rotation for kubeconfig and git credentials
- mTLS for inter-service communication

### 10. No Observability Beyond Metrics
**Current:** Prometheus metrics exist but no tracing, no structured events, no SLO dashboards.

**Required Fix:**
- OpenTelemetry tracing across controllers and API
- Kubernetes Events for every significant state change
- Structured logging with correlation IDs
- Pre-built Grafana dashboards
- AlertManager rules for failed syncs, unhealthy apps, queue depth

## Medium-Priority Gaps (P2)

### 11. No Resource Management
**Current:** `manager.yaml` has `limits.cpu: 500m`, `limits.memory: 128Mi` — insufficient for any real workload.

**Required Fix:**
- Right-size based on load testing
- Add VerticalPodAutoscaler recommendations
- Separate resource profiles for controller vs API server
- PodDisruptionBudgets for HA

### 12. No Disaster Recovery
**Current:** All state lives in etcd via CRDs. No backup/restore strategy.

**Required Fix:**
- Backup CRDs to object storage (Velero integration)
- GitOps backup of Application specs
- Multi-region deployment guide

### 13. UI is Static HTML Only
**Current:** `uistatic/index.html` is a 15-byte placeholder.

**Required Fix:**
- Full React/Vue SPA with real-time updates via WebSocket/SSE
- Application topology visualization
- Diff viewer for manifest changes
- Audit log viewer

### 14. No Multi-Tenancy
**Current:** Any authenticated user can see/modify all Applications.

**Required Fix:**
- Project/namespace isolation
- Resource quotas per project
- SSO integration

## Recommended Implementation Order

### Phase 1: Core Scaling (Weeks 1-3)
1. ✅ **Fix diff engine** — label-selector based, stop scanning all resources
2. ✅ **Add Redis** — source cache + rendered manifest cache
3. **Helm SDK migration** — replace shell execs
4. **Connection pooling** — for multi-cluster clients

### Phase 2: Architecture Split (Weeks 4-6)
5. **Split operator and API server** into separate deployments
6. **Add controller sharding** by namespace hash
7. **Webhook receiver** for Git push events
8. **Rate limiting and backoff**

### Phase 3: Production Hardening (Weeks 7-10)
9. **Authn/authz** for API server
10. **Audit logging and tracing**
11. **Security hardening** — RBAC scopes, secret rotation
12. **Resource tuning** — VPA, HPA, PDBs
13. **Real UI**

### Phase 4: Enterprise Features (Weeks 11-14)
14. **Multi-tenancy**
15. **Backup/restore**
16. **Advanced sync policies** — prune, replace, sync windows
17. **Notifications** — Slack, email, webhook

## Immediate Next Steps

The highest-impact, lowest-risk wins are:

1. **Fix the diff engine** — pure code change, huge scaling impact
2. **Add a Redis-backed manifest cache** — architectural but contained
3. **Implement controller/API split** — structural but uses existing code
4. **Add source webhook support** — prevents polling overhead

Which would you like to tackle first?
