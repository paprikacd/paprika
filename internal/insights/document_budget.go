package insights

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// documentBodyBudget caps the request-body bytes that saves and dry runs hold in
// memory at once, across every connection. It is 32 MiB, a fraction of the 256 MiB
// pod, and a save or dry run takes its bytes as they arrive.
const documentBodyBudget = 32 << 20

var errDocumentReadCapacity = errors.New("dashboard document read capacity reached")

// byteBudget is a counting semaphore over bytes. A caller that cannot reserve gets
// the channel the next release closes, so it can wait and then try again.
type byteBudget struct {
	mu       sync.Mutex
	capacity int64
	used     int64
	freed    chan struct{}
}

func newByteBudget(capacity int64) *byteBudget {
	return &byteBudget{capacity: capacity, freed: make(chan struct{})}
}

// reserve takes n bytes if they fit. Otherwise it reports false and the channel that
// closes on the next release.
func (b *byteBudget) reserve(n int64) (<-chan struct{}, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.used+n <= b.capacity {
		b.used += n
		return nil, true
	}
	return b.freed, false
}

func (b *byteBudget) release(n int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.used -= n
	close(b.freed)
	b.freed = make(chan struct{})
}

func (b *byteBudget) inUse() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.used
}

// reserveBodyBytes takes n bytes from the body budget. A request that finds the
// budget full waits up to documentWaitTimeout, and at most cap(documentWaiting)
// requests may wait at once. It returns errDocumentReadCapacity when the wait ends or
// the waiting queue is full, and the context's error when the caller goes away first.
func (s *Server) reserveBodyBytes(ctx context.Context, n int64) error {
	wait, ok := s.documentBytes.reserve(n)
	if ok {
		return nil
	}
	select {
	case s.documentWaiting <- struct{}{}:
		defer func() { <-s.documentWaiting }()
	default:
		return errDocumentReadCapacity
	}
	timer := time.NewTimer(s.documentWaitTimeout)
	defer timer.Stop()
	for {
		select {
		case <-wait:
		case <-timer.C:
			return errDocumentReadCapacity
		case <-ctx.Done():
			return fmt.Errorf("dashboard upload admission context: %w", ctx.Err())
		}
		if wait, ok = s.documentBytes.reserve(n); ok {
			return nil
		}
	}
}

// documentBody counts the bytes a handler reads from a request body against the body
// budget. Each read reserves the bytes it returned, so a body holds exactly the bytes
// that have arrived, and a read that blocks on the network holds nothing. release
// frees them. A read that cannot reserve fails, and err says why.
type documentBody struct {
	server *Server
	ctx    context.Context
	body   io.ReadCloser
	held   int64
	err    error
}

// budgetBody makes r's body count against the body budget. The caller releases the
// reservation with release, which is safe to call more than once.
func (s *Server) budgetBody(r *http.Request) *documentBody {
	b := &documentBody{server: s, ctx: r.Context(), body: r.Body}
	r.Body = b
	return b
}

func (b *documentBody) Read(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	n, err := b.body.Read(p)
	if n > 0 {
		if reserveErr := b.server.reserveBodyBytes(b.ctx, int64(n)); reserveErr != nil {
			b.err = reserveErr
			return 0, reserveErr
		}
		b.held += int64(n)
	}
	return n, err //nolint:wrapcheck // io.EOF must reach the decoder unchanged
}

func (b *documentBody) Close() error {
	return b.body.Close() //nolint:wrapcheck // the wrapped body's own close error
}

// release frees the bytes this body holds. Once it has run, the body reads nothing
// that counts against the budget.
func (b *documentBody) release() {
	if b.held == 0 {
		return
	}
	b.server.documentBytes.release(b.held)
	b.held = 0
}

// writeBodyError writes the response for a body read that failed. A refused
// reservation gets the 429 the other Insights admission errors use, with a one-second
// retry hint. A read that ended because the caller went away gets a 503. Any other
// failure is an invalid request.
func writeBodyError(w http.ResponseWriter, body *documentBody, invalid string) {
	switch {
	case errors.Is(body.err, errDocumentReadCapacity):
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusTooManyRequests, "too many active dashboard uploads; retry shortly")
	case body.err != nil:
		writeError(w, http.StatusServiceUnavailable, "dashboard upload ended before a read slot was free")
	default:
		writeError(w, http.StatusBadRequest, invalid)
	}
}
