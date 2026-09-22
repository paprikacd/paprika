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
//
// For a destructive tool this test must distinguish two very different
// sources of an audit event on the second (confirmed) call: the real
// interceptor, which only runs once the call has actually reached Connect,
// versus Invoker.auditReject, which fires when Confirmer.Consume itself
// rejects the token and never lets the call reach Connect at all. Both write
// into the SAME recording auditor with the SAME Principal ("u1"), so a bare
// "non-empty, principal matches" check would pass on a rejection record and
// wrongly report the tool as audited by the production path when it was
// never invoked. This is guarded against two ways: the second call's error
// is checked to rule out a confirmation-gate rejection instead of being
// discarded, and the last event's shape (Resource, Extra["method"]) is
// asserted to differ from what auditReject writes (Resource: "mcp_tool", no
// Extra) — see NewAuditInterceptor (internal/api/audit_middleware.go) versus
// Invoker.auditReject (invoke.go) for the two shapes being distinguished.
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

			_, err := inv.Call(ctx, writer, tool.Name, args)
			// The stub Connect handler answers every RPC with
			// CodeUnimplemented, so a call that genuinely reached Connect
			// still returns a non-nil error — that is expected and is not
			// what this checks. What must NOT happen is the call failing
			// the confirmation gate itself: that would mean Consume never
			// let the call reach Invoke, so the interceptor never ran, and
			// the test must fail loudly here rather than limping on to
			// inspect a stale or rejection-sourced event.
			var need *ConfirmationRequiredError
			require.NotErrorAs(t, err, &need,
				"%s: second call still requires confirmation", tool.Name)
			require.NotErrorIs(t, err, ErrConfirmInvalid, "%s: confirmation rejected", tool.Name)
			require.NotErrorIs(t, err, ErrConfirmUsed, "%s: confirmation rejected", tool.Name)
			require.NotErrorIs(t, err, ErrConfirmMismatch, "%s: confirmation rejected", tool.Name)

			require.NotEmpty(t, aud.events, "%s produced no audit record", tool.Name)
			last := aud.events[len(aud.events)-1]
			assert.Equal(t, "u1", last.Principal)
			assert.NotEqual(t, "mcp_tool", last.Resource,
				"%s: last audit record came from Invoker's rejection path, not the interceptor", tool.Name)
			assert.NotEmpty(t, last.Extra["method"],
				"%s: last audit record is missing the interceptor's method tag", tool.Name)
		})
	}
}

// TestEveryDestructiveToolRefusesWithoutConfirmation is invariant 3: every
// destructive tool refuses to execute on first call, returning
// *ConfirmationRequiredError rather than mutating.
//
// "Refuses to execute" is asserted two ways, not just by the returned error's
// type: every write tool's RPC is mutating (see auditVerbs in
// internal/api/audit_middleware.go), so NewAuditInterceptor records an event
// for it the moment it reaches Connect, regardless of whether that RPC call
// itself succeeds. An empty recordingAuditor after the first call is
// therefore direct, independent evidence that nothing was dispatched to
// Connect, rather than resting solely on reading gateDestructive's control
// flow via the error's type.
func TestEveryDestructiveToolRefusesWithoutConfirmation(t *testing.T) {
	r := NewRegistry()
	require.NoError(t, RegisterWriteTools(r))
	writer := &auth.Principal{Subject: "u1", Scopes: []string{string(ScopeWrite)}}

	for _, tool := range r.All() {
		if !tool.Destructive {
			continue
		}
		t.Run(tool.Name, func(t *testing.T) {
			inv, aud := newInvokerForRegistry(t, r)
			_, err := inv.Call(context.Background(), writer, tool.Name,
				json.RawMessage(`{"name":"web","namespace":"prod"}`))
			var need *ConfirmationRequiredError
			assert.ErrorAs(t, err, &need,
				"%s must not execute on first call", tool.Name)
			assert.Empty(t, aud.events,
				"%s: an RPC reached Connect on the first call despite no confirmation", tool.Name)
		})
	}
}
