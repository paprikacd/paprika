# HA Cross-Replica Coordinator

**Date:** 2026-06-22
**Status:** Draft

## Problem

The Paprika operator runs as a single active replica. Leader election ensures only one pod
processes reconciliation work while standby replicas sit idle. This is:

- **Wasteful**: N-1 replicas consume resources but do no work
- **Slow failover**: leader election requires a lease timeout (~15s) before the standby takes over
- **Not scalable**: reconciliation throughput is capped at one replica's capacity

The existing sharding mechanism (StatefulSet + namespace hash via env var) is static — it
requires manual shard count configuration and does not adapt when replicas join or leave.

## Goal

All operator replicas are active. Each replica processes a subset of namespaces determined
by a consistent hash ring, coordinated through Redis. When replicas join or leave,
namespace assignment redistributes automatically with minimal reshuffling.

## Non-Goals

- No changes to individual controllers or their reconciliation logic
- No changes to the event broker, cache, or SSE infrastructure
- No changes to split-plane deployments (API server, webhook receiver remain leader-elected)
- No changes to the notification controller
- No new CRDs or API types
- No changes to external-facing CLI or user workflows

## Architecture

### Package: `internal/coordinator/`

Four files:

| File | Responsibility |
|---|---|
| `coordinator.go` | Redis replica registry join/leave/heartbeat, membership watch |
| `ring.go` | Consistent hash ring (1024 points, 16 virtual nodes per replica) |
| `shard_filter.go` | `ShardFilter` backed by the ring |
| `metrics.go` | Prometheus counters: replica count, rebalance events, assigned namespaces |

### Coordinator

```
┌──────────────────────┐      ┌──────────────────────┐
│    Replica A          │      │    Replica B          │
│  ┌────────────────┐   │      │  ┌────────────────┐   │
│  │ Coordinator    │   │      │  │ Coordinator    │   │
│  │  Join()        │──┼──────┼─>│  SADD replicas  │   │
│  │  Heartbeat()   │──┼──────┼─>│  SETEX heartbeat│   │
│  │  Watch()       │<─┼──────┼──│  SUBSCRIBE      │   │
│  │  Ring.Lookup() │   │      │  │  Ring.Lookup() │   │
│  └────────────────┘   │      │  └────────────────┘   │
│  ┌────────────────┐   │      │  ┌────────────────┐   │
│  │ RingShardFilter│   │      │  │ RingShardFilter│   │
│  │ ShouldReconcile│   │      │  │ ShouldReconcile│   │
│  └────────────────┘   │      │  └────────────────┘   │
└──────────────────────┘      └──────────────────────┘
         │                            │
         └──────────┬─────────────────┘
                    │
         ┌──────────▼──────────┐
         │      Redis          │
         │  paprika:coordinator│
         │   :replicas (SET)   │
         │   :heartbeat:<pod>  │
          └─────────────────────┘
```

### Coordinator API

```go
type Coordinator struct {
    // unexported fields
}

// Join registers this replica in Redis and performs initial ring sync.
func (c *Coordinator) Join(ctx context.Context) error

// Leave deregisters this replica from Redis.
func (c *Coordinator) Leave(ctx context.Context) error

// Healthy returns true if the last heartbeat succeeded.
func (c *Coordinator) Healthy(ctx context.Context) bool

// Ring returns a snapshot of the current hash ring (thread-safe).
func (c *Coordinator) Ring() *Ring

// Events returns a channel that receives ring-change notifications.
// Consumers re-read Ring() when a value arrives.
func (c *Coordinator) Events() <-chan struct{}
```

`syncRing()` is unexported — called by the heartbeat goroutine and on join. It reads
`SMEMBERS`, rebuilds the ring, and notifies `Events()` subscribers. The `RingShardFilter`
polls `Ring()` on each `ShouldReconcile` call via the atomic pointer swap.

### Coordinator Construction

```go
func NewCoordinator(redisClient redis.UniversalClient, podName string, opts ...Option) *Coordinator

type Options struct {
    HeartbeatInterval time.Duration  // default 15s
    HeartbeatTTL      time.Duration  // default 30s
}
```

### Redis Key Schema

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `paprika:coordinator:replicas` | SET | rolling TTL (30s, renewed each heartbeat) | Active replica pod names |
| `paprika:coordinator:heartbeat:<pod>` | STRING | 30s | Liveness heartbeat |
| _(omitted — CAS is unnecessary; each replica reads `SMEMBERS` independently)_ |
| `paprika:coordinator:assigned:<pod>` | SET | 30s | Current namespace assignment (observability) |

### Consistent Hash Ring

```
hash("ns:default")      → position 142  → replica B (range 100-199)
hash("ns:kube-system")  → position 837  → replica C (range 800-899)
```

- 1024-point ring
- 16 virtual nodes per replica (distribution smoothness)
- Hash function: FNV-1a (stdlib `hash/fnv`, zero dependencies)
- Ring rebuild on any membership change (all replicas compute independently)
- Thread-safe via `sync.RWMutex`

### ShardFilter Integration

**Existing interface** (`internal/controller/shard_filter.go`):
```go
type ShardFilter interface {
    ShouldReconcile(ctx context.Context, namespace string) (bool, error)
}
```

**New implementation:**
```go
type RingShardFilter struct {
    mu   sync.RWMutex
    ring *Ring
    self string
}

func (f *RingShardFilter) ShouldReconcile(_ context.Context, namespace string) (bool, error) {
    f.mu.RLock()
    defer f.mu.RUnlock()
    owner, ok := f.ring.Lookup(namespace)
    return ok && owner == f.self, nil
}
```

Controllers pass `ShouldReconcile` in their event predicates — no controller code changes.

## Lifecycle

### Join

1. Pod identity computed from `PAPRIKA_POD_NAME` env var (K8s downward API)
2. `coordinator.Join()`:
   - `SADD paprika:coordinator:replicas <self>`
   - `SET paprika:coordinator:heartbeat:<self> "alive" EX 30`
3. `coordinator.syncRing()`:
   - `SMEMBERS paprika:coordinator:replicas`
   - Build ring from all members
   - Swap the ring pointer on `RingShardFilter` atomically
4. No informer rebuild needed. New predicates immediately reflect the updated assignment as `ShouldReconcile` uses the live ring pointer. Any events "missed" during the transition are naturally covered by controller-runtime's existing reconciliation loop (resync period + periodic re-queues).

### Heartbeat

- Goroutine runs every `heartbeatInterval` (15s default):
  - `SET paprika:coordinator:heartbeat:<self> "alive" EX 30`
  - `EXPIRE paprika:coordinator:replicas 30` (renews the SET's TTL)
  - `SMEMBERS paprika:coordinator:replicas` — detect stale entries
  - If stale entries found → `SREM` + recompute ring

### Rebalance

Triggers:
- Replica join or leave detected during the heartbeat cycle (15s polling)
- Replica heartbeat TTL expires (stale entry detected)

Protocol:
1. Each replica independently detects the change during its next heartbeat poll
2. Random jitter 0-5s to avoid thundering herd
3. `coordinator.syncRing()`:
   - Merge stale detection: `SREM` any entries whose heartbeat TTL has expired
   - Rebuild ring from `SMEMBERS`
   - Compute delta: which namespaces changed owner
4. Swap the ring pointer on `RingShardFilter` (atomic). New predicates immediately reflect the updated assignment.
5. Update `paprika:coordinator:assigned:<self>` SET for observability.

### Graceful Leave

1. SIGTERM triggers `coordinator.Leave()` before controller manager shutdown:
   - `DEL paprika:coordinator:heartbeat:<self>`
   - `SREM paprika:coordinator:replicas <self>`
   - Sleep 2s to let peers observe the departure on next heartbeat poll
2. Then proceed with normal controller manager graceful shutdown (existing SIGTERM handler that cancels the context and waits for reconcilers to finish)

## CLI Flags

Added to `cmd/main.go` `cliConfig`:

| Flag | Env Var | Default | Purpose |
|---|---|---|---|
| `--coordinator-mode` | `PAPRIKA_COORDINATOR_MODE` | `false` | Enable coordinator (instead of leader election) |
| `--coordinator-heartbeat` | `PAPRIKA_COORDINATOR_HEARTBEAT` | `15s` | Heartbeat interval |
| `--coordinator-ttl` | `PAPRIKA_COORDINATOR_TTL` | `30s` | Heartbeat TTL (must be > interval) |

Coordinator flags are silently ignored when `--coordinator-mode` is `false` (they have no effect on leader-election-based operation).

When `--coordinator-mode` is enabled:
- Manager is created with `LeaderElection: false`
- `CoordinatorShardFilter` replaces the env-var `ShardFilter`
- `PAPRIKA_POD_NAME` — defaults to `os.Hostname()` if unset
- `PAPRIKA_REDIS_ADDR` is required if `--coordinator-mode` is true (fail-fast with error message)

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Description |
|---|---|---|---|
| `paprika_coordinator_replicas` | Gauge | — | Number of active replicas in the ring |
| `paprika_coordinator_rebalances_total` | Counter | — | Number of ring rebalance events |
| `paprika_coordinator_assigned_namespaces` | Gauge | — | Namespaces assigned to this replica |
| `paprika_coordinator_heartbeat_seconds` | Histogram | — | Heartbeat round-trip latency |

### Logging

- `log.Info("Joined coordinator ring", "replicas", n)` on startup
- `log.Info("Rebalancing ring - replicas changed", "from", oldN, "to", newN)` on rebalance
- `log.Info("Replica left ring", "pod", name)` on peer departure
- `log.Info("Assigned namespaces changed", "acquired", n, "relinquished", n)` on assignment change
- `log.Error(err, "Coordinator heartbeat failed")` on Redis failures

### Health Checks

- `coordinator.Healthy(ctx) bool` — returns true if last heartbeat succeeded
- Integrated into manager's health probe: returns unhealthy if coordinator hasn't heartbeated in 2× TTL

## Error Handling

| Scenario | Behavior |
|---|---|
| **Redis unavailable at startup** | Coordinator enters degraded mode: all namespaces pass through (no filtering). Operator runs as if unsharded. Logs startup warning. |
| **Redis unavailable mid-operation** | Keeps last known ring. Controllers continue with last assignment. Retry reconnect every 5s. Metrics show 0 replicas. |
| **Stale replica (TTL expired but not cleaned)** | On each heartbeat cycle: `SMEMBERS replicas`, check TTL of each. `SREM` stale entries before computing ring. |
| **Duplicate rebalance (concurrent detection)** | Ring rebuild is idempotent. `SMEMBERS` returns the canonical set. Each replica independently computes the same ring from the same input — no CAS needed. |
| **Partial namespace adoption (rebalance race)** | Both old and new owner may process the same namespace temporarily. Controller reconciliation is already idempotent — safe. |
| **Empty ring (SMEMBERS returns < 1 replica)** | Guard: if ring has < 1 member, `RingShardFilter` falls through to let all namespaces pass. This prevents a total outage during coordinator startup race. |
| **Quick restart (crash < TTL)** | TTL (30s) prevents premature takeover by other replicas. Restarted pod re-registers within heartbeat interval. Grace period avoids churn. |

## Migration Path

### Phase 1 (this PR)

- Add `internal/coordinator/` package
- Add `--coordinator-mode` flag to CLI (opt-in, off by default)
- When coordinator mode enabled + Redis configured:
  - Manager disables leader election
  - `RingShardFilter` replaces env-var shard filter
- Leader election remains default. No existing behavior changes.

### Phase 2 (follow-up PR)

- Helm chart: `coordinator.enabled: false` in values.yaml
- When enabled: removes `--leader-elect`, adds coordinator flags, uses Deployment (not StatefulSet) with `replicas: 3`
- Update `manager.replicas` default from 1 to 3 when coordinator enabled
- Add RBAC for pod name downward API (`metadata.name` in env)

### Phase 3 (future)

- Default coordinator when Redis is configured and `replicas > 1`
- Deprecate static sharding (StatefulSet mode)
- E2E tests for coordinator rebalancing

## Testing

### Unit Tests

- `Ring` test:
  - Empty ring returns empty lookup
  - Single replica owns all namespaces
  - Adding a second replica splits namespaces approximately evenly
  - Removing a replica redistributes its namespaces
  - Adding/removing N replicas reshuffles ~1/N fraction (consistent hashing property)
  - 1000 namespaces → all assigned, no duplicates
- `Coordinator` test:
  - `Join()` registers in Redis
  - `Heartbeat()` refreshes TTL
  - `Leave()` removes from Redis
  - `syncRing()` detects stale entries after TTL expiry
  - Concurrent `syncRing()` from multiple goroutines is safe

### Integration Test

- Uses `testcontainers-go` or embedded Redis (miniredis) for test:
  - 3 coordinator instances connect to same Redis
  - Each computes correct namespace assignment
  - Instance leaves → remaining 2 rebalance
  - Instance crashes (no Leave) → TTL expiry → remaining rebalance

### E2E Test (Phase 3)

- Deploy operator with `coordinator.enabled=true` and `replicas=3`
- Verify all 3 pods are processing work (check controller-runtime metrics)
- Kill 1 pod → verify remaining 2 adopt its namespaces
- Scale up to 4 → verify redistribution

## Open Questions

1. **Should virtual node count be configurable or hardcoded?**
   - Decision: Hardcoded to 16. Can be lifted to a flag if uneven distribution is observed in production.

2. **How should the coordinator integrate with the controller manager's informer start/stop?**
   - Decision: Controllers don't need per-namespace informers — `ShardFilter` is applied in event predicates (existing pattern). When namespace assignment changes, the filter simply starts allowing/blocking events. No informer rebuild needed. The existing reconciliation will pick up any missed events naturally.

## References

- Paprika TODO.md (HA cross-replica coordination as remaining feature)
- Existing sharding: `cmd/main_operator.go` (`PAPRIKA_SHARD_ID`/`PAPRIKA_SHARD_TOTAL`)
- Existing `ShardFilter` interface in `internal/controller/shard_filter.go`
- Existing Redis integration: `internal/cache/redis.go`, `internal/api/events/broker.go`
- controller-runtime leader election: `cmd/main_operator.go:208-225`
