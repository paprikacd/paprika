package mcp

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// The MCP endpoint has no upstream protection between a caller's bearer
// token and a tools/call loop: the listener's --api-max-conns caps socket
// exhaustion but says nothing about request rate per credential. An agent
// that spins — or a leaked token scripted into a loop — could otherwise
// drive the Connect handlers (RBAC checks, informer reads, audit writes) at
// unbounded QPS on behalf of one subject. This limiter bounds requests per
// authenticated subject; it deliberately sits at the HTTP layer (post-auth,
// pre-dispatch) so a limited request never reaches tool invocation.
const (
	// mcpRatePerSecond is generous for interactive agent use (~15 calls/s
	// was the observed aggregate under a 3-worker load test) while capping
	// runaway loops well below what saturates the apiserver.
	mcpRatePerSecond = 50
	mcpRateBurst     = 100

	// mcpLimiterIdleTTL evicts subjects that haven't sent a request
	// recently; the limiter map would otherwise grow one entry per bearer
	// subject the server has ever seen.
	mcpLimiterIdleTTL = 10 * time.Minute

	// mcpLimiterSweepAt is the map size that triggers an eviction pass —
	// pruning on every Allow would be O(subjects) per request.
	mcpLimiterSweepAt = 256
)

type limiterEntry struct {
	lim      *rate.Limiter
	lastSeen time.Time
}

// principalRateLimiter is a small mutex-guarded map of per-subject token
// buckets. It trades exactness under extreme subject cardinality for
// simplicity: entries are created lazily and swept in bulk when the map
// exceeds mcpLimiterSweepAt, so memory stays proportional to active
// callers rather than all-time callers.
type principalRateLimiter struct {
	mu    sync.Mutex
	now   func() time.Time // injected for tests
	lims  map[string]*limiterEntry
	per   rate.Limit
	burst int
}

func newPrincipalRateLimiter() *principalRateLimiter {
	return &principalRateLimiter{
		now:   time.Now,
		lims:  map[string]*limiterEntry{},
		per:   rate.Limit(mcpRatePerSecond),
		burst: mcpRateBurst,
	}
}

// Allow reports whether the subject may send this request, charging one
// token when permitted. An empty subject (unauthenticated callers never
// reach this — it runs post-Authenticate) is treated as its own bucket.
func (l *principalRateLimiter) Allow(subject string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.lims) >= mcpLimiterSweepAt {
		l.sweepLocked(l.now())
	}
	e, ok := l.lims[subject]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(l.per, l.burst)}
		l.lims[subject] = e
	}
	e.lastSeen = l.now()
	return e.lim.Allow()
}

// sweepLocked drops entries idle longer than mcpLimiterIdleTTL. Called only
// when the map is oversized, so its O(n) cost amortizes against admission
// volume.
func (l *principalRateLimiter) sweepLocked(now time.Time) {
	for subject, e := range l.lims {
		if now.Sub(e.lastSeen) > mcpLimiterIdleTTL {
			delete(l.lims, subject)
		}
	}
}
