package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
)

func TestCallDeniesWriteToolWithReadScope(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, err := inv.Call(context.Background(), p, "sync_application",
		json.RawMessage(`{"name":"web","namespace":"prod"}`))
	assert.ErrorIs(t, err, ErrScopeDenied)
}

func TestCallAllowsReadToolWithReadScope(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, err := inv.Call(context.Background(), p, "fleet_status", json.RawMessage(`{}`))
	require.NoError(t, err)
}

func TestCallDeniedWriteIsAudited(t *testing.T) {
	inv, aud := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	_, _ = inv.Call(context.Background(), p, "sync_application", json.RawMessage(`{}`))

	require.Len(t, aud.events, 1, "a denied write must leave a record")
	assert.False(t, aud.events[0].Success)
	assert.Equal(t, "u1", aud.events[0].Principal)
}

func TestCallDestructiveToolRequiresConfirmation(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	_, err := inv.Call(context.Background(), p, "rollback_release",
		json.RawMessage(`{"name":"web","namespace":"prod"}`))

	var need *ConfirmationRequiredError
	require.ErrorAs(t, err, &need)
	assert.NotEmpty(t, need.Token)
	assert.NotEmpty(t, need.Preview)
}

func TestCallUnknownToolIsNotFound(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}
	_, err := inv.Call(context.Background(), p, "no_such_tool", json.RawMessage(`{}`))
	assert.ErrorIs(t, err, ErrToolNotFound)
}

// TestCallConfirmationRoundTripExecutes proves the trap in the brief is
// avoided: a destructive call with no token returns a ConfirmationRequiredError
// carrying a token; sending that same token back with the SAME arguments must
// execute the tool, not fail with ErrConfirmMismatch. If the Invoker hashed
// raw argument bytes instead of normalizing away confirmation_token
// identically on both paths, this test fails every time.
func TestCallConfirmationRoundTripExecutes(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}
	args := json.RawMessage(`{"name":"web","namespace":"prod"}`)

	_, err := inv.Call(context.Background(), p, "rollback_release", args)
	var need *ConfirmationRequiredError
	require.ErrorAs(t, err, &need)
	require.NotEmpty(t, need.Token)

	confirmedArgs, err := withConfirmation(args, need.Token)
	require.NoError(t, err)

	result, err := inv.Call(context.Background(), p, "rollback_release", confirmedArgs)
	require.NoError(t, err, "a correctly confirmed call must execute, not mismatch")
	assert.Equal(t, map[string]string{"ok": "rollback_release"}, result)
}
