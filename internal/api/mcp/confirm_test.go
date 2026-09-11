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
}

func TestConfirmRejectsDifferentPrincipal(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-2", "rollback_release", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)
}

func TestConfirmRejectsDifferentTool(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	args := json.RawMessage(`{"name":"web"}`)
	token, err := c.Issue(context.Background(), "user-1", "rollback_release", args)
	require.NoError(t, err)

	err = c.Consume(context.Background(), token, "user-1", "abort_rollout", args)
	assert.ErrorIs(t, err, ErrConfirmMismatch)
}

func TestConfirmUnknownTokenIsInvalid(t *testing.T) {
	c := newConfirmer(t, time.Minute)
	err := c.Consume(context.Background(), "nonexistent", "user-1", "rollback_release",
		json.RawMessage(`{}`))
	assert.ErrorIs(t, err, ErrConfirmInvalid)
}
