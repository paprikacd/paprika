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

// maxCachedEntries bounds each process-local cache. The oldest settled entry
// is evicted first when a new one would exceed it.
const maxCachedEntries = 64

// coalescer shares one in-flight fetch among concurrent callers that ask for
// the same key, and keeps successful results for a short time so that a
// dashboard's repeated identical reads do not each reach the upstream.
type coalescer[V any] struct {
	mu       sync.Mutex
	now      func() time.Time
	max      int
	entries  map[string]*list.Element // holds *cacheEntry[V]; front is most recently used
	order    *list.List
	inflight map[string]*flight[V]
}

type cacheEntry[V any] struct {
	key     string
	value   V
	expires time.Time
}

type flight[V any] struct {
	done  chan struct{}
	value V
	err   error
}

func newCoalescer[V any](limit int) *coalescer[V] {
	return &coalescer[V]{
		now:      time.Now,
		max:      limit,
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
func (c *coalescer[V]) do(ctx context.Context, key string, timeout time.Duration, fetch func(context.Context) (V, time.Duration, error)) (V, error) {
	c.mu.Lock()
	if value, ok := c.lookupLocked(key); ok {
		c.mu.Unlock()
		return value, nil
	}
	f, running := c.inflight[key]
	if !running {
		f = &flight[V]{done: make(chan struct{})}
		c.inflight[key] = f
		go c.run(context.WithoutCancel(ctx), key, f, timeout, fetch)
	}
	c.mu.Unlock()
	return wait(ctx, f)
}

func (c *coalescer[V]) run(parent context.Context, key string, f *flight[V], timeout time.Duration, fetch func(context.Context) (V, time.Duration, error)) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	value, keep, err := fetch(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
	if err == nil && keep > 0 {
		c.storeLocked(key, value, c.now().Add(keep))
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
		return zero, fmt.Errorf("uptime read abandoned by caller: %w", ctx.Err())
	}
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
		c.order.Remove(element)
		delete(c.entries, key)
		return zero, false
	}
	c.order.MoveToFront(element)
	return entry.value, true
}

func (c *coalescer[V]) storeLocked(key string, value V, expires time.Time) {
	if element, ok := c.entries[key]; ok {
		c.order.Remove(element)
		delete(c.entries, key)
	}
	c.entries[key] = c.order.PushFront(&cacheEntry[V]{key: key, value: value, expires: expires})
	for c.order.Len() > c.max {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		if entry, ok := oldest.Value.(*cacheEntry[V]); ok {
			delete(c.entries, entry.key)
		}
	}
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
