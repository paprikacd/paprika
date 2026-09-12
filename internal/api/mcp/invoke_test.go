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

// TestConfirmationBindingRejectsCollidingLargeIntegers is fix round 1: it
// guards against decoding arguments into map[string]any, which coerces every
// JSON number to float64. Above 2^53, distinct integer literals can round to
// the identical float64 and therefore normalize to byte-identical JSON,
// hashing identically. literalA and literalB below are the standard example
// of that collision. If stripConfirmationToken loses the distinction, a
// token issued while confirming literalA would also authorize literalB —
// exactly the mismatch the confirmation mechanism exists to prevent.
//
// confirmedB is built by direct string concatenation, not via
// withConfirmation: withConfirmation itself round-trips through
// map[string]any and would silently corrupt these literals before the test
// even reached the Invoker. Constructing the raw bytes directly matches what
// an MCP client sending literal JSON over the wire actually does.
func TestConfirmationBindingRejectsCollidingLargeIntegers(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	const literalA = `10000000000000000`
	const literalB = `10000000000000001`

	argsA := json.RawMessage(`{"revision":` + literalA + `}`)
	_, err := inv.Call(context.Background(), p, "rollback_release", argsA)
	var need *ConfirmationRequiredError
	require.ErrorAs(t, err, &need)
	require.NotEmpty(t, need.Token)

	confirmedB := json.RawMessage(
		`{"revision":` + literalB + `,"confirmation_token":"` + need.Token + `"}`)

	_, err = inv.Call(context.Background(), p, "rollback_release", confirmedB)
	assert.ErrorIs(t, err, ErrConfirmMismatch,
		"a token issued for one integer literal must not authorize a distinct colliding literal")
}

// TestConfirmationRoundTripWithNumericArgumentSucceeds is the companion to
// the collision test above: an ordinary numeric argument, unchanged between
// the two calls, must still confirm and execute normally.
func TestConfirmationRoundTripWithNumericArgumentSucceeds(t *testing.T) {
	inv, _ := newTestInvoker(t)
	p := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}
	args := json.RawMessage(`{"revision":42}`)

	_, err := inv.Call(context.Background(), p, "rollback_release", args)
	var need *ConfirmationRequiredError
	require.ErrorAs(t, err, &need)
	require.NotEmpty(t, need.Token)

	confirmed := json.RawMessage(`{"revision":42,"confirmation_token":"` + need.Token + `"}`)
	result, err := inv.Call(context.Background(), p, "rollback_release", confirmed)
	require.NoError(t, err, "an unchanged numeric argument must still confirm cleanly")
	assert.Equal(t, map[string]string{"ok": "rollback_release"}, result)
}

// TestStripConfirmationTokenNormalizesNullSameAsEmpty is fix round 1,
// finding 2: literal JSON null must normalize identically to absent/empty
// arguments, not survive as the literal "null".
func TestStripConfirmationTokenNormalizesNullSameAsEmpty(t *testing.T) {
	bareEmpty, tokenEmpty, err := stripConfirmationToken(json.RawMessage(``))
	require.NoError(t, err)
	assert.Empty(t, tokenEmpty)
	assert.Equal(t, "{}", string(bareEmpty))

	bareNull, tokenNull, err := stripConfirmationToken(json.RawMessage(`null`))
	require.NoError(t, err)
	assert.Empty(t, tokenNull)
	assert.Equal(t, "{}", string(bareNull),
		"null arguments must normalize to an empty object, not the literal null")

	assert.Equal(t, string(bareEmpty), string(bareNull))
}
