package mcp

import "strings"

// Scope is an OAuth scope value governing what a credential may do. It is
// deliberately independent of the Authorizer, which governs what a human may
// do; both gates must pass.
type Scope string

const (
	ScopeRead  Scope = "paprika:read"
	ScopeWrite Scope = "paprika:write"
)

// ParseScopes splits a space-delimited scope claim (RFC 6749 section 3.3) and
// drops values Paprika does not define, so an unrecognised scope can never
// widen access.
func ParseScopes(raw string) []Scope {
	var out []Scope
	for _, field := range strings.Fields(raw) {
		switch Scope(field) {
		case ScopeRead:
			out = append(out, ScopeRead)
		case ScopeWrite:
			out = append(out, ScopeWrite)
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
