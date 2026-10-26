package mcp

import "strings"

// Scope is an OAuth scope value governing what a credential may do. It is
// deliberately independent of the Authorizer, which governs what a human may
// do; both gates must pass.
type Scope string

const (
	ScopeRead  Scope = "paprika:read"
	ScopeWrite Scope = "paprika:write"
	// ScopeObserve grants read-only access to the observability gateway's
	// MCP tools (logs, metrics, traces queries). It is deliberately separate
	// from ScopeRead: fleet/console data and observability backends are
	// different trust domains, and the observability gateway validates its
	// own token audience, so a console token can never be replayed there.
	ScopeObserve Scope = "paprika:observe"
	// ScopeInsightsWrite grants authoring of saved queries and dashboards on
	// the Observe surface. It grants no provider configuration or fleet writes.
	// Existing observe-only credentials remain read-only.
	ScopeInsightsWrite Scope = "paprika:insights:write"
)

// ParseScopes splits a space-delimited scope claim (RFC 6749 section 3.3) and
// drops values Paprika does not define, so an unrecognised scope can never
// widen access.
func ParseScopes(raw string) []Scope {
	var out []Scope
	for _, field := range strings.Fields(raw) {
		if isKnownScope(Scope(field)) {
			out = append(out, Scope(field))
		}
	}
	return out
}

// HasScope reports whether required is present in granted. There is no
// hierarchy: write does not imply read, and read never implies write.
func HasScope(granted []Scope, required Scope) bool {
	for _, s := range granted {
		if s == required {
			return true
		}
	}
	return false
}

func isKnownScope(scope Scope) bool {
	switch scope {
	case ScopeRead, ScopeWrite, ScopeObserve, ScopeInsightsWrite:
		return true
	default:
		return false
	}
}
