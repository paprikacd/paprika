package mcp

import (
	"context"
	"encoding/json"
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
