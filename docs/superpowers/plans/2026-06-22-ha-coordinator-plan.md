# HA Cross-Replica Coordinator Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis-coordinated consistent hash ring so all operator replicas are active, each processing a subset of namespaces.

**Architecture:** New `internal/coordinator/` package with `Ring` (consistent hashing), `Coordinator` (Redis replica registry + heartbeat), and `RingShardFilter` (`ShardFilter` implementation). CLI flags opt-in via `--coordinator-mode`.

**Tech Stack:** Go, Redis (`go-redis` v9), `hash/fnv` (stdlib), controller-runtime shard filter interface.

**Spec:** `docs/superpowers/specs/2026-06-22-ha-coordinator-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `internal/coordinator/ring.go` | Consistent hash ring: `Lookup(namespace) -> owner`, thread-safe rebuild |
| `internal/coordinator/ring_test.go` | Unit tests for ring distribution and membership changes |
| `internal/coordinator/coordinator.go` | Redis replica registry: `Join`, `Leave`, `Healthy`, heartbeat goroutine, ring sync |
| `internal/coordinator/shard_filter.go` | `RingShardFilter` implementing `ShardFilter` backed by the ring |
| `internal/coordinator/metrics.go` | Prometheus metrics: replica count, rebalance events, assigned namespaces, heartbeat latency |
| `internal/coordinator/coordinator_integration_test.go` | Integration test with test Redis |

### Modified Files
| File | Change |
|---|---|
| `cmd/main.go` | Add `--coordinator-mode`, `--coordinator-heartbeat`, `--coordinator-ttl` CLI flags |
| `cmd/main_operator.go` | Conditional `RingShardFilter` creation when `--coordinator-mode` is true |

---

## Chunk 1: Ring

**Files:**
- Create: `internal/coordinator/ring.go`
- Create: `internal/coordinator/ring_test.go`

### Ring Design

```go
package coordinator

// Ring is a consistent hash ring with virtual nodes.
// Thread-safe via sync.RWMutex.
type Ring struct {
    mu       sync.RWMutex
    nodes    []ringNode          // sorted by position
    members  map[string]bool     // set of current member IDs
    replicas int                 // virtual nodes per member (16)
}

type ringNode struct {
    position uint32
    member   string
}

// NewRing creates a ring with the given members and virtual node count.
func NewRing(members []string, replicas int) *Ring

// Lookup returns the member responsible for the given key.
// Returns ("", false) if the ring is empty.
func (r *Ring) Lookup(key string) (member string, ok bool)

// Members returns the current set of members.
func (r *Ring) Members() []string

// Len returns the number of members.
func (r *Ring) Len() int

// Rebuild replaces all members and recomputes the ring.
func (r *Ring) Rebuild(members []string)
```

FNV-1a hashing (stdlib `hash/fnv`):

```go
func hashKey(key string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(key))
    return h.Sum32()
}

func hashMember(member string, replicaIdx int) uint32 {
    return hashKey(fmt.Sprintf("%s:%d", member, replicaIdx))
}
```

### Test Cases

1. **Empty ring**: `Lookup` returns `("", false)` for any key
2. **Single member**: all keys map to that member
3. **Two members**: keys split approximately evenly across both (test with 1000 keys, each member gets ≥400)
4. **Member removal**: relinquished member's keys are redistributed to remaining members
5. **Member addition**: ~1/N fraction of keys move to the new member
6. **Stability**: same input always produces same output
7. **Completeness**: 1000 keys all map to a member (no orphans)
8. **Thread safety**: concurrent reads (`Lookup`) with a write (`Rebuild`) — use `go test -race`

- [ ] **Step 1.1: Write ring.go**

```go
package coordinator

import (
    "fmt"
    "hash/fnv"
    "sort"
    "sync"
)

type ringNode struct {
    position uint32
    member   string
}

type Ring struct {
    mu       sync.RWMutex
    nodes    []ringNode
    members  map[string]bool
    replicas int
}

func NewRing(members []string, replicas int) *Ring {
    r := &Ring{
        members:  make(map[string]bool),
        replicas: replicas,
    }
    r.Rebuild(members)
    return r
}

func (r *Ring) Lookup(key string) (string, bool) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    if len(r.nodes) == 0 {
        return "", false
    }
    h := hashKey(key)
    idx := sort.Search(len(r.nodes), func(i int) bool {
        return r.nodes[i].position >= h
    })
    if idx == len(r.nodes) {
        idx = 0
    }
    return r.nodes[idx].member, true
}

func (r *Ring) Members() []string {
    r.mu.RLock()
    defer r.mu.RUnlock()
    m := make([]string, 0, len(r.members))
    for k := range r.members {
        m = append(m, k)
    }
    return m
}

func (r *Ring) Len() int {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return len(r.members)
}

func (r *Ring) Rebuild(members []string) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.members = make(map[string]bool, len(members))
    r.nodes = make([]ringNode, 0, len(members)*r.replicas)
    for _, m := range members {
        r.members[m] = true
        for i := 0; i < r.replicas; i++ {
            pos := hashMember(m, i)
            r.nodes = append(r.nodes, ringNode{position: pos, member: m})
        }
    }
    sort.Slice(r.nodes, func(i, j int) bool {
        return r.nodes[i].position < r.nodes[j].position
    })
}

func hashKey(key string) uint32 {
    h := fnv.New32a()
    h.Write([]byte(key))
    return h.Sum32()
}

func hashMember(member string, idx int) uint32 {
    return hashKey(fmt.Sprintf("%s:%d", member, idx))
}
```

- [ ] **Step 1.2: Write ring_test.go**

```go
package coordinator

import (
    "testing"
)

func TestEmptyRing(t *testing.T) {
    r := NewRing(nil, 16)
    _, ok := r.Lookup("any")
    if ok {
        t.Error("expected false for empty ring")
    }
}

func TestSingleMember(t *testing.T) {
    r := NewRing([]string{"a"}, 16)
    for _, ns := range []string{"default", "kube-system", "production", "staging"} {
        owner, ok := r.Lookup(ns)
        if !ok || owner != "a" {
            t.Errorf("expected 'a', got %q (ok=%v)", owner, ok)
        }
    }
}

func TestTwoMembers(t *testing.T) {
    r := NewRing([]string{"a", "b"}, 16)
    counts := map[string]int{"a": 0, "b": 0}
    for i := 0; i < 1000; i++ {
        owner, ok := r.Lookup(fmt.Sprintf("ns-%d", i))
        if !ok {
            t.Fatal("unexpected empty lookup")
        }
        counts[owner]++
    }
    if counts["a"] < 400 || counts["b"] < 400 {
        t.Errorf("distribution too skewed: a=%d, b=%d", counts["a"], counts["b"])
    }
}

func TestMemberRemoval(t *testing.T) {
    r := NewRing([]string{"a", "b", "c"}, 16)
    assignments := make(map[string]string)
    for i := 0; i < 1000; i++ {
        ns := fmt.Sprintf("ns-%d", i)
        owner, _ := r.Lookup(ns)
        assignments[ns] = owner
    }
    r.Rebuild([]string{"a", "b"})
    moved := 0
    for ns, oldOwner := range assignments {
        newOwner, _ := r.Lookup(ns)
        if newOwner != oldOwner {
            moved++
        }
    }
    // ~1/3 of keys should move
    if moved < 200 || moved > 500 {
        t.Errorf("expected ~333 keys to move, got %d", moved)
    }
}

func TestMemberAddition(t *testing.T) {
    r := NewRing([]string{"a", "b"}, 16)
    assignments := make(map[string]string)
    for i := 0; i < 1000; i++ {
        ns := fmt.Sprintf("ns-%d", i)
        owner, _ := r.Lookup(ns)
        assignments[ns] = owner
    }
    r.Rebuild([]string{"a", "b", "c"})
    moved := 0
    for ns, oldOwner := range assignments {
        newOwner, _ := r.Lookup(ns)
        if newOwner != oldOwner {
            moved++
        }
    }
    // ~1/3 of keys should move to new member
    if moved < 200 || moved > 500 {
        t.Errorf("expected ~333 keys to move, got %d", moved)
    }
}

func TestDeterministic(t *testing.T) {
    r1 := NewRing([]string{"a", "b", "c"}, 16)
    r2 := NewRing([]string{"a", "b", "c"}, 16)
    for i := 0; i < 100; i++ {
        ns := fmt.Sprintf("ns-%d", i)
        o1, _ := r1.Lookup(ns)
        o2, _ := r2.Lookup(ns)
        if o1 != o2 {
            t.Errorf("mismatch for %s: %s vs %s", ns, o1, o2)
        }
    }
}

func TestCompleteness(t *testing.T) {
    r := NewRing([]string{"a", "b", "c", "d", "e"}, 16)
    for i := 0; i < 1000; i++ {
        _, ok := r.Lookup(fmt.Sprintf("ns-%d", i))
        if !ok {
            t.Fatal("unexpected empty lookup")
        }
    }
}

func TestConcurrentAccess(t *testing.T) {
    r := NewRing([]string{"a", "b", "c"}, 16)
    done := make(chan bool)
    // concurrent readers
    for i := 0; i < 10; i++ {
        go func() {
            for j := 0; j < 100; j++ {
                r.Lookup("default")
            }
            done <- true
        }()
    }
    // concurrent writer
    go func() {
        for j := 0; j < 10; j++ {
            r.Rebuild([]string{"a", "b", "c", "d"})
            r.Rebuild([]string{"a", "b", "c"})
        }
        done <- true
    }()
    for i := 0; i < 11; i++ {
        <-done
    }
}
```

- [ ] **Step 1.3: Run ring tests with race detector**

Run: `go test -race -count=1 ./internal/coordinator/ -run 'Test(Ring|Concurrent|Empty|Single|Two|Removal|Addition|Deterministic|Completeness)' -v`
Expected: All PASS

- [ ] **Step 1.4: Commit**

```bash
git add internal/coordinator/ring.go internal/coordinator/ring_test.go
git commit -m "feat: consistent hash ring with virtual nodes"
```

---

## Chunk 2: Coordinator

**Files:**
- Create: `internal/coordinator/coordinator.go`
- Create: `internal/coordinator/coordinator_integration_test.go`

### Coordinator Design

```go
package coordinator

import (
    "context"
    "log/slog"
    "sync"
    "time"
    "github.com/redis/go-redis/v9"
)

const (
    defaultHeartbeatInterval = 15 * time.Second
    defaultHeartbeatTTL      = 30 * time.Second
)

type Coordinator struct {
    client  redis.UniversalClient
    self    string
    ring    *Ring

    heartbeatInterval time.Duration
    heartbeatTTL      time.Duration

    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup

    events chan struct{}
}

func NewCoordinator(client redis.UniversalClient, podName string, opts ...Option) *Coordinator {
    ctx, cancel := context.WithCancel(context.Background())
    c := &Coordinator{
        client:            client,
        self:              podName,
        ring:              NewRing(nil, 16),
        heartbeatInterval: defaultHeartbeatInterval,
        heartbeatTTL:      defaultHeartbeatTTL,
        ctx:               ctx,
        cancel:            cancel,
        events:            make(chan struct{}, 1),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

// Join registers this replica and performs initial ring sync.
func (c *Coordinator) Join(ctx context.Context) error { ... }

// Leave deregisters this replica.
func (c *Coordinator) Leave(ctx context.Context) error { ... }

// Healthy returns true if the last heartbeat succeeded.
func (c *Coordinator) Healthy(ctx context.Context) bool { ... }

// Ring returns a snapshot of the current ring (thread-safe).
func (c *Coordinator) Ring() *Ring { return c.ring }

// Events returns a channel that receives a value when the ring changes.
func (c *Coordinator) Events() <-chan struct{} { return c.events }

func (c *Coordinator) syncRing(ctx context.Context) error { ... }
func (c *Coordinator) heartbeatLoop() { ... }
```

### Redis key helpers

```go
var keyPrefix = "paprika:coordinator:"

func replicasKey() string     { return keyPrefix + "replicas" }
func heartbeatKey(pod string) string { return keyPrefix + "heartbeat:" + pod }
func assignedKey(pod string) string { return keyPrefix + "assigned:" + pod }
```

### Join

1. `SADD replicasKey() self` 
2. `SET heartbeatKey(self) "alive" EX heartbeatTTL.Seconds()`
3. `syncRing()` — builds full ring from `SMEMBERS`
4. Start heartbeat goroutine

### syncRing

1. `SMEMBERS replicasKey()`
2. For each member, check if `EXISTS heartbeatKey(member)` (TTL expired → stale)
3. `SREM` stale members from replicas key
4. `SMEMBERS` again to get clean list
5. Call `ring.Rebuild(cleanMembers)`
6. Send to events channel (non-blocking)

### heartbeatLoop

1. Timer at `heartbeatInterval`
2. Each tick:
   - `SET heartbeatKey(self) "alive" EX heartbeatTTL.Seconds()`
   - Call `syncRing()` to detect membership changes
3. On context cancellation, stop

### Join options

```go
type Option func(*Coordinator)

func WithHeartbeatInterval(d time.Duration) Option { ... }
func WithHeartbeatTTL(d time.Duration) Option { ... }
```

- [ ] **Step 2.1: Write coordinator.go**

```go
package coordinator

import (
    "context"
    "fmt"
    "log/slog"
    "math/rand"
    "net/http"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
    "sigs.k8s.io/controller-runtime/pkg/manager"
)

const (
    DefaultHeartbeatInterval = 15 * time.Second
    DefaultHeartbeatTTL      = 30 * time.Second
)

var keyPrefix = "paprika:coordinator:"

func replicasKey() string              { return keyPrefix + "replicas" }
func heartbeatKey(pod string) string   { return keyPrefix + "heartbeat:" + pod }
func assignedKey(pod string) string    { return keyPrefix + "assigned:" + pod }

type Coordinator struct {
    client  redis.UniversalClient
    self    string
    ring    *Ring

    heartbeatInterval time.Duration
    heartbeatTTL      time.Duration

    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup

    healthy bool
    mu      sync.RWMutex
    events  chan struct{}
}

type Option func(*Coordinator)

func WithHeartbeatInterval(d time.Duration) Option {
    return func(c *Coordinator) { c.heartbeatInterval = d }
}

func WithHeartbeatTTL(d time.Duration) Option {
    return func(c *Coordinator) { c.heartbeatTTL = d }
}

func NewCoordinator(client redis.UniversalClient, podName string, opts ...Option) *Coordinator {
    ctx, cancel := context.WithCancel(context.Background())
    c := &Coordinator{
        client:            client,
        self:              podName,
        ring:              NewRing(nil, 16),
        heartbeatInterval: DefaultHeartbeatInterval,
        heartbeatTTL:      DefaultHeartbeatTTL,
        ctx:               ctx,
        cancel:            cancel,
        events:            make(chan struct{}, 1),
    }
    for _, opt := range opts {
        opt(c)
    }
    return c
}

func (c *Coordinator) Join(ctx context.Context) error {
    pipe := c.client.Pipeline()
    pipe.SAdd(ctx, replicasKey(), c.self)
    pipe.Set(ctx, heartbeatKey(c.self), "alive", c.heartbeatTTL)
    if _, err := pipe.Exec(ctx); err != nil {
        // Degraded mode: Redis unavailable at startup. Run with empty ring
        // (all namespaces pass through) and start heartbeat loop to retry.
        slog.Warn("Coordinator join failed, entering degraded mode", "error", err)
        c.wg.Add(1)
        go c.heartbeatLoop()
        return nil
    }
    c.mu.Lock()
    c.healthy = true
    c.mu.Unlock()
    if err := c.syncRing(ctx); err != nil {
        slog.Warn("Coordinator initial ring sync failed", "error", err)
        // Continue with empty ring; heartbeat loop will retry syncRing
    }
    c.wg.Add(1)
    go c.heartbeatLoop()
    slog.Info("Joined coordinator ring", "pod", c.self, "replicas", c.ring.Len(), "assigned", assignedCount(c.ring, c.self))
    return nil
}

// assignedCount counts namespaces assigned to this member (for logging/observability).
func assignedCount(r *Ring, member string) int {
    count := 0
    for i := 0; i < 1000; i++ {
        owner, _ := r.Lookup(fmt.Sprintf("ns-%d", i))
        if owner == member {
            count++
        }
    }
    return count
}

func (c *Coordinator) Leave(ctx context.Context) error {
    c.cancel()
    c.wg.Wait()
    pipe := c.client.Pipeline()
    pipe.Del(ctx, heartbeatKey(c.self))
    pipe.SRem(ctx, replicasKey(), c.self)
    pipe.Del(ctx, assignedKey(c.self))
    if _, err := pipe.Exec(ctx); err != nil {
        slog.Warn("Coordinator leave cleanup failed", "pod", c.self, "error", err)
    }
    slog.Info("Left coordinator ring", "pod", c.self)
    // Sleep to let peers detect departure on next heartbeat poll
    time.Sleep(2 * time.Second)
    return nil
}

func (c *Coordinator) Healthy(_ context.Context) bool {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.healthy
}

// AddHealthCheck registers the coordinator health check with the manager.
func (c *Coordinator) AddHealthCheck(mgr manager.Manager) error {
    return mgr.AddHealthzCheck("coordinator", func(req *http.Request) error {
        if !c.Healthy(req.Context()) {
            return fmt.Errorf("coordinator unhealthy: last heartbeat failed")
        }
        return nil
    })
}

func (c *Coordinator) Ring() *Ring {
    return c.ring
}

func (c *Coordinator) Events() <-chan struct{} {
    return c.events
}

func (c *Coordinator) syncRing(ctx context.Context) error {
    members, err := c.client.SMembers(ctx, replicasKey()).Result()
    if err != nil {
        return fmt.Errorf("coordinator SMEMBERS: %w", err)
    }
    // Track old state for rebalance logging
    oldMembers := c.ring.Members()
    oldLen := len(oldMembers)
    oldAssigned := assignedCount(c.ring, c.self)

    // Filter out stale members
    clean := make([]string, 0, len(members))
    for _, m := range members {
        exists, err := c.client.Exists(ctx, heartbeatKey(m)).Result()
        if err != nil {
            slog.Warn("Coordinator heartbeat check failed", "member", m, "error", err)
            clean = append(clean, m)
            continue
        }
        if exists == 0 {
            slog.Info("Replica left ring", "pod", m)
            c.client.SRem(ctx, replicasKey(), m)
            continue
        }
        clean = append(clean, m)
    }
    c.ring.Rebuild(clean)

    // Log rebalance
    if oldLen != len(clean) {
        slog.Info("Rebalancing ring - replicas changed",
            "from", oldLen, "to", len(clean))
        coordinatorRebalances.Inc()
    }
    newAssigned := assignedCount(c.ring, c.self)
    if newAssigned != oldAssigned {
        slog.Info("Assigned namespaces changed",
            "pod", c.self,
            "previous", oldAssigned,
            "current", newAssigned,
            "acquired", max(0, newAssigned-oldAssigned),
            "relinquished", max(0, oldAssigned-newAssigned))
    }
    coordinatorReplicas.Set(float64(len(clean)))
    // Update assigned namespaces for observability
    assigned := make([]string, 0)
    for i := 0; i < 1000; i++ {
        owner, _ := c.ring.Lookup(fmt.Sprintf("ns-%d", i))
        if owner == c.self {
            assigned = append(assigned, fmt.Sprintf("ns-%d", i))
        }
    }
    assignedCount := len(assigned)
    coordinatorAssignedNamespaces.WithLabelValues(c.self).Set(float64(assignedCount))
    if assignedCount > 0 {
        pipe := c.client.Pipeline()
        pipe.Del(ctx, assignedKey(c.self))
        pipe.SAdd(ctx, assignedKey(c.self), assigned)
        pipe.Expire(ctx, assignedKey(c.self), c.heartbeatTTL)
        pipe.Exec(ctx)
    }
    // Non-blocking notify
    select {
    case c.events <- struct{}{}:
    default:
    }
    return nil
}

func (c *Coordinator) heartbeatLoop() {
    defer c.wg.Done()
    // Random jitter 0-5s on startup to avoid thundering herd
    time.Sleep(time.Duration(rand.Intn(5000)) * time.Millisecond)
    ticker := time.NewTicker(c.heartbeatInterval)
    defer ticker.Stop()
    for {
        select {
        case <-c.ctx.Done():
            return
        case <-ticker.C:
            heartbeatStart := time.Now()
            ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
            pipe := c.client.Pipeline()
            pipe.Set(ctx, heartbeatKey(c.self), "alive", c.heartbeatTTL)
            pipe.Expire(ctx, replicasKey(), c.heartbeatTTL)
            if _, err := pipe.Exec(ctx); err != nil {
                slog.Error("Coordinator heartbeat failed", "error", err)
                heartbeatFailed.Inc()
                c.mu.Lock()
                c.healthy = false
                c.mu.Unlock()
                cancel()
                // Retry sooner (5s) on failure instead of waiting full interval
                time.Sleep(5 * time.Second)
                continue
            }
            c.mu.Lock()
            c.healthy = true
            c.mu.Unlock()
            heartbeatDurationHistogram.Observe(time.Since(heartbeatStart).Seconds())
            if err := c.syncRing(ctx); err != nil {
                slog.Error("Coordinator ring sync failed", "error", err)
            }
            cancel()
        }
    }
}
```

- [ ] **Step 2.2: Write metrics.go**

```go
package coordinator

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    coordinatorReplicas = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "paprika_coordinator_replicas",
        Help: "Number of active replicas in the ring",
    })

    coordinatorRebalances = promauto.NewCounter(prometheus.CounterOpts{
        Name: "paprika_coordinator_rebalances_total",
        Help: "Number of ring rebalance events",
    })

    coordinatorAssignedNamespaces = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "paprika_coordinator_assigned_namespaces",
        Help: "Namespaces assigned to this replica",
    }, []string{"pod"})

    heartbeatDurationHistogram = promauto.NewHistogram(prometheus.HistogramOpts{
        Name:    "paprika_coordinator_heartbeat_seconds",
        Help:    "Coordinator heartbeat round-trip latency",
        Buckets: prometheus.DefBuckets,
    })

    heartbeatFailed = promauto.NewCounter(prometheus.CounterOpts{
        Name: "paprika_coordinator_heartbeat_failures_total",
        Help: "Number of failed heartbeat attempts",
    })
)
```

- [ ] **Step 2.3: Write coordinator_integration_test.go**

Uses `miniredis` for an embedded Redis that requires no external process:

```go
package coordinator

import (
    "context"
    "fmt"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
)

func setupTestCoordinator(t *testing.T, members []string) (*Coordinator, *miniredis.Miniredis, context.Context) {
    t.Helper()
    mr, err := miniredis.Run()
    if err != nil {
        t.Fatal(err)
    }
    t.Cleanup(mr.Close)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    ctx := context.Background()
    // Register other members first so the new member sees them
    for _, m := range members {
        client.SAdd(ctx, replicasKey(), m)
        client.Set(ctx, heartbeatKey(m), "alive", 30*time.Second)
    }
    c := NewCoordinator(client, "test-pod",
        WithHeartbeatInterval(time.Hour), // prevent automatic heartbeat during test
        WithHeartbeatTTL(30*time.Second),
    )
    return c, mr, ctx
}

func TestCoordinatorJoin(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, []string{"peer-1", "peer-2"})
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    // Verify ring has all members
    if c.ring.Len() != 3 {
        t.Errorf("expected 3 ring members, got %d", c.ring.Len())
    }
    // Verify Redis registration
    if !mr.SIsMember(replicasKey(), "test-pod") {
        t.Error("test-pod not in replicas set")
    }
    // Verify self is assigned some namespaces
    found := false
    for i := 0; i < 100; i++ {
        owner, _ := c.ring.Lookup(fmt.Sprintf("ns-%d", i))
        if owner == "test-pod" {
            found = true
            break
        }
    }
    if !found {
        t.Error("test-pod not assigned any namespaces")
    }
}

func TestCoordinatorLeave(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, []string{"peer-1"})
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    if err := c.Leave(ctx); err != nil {
        t.Fatal(err)
    }
    if mr.SIsMember(replicasKey(), "test-pod") {
        t.Error("test-pod still in replicas after leave")
    }
    if mr.Exists(heartbeatKey("test-pod")) {
        t.Error("heartbeat still exists after leave")
    }
}

func TestCoordinatorStaleDetection(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, []string{"peer-1"})
    // peer-2 had heartbeat but it expired
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
    client.SAdd(ctx, replicasKey(), "stale-pod")
    client.Set(ctx, heartbeatKey("stale-pod"), "alive", -1*time.Second) // already expired
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    // stale-pod should be removed during syncRing
    if mr.SIsMember(replicasKey(), "stale-pod") {
        t.Error("stale-pod was not removed")
    }
    if c.ring.Len() != 2 { // peer-1 + test-pod
        t.Errorf("expected 2 ring members, got %d", c.ring.Len())
    }
}

func TestCoordinatorHealthy(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, nil)
    // Override to short interval so Redis failure is detected quickly
    c.heartbeatInterval = 50 * time.Millisecond
    c.heartbeatTTL = 200 * time.Millisecond
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    if !c.Healthy(ctx) {
        t.Error("expected healthy after join")
    }
    mr.Close() // kill Redis
    time.Sleep(150 * time.Millisecond) // wait for next heartbeat to fail
    if c.Healthy(ctx) {
        t.Error("expected unhealthy after Redis failure")
    }
}

Add a test for coordination safety after the existing `TestCoordinatorHealthy` test:

```go
func TestCoordinatorConcurrentSyncRing(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, []string{"peer-1", "peer-2", "peer-3"})
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    // Concurrent syncRing from multiple goroutines
    errs := make(chan error, 10)
    for i := 0; i < 5; i++ {
        go func() {
            errs <- c.syncRing(ctx)
        }()
    }
    for i := 0; i < 5; i++ {
        if err := <-errs; err != nil {
            t.Errorf("concurrent syncRing failed: %v", err)
        }
    }
    if c.ring.Len() != 4 { // 3 peers + test-pod
        t.Errorf("expected 4 ring members, got %d", c.ring.Len())
    }
}

func TestCoordinatorHeartbeatRefreshesTTL(t *testing.T) {
    c, mr, ctx := setupTestCoordinator(t, nil)
    // Use a very short TTL for testing
    c.heartbeatTTL = 2 * time.Second
    c.heartbeatInterval = 100 * time.Millisecond
    if err := c.Join(ctx); err != nil {
        t.Fatal(err)
    }
    // Verify heartbeat key exists with TTL
    ttl := mr.TTL(heartbeatKey("test-pod"))
    if ttl <= 0 {
        t.Errorf("expected heartbeat TTL > 0, got %v", ttl)
    }
    // Wait for next heartbeat
    time.Sleep(200 * time.Millisecond)
    // TTL should have been refreshed (should still be near 2s, not near 0)
    newTTL := mr.TTL(heartbeatKey("test-pod"))
    if newTTL < 1500*time.Millisecond {
        t.Errorf("expected TTL refreshed (~2s), got %v", newTTL)
    }
}
```

- [ ] **Step 2.4: Check miniredis availability and add if needed**

Run: `grep -c "miniredis" go.mod || go get github.com/alicebob/miniredis/v2@latest`

- [ ] **Step 2.5: Run coordinator tests**

Run: `go test -race -count=1 ./internal/coordinator/ -run 'TestCoordinator' -v`
Expected: All PASS

- [ ] **Step 2.6: Commit**

```bash
git add internal/coordinator/coordinator.go internal/coordinator/coordinator_integration_test.go
git commit -m "feat: Redis-backed coordinator with heartbeat and ring sync"
```

If miniredis was added:
```bash
git add go.mod go.sum
git commit -m "feat: Redis-backed coordinator with heartbeat and ring sync"
```
(rebase together)

---

## Chunk 3: ShardFilter + CLI Integration

**Files:**
- Create: `internal/coordinator/shard_filter.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`

### ShardFilter

- [ ] **Step 3.1: Read existing ShardFilter interface**

Run: `cat internal/controller/shard_filter.go`

- [ ] **Step 3.2: Write shard_filter.go**

```go
package coordinator

import (
    "context"
    "sync/atomic"
)

// RingShardFilter implements controller.ShardFilter backed by a Coordinator ring.
// Thread-safe: the ring pointer is swapped atomically on rebalance.
type RingShardFilter struct {
    ring atomic.Pointer[Ring]
    self string
}

func NewRingShardFilter(ring *Ring, self string) *RingShardFilter {
    f := &RingShardFilter{self: self}
    f.ring.Store(ring)
    return f
}

func (f *RingShardFilter) ShouldReconcile(_ context.Context, namespace string) (bool, error) {
    r := f.ring.Load()
    if r == nil || r.Len() == 0 {
        return true, nil // fall through all namespaces on empty ring
    }
    owner, ok := r.Lookup(namespace)
    if !ok {
        return true, nil // fall through if ring is empty
    }
    return owner == f.self, nil
}

// UpdateRing atomically swaps the ring pointer. Called by coordinator on rebalance.
func (f *RingShardFilter) UpdateRing(r *Ring) {
    f.ring.Store(r)
}
```

- [ ] **Step 3.3 (removed — signature is correct from the start)**

- [ ] **Step 3.4: Verify env var binding pattern in existing code**

The spec defines env vars `PAPRIKA_COORDINATOR_MODE`, `PAPRIKA_COORDINATOR_HEARTBEAT`, `PAPRIKA_COORDINATOR_TTL`. Check how existing flags are bound to env vars:

Run: `grep -B1 -A2 "mapstructure\|viper\|os.Getenv" cmd/main.go | head -30`

If the existing pattern uses Viper/mapstructure (most likely — all existing flags use `mapstructure` tags), the env vars are auto-bound via existing Viper config. Add explicit env var mappings if needed.

- [ ] **Step 3.5: Add CLI flags to cmd/main.go**

In `cliConfig` struct, add:
```go
coordinatorMode     bool          `mapstructure:"coordinator-mode"`
coordinatorHeartbeat time.Duration `mapstructure:"coordinator-heartbeat"`
coordinatorTTL      time.Duration `mapstructure:"coordinator-ttl"`
```

In the flags section (around line 194 where `--leader-elect` is defined), add:
```go
fs.Bool("coordinator-mode", false, "Enable Redis-backed coordinator for active-active sharding (requires Redis)")
fs.Duration("coordinator-heartbeat", 15*time.Second, "Coordinator heartbeat interval")
fs.Duration("coordinator-ttl", 30*time.Second, "Coordinator heartbeat TTL (must be > heartbeat)")
```

In `dispatchMode()` after parsing, maybe add validation:
```go
if cfg.coordinatorMode && os.Getenv("PAPRIKA_REDIS_ADDR") == "" {
    return fmt.Errorf("--coordinator-mode requires PAPRIKA_REDIS_ADDR environment variable")
}
```

- [ ] **Step 3.6: Read main_operator.go buildOperatorDependencies and buildOperatorManager**

Run: `grep -n "func buildOperator\|shardFilter\|LeaderElection" cmd/main_operator.go`

- [ ] **Step 3.7: Modify main_operator.go — manager creation**

When `cfg.coordinatorMode` is true, set `LeaderElection: false` on the manager:
```go
leaderElect := cfg.enableLeaderElection
if cfg.coordinatorMode {
    leaderElect = false
}
// In manager options:
LeaderElection: leaderElect,
```

After `buildOperatorDependencies()` returns the `deps` struct, conditionally create the coordinator:

```go
func startCoordinator(ctx context.Context, cfg *cliConfig, deps *operatorDependencies, mgr manager.Manager) (*coordinator.Coordinator, error) {
    if !cfg.coordinatorMode {
        return nil, nil
    }
    redisAddr := os.Getenv("PAPRIKA_REDIS_ADDR")
    redisPassword := os.Getenv("PAPRIKA_REDIS_PASSWORD")
    redisDB, _ := strconv.Atoi(os.Getenv("PAPRIKA_REDIS_DB"))
    
    client := redis.NewClient(&redis.Options{
        Addr:     redisAddr,
        Password: redisPassword,
        DB:       redisDB,
    })
    podName := os.Getenv("PAPRIKA_POD_NAME")
    if podName == "" {
        hostname, err := os.Hostname()
        if err != nil {
            return nil, fmt.Errorf("cannot determine pod identity: %w", err)
        }
        podName = hostname
    }
    
    c := coordinator.NewCoordinator(client, podName,
        coordinator.WithHeartbeatInterval(cfg.coordinatorHeartbeat),
        coordinator.WithHeartbeatTTL(cfg.coordinatorTTL),
    )
    if err := c.Join(ctx); err != nil {
        return nil, fmt.Errorf("coordinator join: %w", err)
    }
    // Replace the shard filter with the ring-based one
    deps.shardFilter = coordinator.NewRingShardFilter(c.Ring(), podName)
    
    // Wire up ring updates: on coordinator ring change, update the filter
    go func() {
        for range c.Events() {
            deps.shardFilter.(*coordinator.RingShardFilter).UpdateRing(c.Ring())
        }
    }()
    
    // Register coordinator health check with the manager
    if err := c.AddHealthCheck(mgr); err != nil {
        return nil, fmt.Errorf("coordinator health check: %w", err)
    }
    
    return c, nil
}
```

The integration follows the existing `runOperatorMode()` flow:

1. `buildOperatorDependencies()` creates `deps.shardFilter` (env-var based)
2. `buildOperatorManager()` creates `mgr` (with leader election)
3. If `--coordinator-mode`, the coordinator is started between manager build and controller setup
4. Coordinator replaces `deps.shardFilter` with `RingShardFilter` and registers its health check

- [ ] **Step 3.8: Write changes to main_operator.go**

In `buildOperatorManager()`, modify the leader election:

```go
leaderElect := cfg.enableLeaderElection
if cfg.coordinatorMode {
    leaderElect = false
}

mgr, err := ctrl.NewManager(restCfg, ctrl.Options{
    ...
    LeaderElection: leaderElect,
    ...
})
```

In `runOperatorMode()`, after `buildOperatorDependencies()` and `buildOperatorManager()` but before `setupOperatorControllers()`:

```go
if cfg.coordinatorMode {
    coord, err := startCoordinator(ctx, cfg, deps, mgr)
    if err != nil {
        setupLog.Error(err, "Failed to start coordinator")
        return err
    }
    deps.coordinator = coord
}
```

Add `coordinator *coordinator.Coordinator` field to `operatorDependencies` struct.

Add import for `"github.com/redis/go-redis/v9"` in `cmd/main_operator.go` since `startCoordinator` creates a Redis client.

- [ ] **Step 3.9: Build and test**

Run: `go build ./...`
Expected: success

- [ ] **Step 3.10: Run lint**

Run: `make lint`
Expected: 0 issues

- [ ] **Step 3.11: Commit**

```bash
git add internal/coordinator/shard_filter.go cmd/main.go cmd/main_operator.go
git commit -m "feat: integrate coordinator with CLI and operator manager"
```

---

## Chunk 4: Verify Integration

- [ ] **Step 4.1: Full project build**

Run: `go build ./...`
Expected: success

- [ ] **Step 4.2: Run all coordinator tests**

Run: `go test -race -count=1 ./internal/coordinator/ -v`
Expected: All PASS

- [ ] **Step 4.3: Run full project test suite (excluding e2e)**

Run: `go test -count=1 -timeout 120s ./internal/... ./cmd/... ./api/...`
Expected: All PASS

- [ ] **Step 4.4: Final lint**

Run: `make lint`
Expected: 0 issues

- [ ] **Step 4.5: Commit final**

```bash
git add -A
git commit -m "fix: final integration cleanup"
```

---

## Plan Review

After writing the plan, dispatch the plan-document-reviewer subagent (see plan-document-reviewer-prompt.md) with precisely crafted review context. Fix issues and re-dispatch until approved. Then proceed to execution.
