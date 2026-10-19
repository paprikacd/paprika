package mcp

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/cache"
)

func newConfirmer(t *testing.T, ttl time.Duration) *Confirmer {
	t.Helper()
	c, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	return NewConfirmer(c, ttl)
}

func TestConfirmRoundTrip(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web","namespace":"prod"}`)

	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)
	require.NotEmpty(t, token)

	require.NoError(t, c.Consume(context.Background(), token, "user-1", "rollback_release", args))
}

func TestConfirmIsSingleUse(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	require.NoError(t, c.Consume(context.Background(), token, "user-1", "rollback_release", args))
	err = c.Consume(context.Background(), token, "user-1", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmUsed)
}

func TestConfirmRejectsDifferentArguments(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release",
		json.RawMessage(`{"name":"staging"}`))
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-1", "rollback_release",
		json.RawMessage(`{"name":"prod"}`))
	assert.ErrorIs(t, err, ErrConfirmMismatch,
		"confirmation for one target must not authorise another")

	// A mismatched attempt must burn the token, not just fail: otherwise a
	// caller could keep guessing arguments against a still-live
	// confirmation. A correct follow-up must now find it already used, not
	// succeed and not report the vaguer "invalid".
	err = c.Consume(context.Background(), token, "user-1", "rollback_release",
		json.RawMessage(`{"name":"staging"}`))
	assert.ErrorIs(t, err, ErrConfirmUsed,
		"a mismatched attempt must burn the token so it cannot be probed again")
}

func TestConfirmRejectsDifferentPrincipal(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-2", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)

	// The wrong-principal attempt must have burned the token: the rightful
	// principal must not be able to consume it afterwards either.
	err = c.Consume(context.Background(), token, "user-1", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmUsed,
		"a mismatched attempt must burn the token so it cannot be probed again")
}

func TestConfirmRejectsDifferentTool(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-1", "abort_rollout", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)

	// The wrong-tool attempt must have burned the token: it must not still
	// be consumable against the tool it was actually issued for.
	err = c.Consume(context.Background(), token, "user-1", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmUsed,
		"a mismatched attempt must burn the token so it cannot be probed again")
}

func TestConfirmUnknownTokenIsInvalid(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	err := c.Consume(context.Background(), "nonexistent", "user-1", "rollback_release",
		json.RawMessage(`{}`))
	assert.ErrorIs(t, err, ErrConfirmInvalid)
}

func TestConfirmConcurrentConsumersSpendTokenOnce(t *testing.T) {
	backing, err := cache.New(context.Background(), cache.Config{Backend: cache.BackendMemory})
	require.NoError(t, err)
	c := NewConfirmer(newPairedGetStore(backing), time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	errs := make(chan error, 2)
	for range 2 {
		go func() {
			errs <- c.Consume(context.Background(), token, "user-1", "rollback_release", args)
		}()
	}
	succeeded := 0
	for range 2 {
		if err := <-errs; err == nil {
			succeeded++
		} else {
			assert.ErrorIs(t, err, ErrConfirmInvalid)
		}
	}
	assert.Equal(t, 1, succeeded,
		"one confirmation must authorise exactly one destructive call, even when two arrive together")
}

// pairedGetStore holds the first Get of each key, after it has read, until a
// second Get of the same key has read too, so two concurrent consumers both
// observe every key before either moves on: the interleaving in which a
// read-then-delete retirement lets both of them see the live record.
type pairedGetStore struct {
	confirmStore

	mu       sync.Mutex
	gates    map[string]chan struct{}
	released map[string]bool
}

func newPairedGetStore(backing confirmStore) *pairedGetStore {
	return &pairedGetStore{
		confirmStore: backing,
		gates:        map[string]chan struct{}{},
		released:     map[string]bool{},
	}
}

func (s *pairedGetStore) Get(ctx context.Context, key string) ([]byte, error) {
	value, err := s.confirmStore.Get(ctx, key)
	s.mu.Lock()
	gate, waiting := s.gates[key]
	switch {
	case s.released[key]:
		s.mu.Unlock()
	case waiting:
		s.released[key] = true
		s.mu.Unlock()
		close(gate)
	default:
		gate = make(chan struct{})
		s.gates[key] = gate
		s.mu.Unlock()
		select {
		case <-gate:
		case <-time.After(5 * time.Second):
		}
	}
	return value, err
}
