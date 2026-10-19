package satellitecontrol

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/types"

	paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

// ErrSatelliteOffline means no stream is attached for that registration. It is
// a normal state, not a failure: a satellite that is restarting or partitioned
// has no link, and a caller must decide what to do about that rather than
// having the hub invent a result.
var ErrSatelliteOffline = errors.New("satellite is not connected")

// DefaultTaskTimeout bounds one dispatched task. An apply is the slowest thing
// a satellite does, so the ceiling is generous but finite: a task with no
// answer must fail rather than pin a caller forever.
const DefaultTaskTimeout = 2 * time.Minute

// Hub tracks the live satellite links, one per Cluster registration.
//
// A registration has at most one link: the satellite runs as a single replica
// with a Recreate strategy, and a second concurrent stream for the same cluster
// would mean two reconcilers acting on one cluster. Attaching a new link
// detaches the previous one, which is what a satellite restart looks like.
type Hub struct {
	mu    sync.Mutex
	links map[types.NamespacedName]*Link
}

// NewHub returns an empty hub.
func NewHub() *Hub { return &Hub{links: make(map[types.NamespacedName]*Link)} }

// Link is one attached stream's task surface. Its fields stay unexported: the
// only supported operations are the hub's Dispatch and the stream that owns it.
type Link struct {
	out     chan *paprikav1.SatelliteTask
	mu      sync.Mutex
	waiting map[string]chan *paprikav1.SatelliteTaskResult
	closed  bool
}

func newSatelliteLink() *Link {
	return &Link{
		out:     make(chan *paprikav1.SatelliteTask),
		waiting: make(map[string]chan *paprikav1.SatelliteTaskResult),
	}
}

// Attach registers a link for a cluster and returns it. Any previous link for
// the same registration is closed, so its in-flight dispatches fail rather than
// waiting on a connection nobody will read.
func (h *Hub) Attach(key types.NamespacedName) *Link {
	link := newSatelliteLink()
	h.mu.Lock()
	previous := h.links[key]
	h.links[key] = link
	h.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	return link
}

// Detach removes link if it is still the registered one. A stale detach — an
// old stream closing after its replacement attached — leaves the replacement
// alone.
func (h *Hub) Detach(key types.NamespacedName, link *Link) {
	h.mu.Lock()
	if h.links[key] == link {
		delete(h.links, key)
	}
	h.mu.Unlock()
	link.close()
}

// Connected reports whether a link is attached for the registration.
func (h *Hub) Connected(key types.NamespacedName) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.links[key]
	return ok
}

// Dispatch sends one task down a cluster's link and waits for its result.
//
// The task's ID is assigned here so correlation never depends on a caller
// remembering to set one. A nil error means the satellite answered; whether the
// work succeeded is `result.Ok`.
func (h *Hub) Dispatch(
	ctx context.Context,
	key types.NamespacedName,
	task *paprikav1.SatelliteTask,
) (*paprikav1.SatelliteTaskResult, error) {
	h.mu.Lock()
	link, ok := h.links[key]
	h.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s/%s", ErrSatelliteOffline, key.Namespace, key.Name)
	}

	id, err := newTaskID()
	if err != nil {
		return nil, err
	}
	task.Id = id

	result := make(chan *paprikav1.SatelliteTaskResult, 1)
	link.mu.Lock()
	if link.closed {
		link.mu.Unlock()
		return nil, fmt.Errorf("%w: %s/%s", ErrSatelliteOffline, key.Namespace, key.Name)
	}
	link.waiting[id] = result
	link.mu.Unlock()
	defer link.forget(id)

	select {
	case link.out <- task:
	case <-ctx.Done():
		return nil, fmt.Errorf("dispatch to %s/%s: %w", key.Namespace, key.Name, ctx.Err())
	}

	select {
	case res := <-result:
		return res, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("await result from %s/%s: %w", key.Namespace, key.Name, ctx.Err())
	}
}

// complete routes a satellite's result to whoever is waiting for that task. An
// unknown ID is dropped: it is either a duplicate delivery or a result for a
// dispatch that already timed out, and neither has a listener to satisfy.
func (l *Link) complete(result *paprikav1.SatelliteTaskResult) {
	l.mu.Lock()
	waiter := l.waiting[result.GetId()]
	l.mu.Unlock()
	if waiter == nil {
		return
	}
	select {
	case waiter <- result:
	default:
	}
}

func (l *Link) forget(id string) {
	l.mu.Lock()
	delete(l.waiting, id)
	l.mu.Unlock()
}

// close stops accepting dispatches and wakes every waiter with an offline
// error by leaving them to their contexts. Waiters hold their own deadlines, so
// there is nothing to broadcast; closing the flag is enough to make new
// dispatches fail immediately.
func (l *Link) close() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
}

func newTaskID() (string, error) {
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", fmt.Errorf("generate task id: %w", err)
	}
	return hex.EncodeToString(id[:]), nil
}
