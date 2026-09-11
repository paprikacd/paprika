package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
)

// TestNoWriteToolReachableWithReadScope is invariant 1: no write tool is
// reachable with a read-scoped token. It iterates the registry so a tool
// added later is covered automatically, rather than relying on a hardcoded
// list of tool names.
func TestNoWriteToolReachableWithReadScope(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))
	inv, _ := newInvokerForRegistry(t, r)
	readOnly := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeRead)}}

	for _, tool := range r.All() {
		if tool.Scope != ScopeWrite {
			continue
		}
		t.Run(tool.Name, func(t *testing.T) {
			_, err := inv.Call(context.Background(), readOnly, tool.Name, json.RawMessage(`{}`))
			require.Error(t, err, "%s must be unreachable with read scope", tool.Name)
			assert.ErrorIs(t, err, ErrScopeDenied)
		})
	}
}

// TestEveryWriteToolIsAudited is invariant 2: every write tool produces an
// audit record carrying the acting principal. Audit for a successful call
// comes from the real Connect audit interceptor (wired in by
// newInvokerForRegistry), not from the Invoker itself: the interceptor reads
// the principal off the request context via auth.PrincipalFromContext, the
// same way it would once an authenticated MCP request's principal has been
// attached upstream of Invoker.Call. newInvokerForRegistry's stub chain has
// no auth interceptor of its own to perform that attachment (it wires only
// the audit interceptor, to exercise the production audit path without a
// full OAuth round trip), so this test attaches the principal itself.
func TestEveryWriteToolIsAudited(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	writer := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	for _, tool := range r.All() {
		t.Run(tool.Name, func(t *testing.T) {
			inv, aud := newInvokerForRegistry(t, r)
			ctx := auth.WithPrincipal(context.Background(), writer)
			args := json.RawMessage(`{"name":"web","namespace":"prod"}`)

			if tool.Destructive {
				_, err := inv.Call(ctx, writer, tool.Name, args)
				var need *ConfirmationRequiredError
				require.ErrorAs(t, err, &need)
				args, _ = withConfirmation(args, need.Token)
			}
			_, _ = inv.Call(ctx, writer, tool.Name, args)

			require.NotEmpty(t, aud.events, "%s produced no audit record", tool.Name)
			assert.Equal(t, "u1", aud.events[len(aud.events)-1].Principal)
		})
	}
}

// TestEveryDestructiveToolRefusesWithoutConfirmation is invariant 3: every
// destructive tool refuses to execute on first call, returning
// *ConfirmationRequiredError rather than mutating.
func TestEveryDestructiveToolRefusesWithoutConfirmation(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	inv, _ := newInvokerForRegistry(t, r)
	writer := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	for _, tool := range r.All() {
		if !tool.Destructive {
			continue
		}
		t.Run(tool.Name, func(t *testing.T) {
			_, err := inv.Call(context.Background(), writer, tool.Name,
				json.RawMessage(`{"name":"web","namespace":"prod"}`))
			var need *ConfirmationRequiredError
			assert.ErrorAs(t, err, &need,
				"%s must not execute on first call", tool.Name)
		})
	}
}
