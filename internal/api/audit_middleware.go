package apiserver

import (
	"context"
	"strings"
	"time"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/audit"
)

// auditVerbs maps a mutating RPC verb prefix to the audit Action it produces.
// RPCs whose method name does not begin with one of these verbs are treated as
// read-only (List/Get/Resolve/Render) and are not audited.
var auditVerbs = map[string]string{
	"Sync":     "update",
	"Apply":    "apply",
	"Approve":  "approve",
	"Reject":   "reject",
	"Rollback": "update",
	"Promote":  "promote",
	"Abort":    "update",
}

// NewAuditInterceptor returns a connect unary interceptor that records an audit
// event for each mutating RPC via the provided Auditor. If the auditor is nil,
// a NoopAuditor is used so the interceptor is a no-op.
//
// The interceptor must be installed after the auth interceptor
// (connect.WithInterceptors(authInterceptor, auditInterceptor)) so the
// authenticated principal is present in the request context.
func NewAuditInterceptor(a audit.Auditor) connect.UnaryInterceptorFunc {
	if a == nil {
		a = audit.NoopAuditor{}
	}
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			procedure := req.Spec().Procedure
			action, resource, mutating := classifyAudit(procedure)
			if !mutating {
				return next(ctx, req)
			}

			resp, err := next(ctx, req)

			event := audit.Event{
				Timestamp: time.Now().UTC().Format(time.RFC3339),
				Action:    action,
				Resource:  resource,
				Name:      nameFromRequest(req),
				Namespace: namespaceFromRequest(req),
				Success:   err == nil,
				Extra:     map[string]string{"method": procedure},
			}
			if p := auth.PrincipalFromContext(ctx); p != nil {
				event.Principal = principalString(p)
			}
			if err != nil {
				event.Error = err.Error()
			}
			a.Record(ctx, event)
			return resp, err
		}
	}
}

// classifyAudit splits the connect procedure (e.g.
// "/paprika.v1.PaprikaService/SyncApplication") into an audit action and
// resource kind. RPCs that are not mutating return mutating=false.
func classifyAudit(procedure string) (action, resource string, mutating bool) {
	method := procedure
	if idx := strings.LastIndex(procedure, "/"); idx >= 0 {
		method = procedure[idx+1:]
	}
	for verb, act := range auditVerbs {
		if strings.HasPrefix(method, verb) {
			return act, strings.TrimPrefix(method, verb), true
		}
	}
	return "", "", false
}

// principalString picks the most specific identifier on a Principal for the
// audit log: Subject, then Email, then display Name.
func principalString(p *auth.Principal) string {
	switch {
	case p == nil:
		return ""
	case p.Subject != "":
		return p.Subject
	case p.Email != "":
		return p.Email
	default:
		return p.Name
	}
}

// nameFromRequest extracts a Name field from the request message via its
// protobuf getter, if present.
func nameFromRequest(req connect.AnyRequest) string {
	type nameGetter interface {
		GetName() string
	}
	if g, ok := req.Any().(nameGetter); ok {
		return g.GetName()
	}
	return ""
}

// namespaceFromRequest extracts a Namespace field from the request message via
// its protobuf getter, if present.
func namespaceFromRequest(req connect.AnyRequest) string {
	type namespaceGetter interface {
		GetNamespace() string
	}
	if g, ok := req.Any().(namespaceGetter); ok {
		return g.GetNamespace()
	}
	return ""
}
