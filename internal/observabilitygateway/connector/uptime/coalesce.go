package uptime

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

type flight[V any] struct {
	done  chan struct{}
	value V
	err   error
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
// The fetch runs on a context detached from every caller's cancellation, so a
// waiter that gives up returns its own ctx error and leaves the fetch running
// for the others. The fetch is still bounded by timeout. fetch returns how long
// its value may be kept; a zero duration keeps nothing, and errors are never kept.
// A caller whose context has already ended does not start a new fetch.
func (c *coalescer[V]) do(ctx context.Context, key string, timeout time.Duration, fetch func(context.Context) (V, time.Duration, error)) (V, error) {
	var zero V
	c.mu.Lock()
	if value, ok := c.lookupLocked(key); ok {
		c.mu.Unlock()
		return value, nil
	}
	f, running := c.inflight[key]
	if !running {
		if err := ctx.Err(); err != nil {
			c.mu.Unlock()
			return zero, abandoned(err)
		}
		f = &flight[V]{done: make(chan struct{})}
		c.inflight[key] = f
		go c.run(context.WithoutCancel(ctx), key, f, timeout, fetch)
	}
	c.mu.Unlock()
	return wait(ctx, f)
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

func (c *coalescer[V]) run(parent context.Context, key string, f *flight[V], timeout time.Duration, fetch func(context.Context) (V, time.Duration, error)) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	value, keep, err := fetch(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
	if err == nil && keep > 0 {
		c.storeLocked(key, value, keep)
	}
	f.value, f.err = value, err
	close(f.done)
}

func wait[V any](ctx context.Context, f *flight[V]) (V, error) {
	select {
	case <-f.done:
		return f.value, f.err
	case <-ctx.Done():
		var zero V
		return zero, abandoned(ctx.Err())
	}
}

func abandoned(err error) error {
	return fmt.Errorf("uptime read abandoned by caller: %w", err)
}

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

// storeLocked keeps value for keep. Expired values are also removed by a timer,
// so a value does not stay in memory after its time is up when no later query
// asks for its key.
func (c *coalescer[V]) storeLocked(key string, value V, keep time.Duration) {
	cost := c.size(value)
	if cost > maxEntryBytes {
		return
	}
	if element, ok := c.entries[key]; ok {
		c.removeLocked(element)
	}
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
	time.AfterFunc(keep, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if element, ok := c.entries[key]; ok && element.Value == any(entry) {
			c.removeLocked(element)
		}
	})
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
