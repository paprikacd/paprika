package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
)

// confirmationTokenField is the argument key a caller adds to a destructive
// tool call once it has a confirmation token. It is never sent to Connect as
// part of the tool's own argument struct — tool Invoke funcs simply ignore
// it, since Go's JSON decoding drops unknown fields by default.
const confirmationTokenField = "confirmation_token"

var (
	// ErrToolNotFound is returned when Call is given a name the registry does
	// not know.
	ErrToolNotFound = errors.New("tool not found")
	// ErrScopeDenied is returned when the principal's scopes do not include
	// the tool's declared Scope. This check happens before any Connect call.
	ErrScopeDenied = errors.New("tool requires a scope this credential lacks")
)

// ConfirmationRequiredError is returned instead of executing a destructive
// tool on its first call. It is a struct rather than a sentinel because it
// carries the preview and token the handler renders back to the model.
type ConfirmationRequiredError struct {
	Tool    string
	Token   string
	Preview string
}

func (e *ConfirmationRequiredError) Error() string {
	return fmt.Sprintf("tool %q requires confirmation: %s", e.Tool, e.Preview)
}

// Invoker enforces scope and confirmation gating in front of the tool
// registry, then dispatches into the tool's own Invoke func. Order of
// operations is fixed: lookup, scope check, confirmation gate, invoke — see
// Call's doc comment.
type Invoker struct {
	registry  *Registry
	client    v1connect.PaprikaServiceClient
	confirmer *Confirmer
	auditor   audit.Auditor
}

// NewInvoker builds an Invoker. client is passed through to every tool's
// Invoke func unchanged.
func NewInvoker(r *Registry, client v1connect.PaprikaServiceClient, conf *Confirmer, aud audit.Auditor) *Invoker {
	if aud == nil {
		aud = audit.NoopAuditor{}
	}
	return &Invoker{registry: r, client: client, confirmer: conf, auditor: aud}
}

// Call runs one MCP tool call end to end:
//
//  1. Look up the tool. Unknown -> ErrToolNotFound.
//  2. Check the tool's declared Scope against the principal's scopes.
//     Missing -> audit a failure event, then ErrScopeDenied. This happens
//     before any Connect call, so a denied write never reaches the handler.
//  3. If the tool is Destructive and the arguments carry no
//     confirmation_token -> issue one via the Confirmer and return a
//     *ConfirmationRequiredError carrying the token and a preview. No
//     mutation occurs on this path.
//  4. If Destructive with a token -> Confirmer.Consume. A failure is
//     audited and its error (ErrConfirmInvalid / ErrConfirmUsed /
//     ErrConfirmMismatch) returned unchanged.
//  5. Invoke the tool, passing the Connect client through.
//
// Audit for calls that reach step 5 comes from the Connect interceptor
// chain, not from here — emitting an audit event for those would
// double-record every write. Call only emits audit events for requests it
// rejects before ever reaching Connect.
func (i *Invoker) Call(ctx context.Context, p *auth.Principal, name string, args json.RawMessage) (any, error) {
	tool, ok := i.registry.Lookup(name)
	if !ok {
		return nil, ErrToolNotFound
	}

	if !principalHasScope(p, tool.Scope) {
		i.auditReject(ctx, p, "mcp_scope_denied", tool.Name, ErrScopeDenied.Error())
		return nil, ErrScopeDenied
	}

	if tool.Destructive {
		if confirmErr := i.gateDestructive(ctx, p, tool.Name, args); confirmErr != nil {
			return nil, confirmErr
		}
	}

	return tool.Invoke(ctx, i.client, args)
}

// gateDestructive implements steps 3 and 4 of Call for a destructive tool:
// issue a confirmation token on a first call, or consume one presented on a
// second call. A non-nil return is always what Call should return in place
// of invoking the tool — either a *ConfirmationRequiredError (no mutation
// occurred) or a Confirmer error (mapped straight through, and audited since
// it never reaches Connect).
func (i *Invoker) gateDestructive(ctx context.Context, p *auth.Principal, toolName string, args json.RawMessage) error {
	bare, token, err := stripConfirmationToken(args)
	if err != nil {
		return fmt.Errorf("mcp: parse arguments: %w", err)
	}

	if token == "" {
		issued, err := i.confirmer.Issue(ctx, p.Subject, toolName, bare)
		if err != nil {
			return fmt.Errorf("mcp: issue confirmation: %w", err)
		}
		return &ConfirmationRequiredError{
			Tool:    toolName,
			Token:   issued,
			Preview: previewFor(toolName, bare),
		}
	}

	if err := i.confirmer.Consume(ctx, token, p.Subject, toolName, bare); err != nil {
		i.auditReject(ctx, p, "mcp_confirmation_failed", toolName, err.Error())
		return err
	}
	return nil
}

// auditReject records a request Call rejected before it ever reached
// Connect. Both call sites in Call pass a false-Success event; this helper
// exists so the two record the same shape.
func (i *Invoker) auditReject(ctx context.Context, p *auth.Principal, action, tool, reason string) {
	var principal string
	if p != nil {
		principal = p.Subject
	}
	i.auditor.Record(ctx, audit.Event{
		Principal: principal,
		Action:    action,
		Resource:  "mcp_tool",
		Name:      tool,
		Success:   false,
		Error:     reason,
	})
}

// principalHasScope reports whether p carries the scope a tool requires.
// There is no hierarchy, matching HasScope: write does not imply read.
func principalHasScope(p *auth.Principal, required Scope) bool {
	if p == nil {
		return false
	}
	granted := make([]Scope, len(p.Scopes))
	for idx, s := range p.Scopes {
		granted[idx] = Scope(s)
	}
	return HasScope(granted, required)
}

// stripConfirmationToken separates a destructive tool call's confirmation
// token from the rest of its arguments and returns the remaining arguments
// re-marshalled in Go's deterministic sorted-key order.
//
// This normalization is THE load-bearing step of the confirmation flow: the
// Confirmer binds a token to a SHA-256 of the raw argument bytes it is
// handed, with no canonicalization of its own. Issue is called with
// arguments that do not yet contain confirmation_token; Consume is later
// called with the same arguments plus that field. If those two calls hashed
// their input bytes as received, the hashes would never match — every
// destructive tool would fail confirmation forever. Routing both call sites
// in Call through this single function guarantees they hash identical
// bytes: unmarshal-then-remarshal is only safe to use as a normalization
// because it is applied identically on both paths.
func stripConfirmationToken(args json.RawMessage) (bare json.RawMessage, token string, err error) {
	obj := map[string]any{}
	if len(args) > 0 {
		if err = json.Unmarshal(args, &obj); err != nil {
			return nil, "", fmt.Errorf("mcp: unmarshal arguments: %w", err)
		}
	}

	if raw, ok := obj[confirmationTokenField]; ok {
		if s, ok := raw.(string); ok {
			token = s
		}
		delete(obj, confirmationTokenField)
	}

	bare, err = json.Marshal(obj)
	if err != nil {
		return nil, "", fmt.Errorf("mcp: marshal normalized arguments: %w", err)
	}
	return bare, token, nil
}

// previewFor renders a human-readable summary of a pending destructive call
// for the confirmation prompt. bare is the already-stripped argument set, so
// the preview never echoes a token back at the caller.
func previewFor(toolName string, bare json.RawMessage) string {
	return fmt.Sprintf("About to run %q with arguments %s. This action is destructive and requires confirmation.",
		toolName, string(bare))
}
