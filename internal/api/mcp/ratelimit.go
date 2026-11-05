package mcp

import (
	"context"
	"errors"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// The MCP endpoint protects per-principal request rates independently from
// the bounded provider execution queues. Short bursts can wait for admission,
// but a runaway caller cannot retain unlimited HTTP connections.
const (
	mcpRatePerSecond = 50
	mcpRateBurst     = 100

	mcpRateQueueWait          = 2 * time.Second
	mcpRateQueueLimit         = 64
	mcpRateQueuePerPrincipal  = 8
	mcpLimiterIdleTTL         = 10 * time.Minute
	mcpLimiterSweepAt         = 256
)

var errRateQueueCapacity = errors.New("MCP request rate queue is full or the wait would exceed its budget")

type limiterEntry struct {
	lim      *rate.Limiter
	lastSeen time.Time
	queued   int
}

// principalRateLimiter keeps independent token buckets per authenticated
// subject. Admission reservations are FIFO within each subject, and queued
// waiters retain a bounded number of handler goroutines for a bounded time.
// The accounting is protected by mu; sleeping never holds the mutex.
type principalRateLimiter struct {
	mu             sync.Mutex
	now            func() time.Time // injected for idle-eviction tests
	lims           map[string]*limiterEntry
	per            rate.Limit
	burst          int
	waiting        int
	maxWaiting     int
	maxPerSubject  int
	maxWait        time.Duration
}

func newPrincipalRateLimiter() *principalRateLimiter {
	return &principalRateLimiter{
		now:           time.Now,
		lims:          map[string]*limiterEntry{},
		per:           rate.Limit(mcpRatePerSecond),
		burst:         mcpRateBurst,
		maxWaiting:    mcpRateQueueLimit,
		maxPerSubject: mcpRateQueuePerPrincipal,
		maxWait:       mcpRateQueueWait,
	}
}

func (l *principalRateLimiter) entryLocked(subject string) *limiterEntry {
	if len(l.lims) >= mcpLimiterSweepAt {
		l.sweepLocked(l.now())
	}
	entry := l.lims[subject]
	if entry == nil {
		entry = &limiterEntry{lim: rate.NewLimiter(l.per, l.burst)}
		l.lims[subject] = entry
	}
	entry.lastSeen = l.now()
	return entry
}

// Allow remains an immediate admission primitive for callers explicitly
// requiring fail-fast behavior. MCP HTTP requests use Wait instead.
func (l *principalRateLimiter) Allow(subject string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.entryLocked(subject).lim.Allow()
}

// Wait reserves one token in the principal's token bucket and holds the
// connection for a short, bounded delay instead of immediately returning 429.
// A canceled request returns its reservation and releases its queue count.
// There is no background worker, detached execution or post-disconnect work.
func (l *principalRateLimiter) Wait(ctx context.Context, subject string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	l.mu.Lock()
	entry := l.entryLocked(subject)
	reservation := entry.lim.Reserve()
	if !reservation.OK() {
		l.mu.Unlock()
		return errRateQueueCapacity
	}
	delay := reservation.Delay()
	if delay > l.maxWait || (delay > 0 &&
		(l.waiting >= l.maxWaiting || entry.queued >= l.maxPerSubject)) {
		reservation.Cancel()
		l.mu.Unlock()
		return errRateQueueCapacity
	}
	if delay > 0 {
		l.waiting++
		entry.queued++
	}
	l.mu.Unlock()

	if delay <= 0 {
		return ctx.Err()
	}
	defer func() {
		l.mu.Lock()
		l.waiting--
		entry.queued--
		l.mu.Unlock()
	}()

	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return ctx.Err()
	case <-ctx.Done():
		reservation.Cancel()
		return ctx.Err()
	}
}

// sweepLocked drops only entries that are idle and have no queued waiters.
// It runs only after the subject map reaches a threshold, amortizing its cost.
func (l *principalRateLimiter) sweepLocked(now time.Time) {
	for subject, entry := range l.lims {
		if entry.queued == 0 && now.Sub(entry.lastSeen) > mcpLimiterIdleTTL {
			delete(l.lims, subject)
		}
	}
}
