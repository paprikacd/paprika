package uptime

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

const (
	// maxCachedEntries bounds the number of kept values in each process-local cache.
	maxCachedEntries = 64
	// maxCachedBytes bounds the total size of kept values in each cache.
	maxCachedBytes = 8 << 20
	// maxEntryBytes is the largest single value a cache keeps. Larger values
	// are returned to their callers but never stored.
	maxEntryBytes = 256 << 10
)

// coalescer shares one in-flight fetch among concurrent callers that ask for
// the same key, and keeps successful results for a short time so that a
// dashboard's repeated identical reads do not each reach the upstream.
//
// Kept values expire lazily: an expired value is dropped the next time its key
// is looked up or another value is stored. No timers are used, so an evicted
// value is not reachable from any timer closure. The count and byte bounds
// therefore limit how much memory can be held, not just the index.
type coalescer[V any] struct {
	mu       sync.Mutex
	now      func() time.Time
	max      int
	maxBytes int
	size     func(V) int
	bytes    int
	entries  map[string]*list.Element // holds *cacheEntry[V]; front is most recently used
	order    *list.List
	inflight map[string]*flight[V]
}

type cacheEntry[V any] struct {
	key     string
	value   V
	cost    int
	expires time.Time
}

// flight is one shared fetch. refs counts the waiters still joined, and
// finished is set once fetch has returned. Both are guarded by coalescer.mu.
// cancel stops the shared fetch; it runs when the last waiter leaves.
type flight[V any] struct {
	done     chan struct{}
	cancel   context.CancelFunc
	refs     int
	finished bool
	value    V
	err      error
}

// newCoalescer returns a coalescer that keeps at most limit values, and at most
// maxCachedBytes by size. size reports the cost of one value.
func newCoalescer[V any](limit int, size func(V) int) *coalescer[V] {
	return &coalescer[V]{
		now:      time.Now,
		max:      limit,
		maxBytes: maxCachedBytes,
		size:     size,
		entries:  make(map[string]*list.Element),
		order:    list.New(),
		inflight: make(map[string]*flight[V]),
	}
}

// do returns the value for key. A kept value is returned without calling
// fetch. Otherwise one fetch runs for all concurrent callers with the same key.
//
// The shared fetch runs on its own context, bounded by timeout, and is not a
// child of any caller's context. Each waiter counts itself against the flight.
// A waiter whose ctx ends leaves and returns its own ctx error. The flight keeps
// running while at least one waiter is joined. When the last waiter leaves, the
// fetch is cancelled and the flight is forgotten, so a later caller starts a
// fresh fetch rather than joining a cancelled one.
//
// fetch returns how long its value may be kept; a zero duration keeps nothing,
// and errors are never kept. A caller whose context has already ended does not
// start a fetch or join one.
func (c *coalescer[V]) do(ctx context.Context, key string, timeout time.Duration, fetch func(context.Context) (V, time.Duration, error)) (V, error) {
	var zero V
	c.mu.Lock()
	if value, ok := c.lookupLocked(key); ok {
		c.mu.Unlock()
		return value, nil
	}
	if err := ctx.Err(); err != nil {
		c.mu.Unlock()
		return zero, abandoned(err)
	}
	f, running := c.inflight[key]
	if !running {
		// The shared fetch keeps ctx's values but not its cancellation, so the
		// first caller leaving does not stop it. The cancel func is stored on the
		// flight and called by run, or by the last waiter's leave.
		fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout) //nolint:gosec // G118: cancel is owned by the flight; run or leave calls it.
		f = &flight[V]{done: make(chan struct{}), cancel: cancel}
		c.inflight[key] = f
		go c.run(fetchCtx, key, f, fetch)
	}
	f.refs++
	c.mu.Unlock()
	return c.wait(ctx, key, f)
}

// forget drops any kept value for key. It is used when Uptime rejects a
// credential, so the next query refreshes it rather than reusing it.
func (c *coalescer[V]) forget(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.entries[key]; ok {
		c.removeLocked(element)
	}
}

// run performs the shared fetch and publishes its result to the waiters.
func (c *coalescer[V]) run(ctx context.Context, key string, f *flight[V], fetch func(context.Context) (V, time.Duration, error)) {
	defer f.cancel()
	value, keep, err := safeFetch(ctx, fetch)
	c.mu.Lock()
	defer c.mu.Unlock()
	f.finished = true
	if c.inflight[key] == f {
		delete(c.inflight, key)
	}
	if err == nil && keep > 0 {
		c.storeLocked(key, value, keep)
	}
	f.value, f.err = value, err
	close(f.done)
}

// safeFetch turns a panic in fetch into an error for this flight's waiters. A
// panic on the detached fetch goroutine would otherwise crash the gateway.
func safeFetch[V any](ctx context.Context, fetch func(context.Context) (V, time.Duration, error)) (value V, keep time.Duration, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			var zero V
			value, keep, err = zero, 0, errors.New("uptime read panicked")
		}
	}()
	return fetch(ctx)
}

// wait blocks until the flight finishes or ctx ends, whichever is first.
func (c *coalescer[V]) wait(ctx context.Context, key string, f *flight[V]) (V, error) {
	select {
	case <-f.done:
		return f.value, f.err
	case <-ctx.Done():
		c.leave(key, f)
		var zero V
		return zero, abandoned(ctx.Err())
	}
}

// leave removes one waiter from f. When the last waiter leaves a flight that
// has not finished, its fetch is cancelled and the flight is forgotten.
func (c *coalescer[V]) leave(key string, f *flight[V]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	f.refs--
	if f.refs > 0 || f.finished {
		return
	}
	f.cancel()
	if c.inflight[key] == f {
		delete(c.inflight, key)
	}
}

func abandoned(err error) error {
	return fmt.Errorf("uptime read abandoned by caller: %w", err)
}

// lookupLocked returns a kept value that has not expired. An expired entry is
// dropped here, so an access never returns or retains a stale value.
func (c *coalescer[V]) lookupLocked(key string) (V, bool) {
	var zero V
	element, ok := c.entries[key]
	if !ok {
		return zero, false
	}
	entry, ok := element.Value.(*cacheEntry[V])
	if !ok {
		return zero, false
	}
	if !c.now().Before(entry.expires) {
		c.removeLocked(element)
		return zero, false
	}
	c.order.MoveToFront(element)
	return entry.value, true
}

// storeLocked keeps value for keep. Before inserting, it drops every expired
// entry, then evicts least recently used entries until the count and byte
// bounds hold. Values over maxEntryBytes are not kept and are logged at debug
// level, so a dashboard whose reads are too large to cache is visible.
func (c *coalescer[V]) storeLocked(key string, value V, keep time.Duration) {
	cost := c.size(value)
	if cost > maxEntryBytes {
		slog.Debug("uptime read over the cache size limit was not kept", "bytes", cost, "limit", maxEntryBytes)
		return
	}
	if element, ok := c.entries[key]; ok {
		c.removeLocked(element)
	}
	c.sweepExpiredLocked()
	entry := &cacheEntry[V]{key: key, value: value, cost: cost, expires: c.now().Add(keep)}
	c.entries[key] = c.order.PushFront(entry)
	c.bytes += cost
	for c.order.Len() > c.max || c.bytes > c.maxBytes {
		oldest := c.order.Back()
		if oldest == nil {
			break
		}
		c.removeLocked(oldest)
	}
}

// sweepExpiredLocked removes every expired entry. The list holds at most
// maxCachedEntries elements, so a full pass on insert is cheap.
func (c *coalescer[V]) sweepExpiredLocked() {
	now := c.now()
	for element := c.order.Back(); element != nil; {
		previous := element.Prev()
		if entry, ok := element.Value.(*cacheEntry[V]); ok && !now.Before(entry.expires) {
			c.removeLocked(element)
		}
		element = previous
	}
}

func (c *coalescer[V]) removeLocked(element *list.Element) {
	c.order.Remove(element)
	entry, ok := element.Value.(*cacheEntry[V])
	if !ok {
		return
	}
	delete(c.entries, entry.key)
	c.bytes -= entry.cost
}

// digestOf returns a SHA-256 hex digest of the canonical JSON encoding of v.
// Callers must not use an empty key on error, because that would merge
// unrelated requests, so the error is returned instead.
func digestOf(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("digest encoding: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// credentialIdentity digests the caller's raw credential document so cache
// keys can separate callers without holding the secret itself.
func credentialIdentity(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
