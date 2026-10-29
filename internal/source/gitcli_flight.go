package source

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// revisionCache answers "which commit is this branch or tag on now" for one
// mirror. Every answer comes from an ls-remote and is as fresh as the moment
// that ls-remote began. A lookup states how stale an answer it accepts
// (notBefore): a cached answer or an ls-remote already in flight that began at
// or after notBefore serves it; anything older starts a new ls-remote. N
// requests for one revision therefore share one ls-remote, while a request
// that must see the remote as it is now (fetchTtl 0, a sync trigger) never
// takes an answer from before it arrived.
type revisionCache struct {
	mu       sync.Mutex
	entries  map[string]revisionAnswer
	inflight map[string]*revisionCall
}

type revisionAnswer struct {
	started time.Time
	sha     string
	ref     string
}

type revisionCall struct {
	started time.Time
	done    chan struct{}
	answer  revisionAnswer
	err     error
}

// lookupResult says how a lookup was served, for the cache metrics.
type lookupResult string

const (
	lookupHit    lookupResult = "hit"
	lookupMiss   lookupResult = "miss"
	lookupShared lookupResult = "shared"
)

// lookup returns the commit rev names, running ls (detached from ctx: other
// requests may be waiting on it too) when no answer at least as new as
// notBefore exists.
func (c *revisionCache) lookup(ctx context.Context, rev string, notBefore time.Time,
	ls func() (sha, ref string, err error),
) (revisionAnswer, lookupResult, error) {
	c.mu.Lock()
	if c.entries == nil {
		c.entries, c.inflight = map[string]revisionAnswer{}, map[string]*revisionCall{}
	}
	if a, ok := c.entries[rev]; ok && !a.started.Before(notBefore) {
		c.mu.Unlock()
		return a, lookupHit, nil
	}
	call, result := c.inflight[rev], lookupShared
	if call == nil || call.started.Before(notBefore) {
		call, result = &revisionCall{started: time.Now(), done: make(chan struct{})}, lookupMiss
		c.inflight[rev] = call
		go c.run(rev, call, ls)
	}
	c.mu.Unlock()
	select {
	case <-call.done:
		return call.answer, result, call.err
	case <-ctx.Done():
		return revisionAnswer{}, result, fmt.Errorf("resolve revision %s: %w", rev, ctx.Err())
	}
}

func (c *revisionCache) run(rev string, call *revisionCall, ls func() (string, string, error)) {
	sha, ref, err := ls()
	c.mu.Lock()
	call.answer, call.err = revisionAnswer{started: call.started, sha: sha, ref: ref}, err
	if err == nil {
		if a, ok := c.entries[rev]; !ok || a.started.Before(call.started) {
			c.entries[rev] = call.answer
		}
	}
	if c.inflight[rev] == call {
		delete(c.inflight, rev)
	}
	c.mu.Unlock()
	close(call.done)
}

// forget drops the cached answer for rev, so the next lookup asks the remote.
func (c *revisionCache) forget(rev string) {
	c.mu.Lock()
	delete(c.entries, rev)
	c.mu.Unlock()
}
