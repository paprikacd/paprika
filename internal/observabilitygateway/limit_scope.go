package observabilitygateway

import (
	"errors"
	"net/http"
)

// LimitScopeHeader names the admission limit that refused a gateway 429. Every
// 429 the gateway sends carries it, so a caller can tell a refusal that applies
// to one provider from one that applies to the whole gateway.
const LimitScopeHeader = "X-Paprika-Limit-Scope"

// LimitScope is the closed set of limits a gateway 429 can name.
type LimitScope string

const (
	// ScopeEdge is the HTTP admission in front of the work, catalog and
	// dashboard pools. It refuses before any provider is resolved.
	ScopeEdge LimitScope = "edge"
	// ScopeBudget is the gateway-wide execution budget: its concurrency slots
	// and their wait. Every provider is affected.
	ScopeBudget LimitScope = "budget"
	// ScopeProvider is one provider's bulkhead: its slots and its waiters.
	ScopeProvider LimitScope = "provider"
	// ScopeQueue is the admission queue that bounds every request the budget
	// holds, active or waiting.
	ScopeQueue LimitScope = "queue"
)

// scopedError tags a refusal with the limit that produced it. It unwraps to the
// Connect error, so the code, details and message are unchanged.
type scopedError struct {
	scope LimitScope
	err   error
}

func (e *scopedError) Error() string { return e.err.Error() }

func (e *scopedError) Unwrap() error { return e.err }

// withLimitScope tags err with scope. A nil error stays nil.
func withLimitScope(scope LimitScope, err error) error {
	if err == nil {
		return nil
	}
	return &scopedError{scope: scope, err: err}
}

// LimitScopeOf returns the scope a refusal names, and false when it names none.
func LimitScopeOf(err error) (LimitScope, bool) {
	var scoped *scopedError
	if errors.As(err, &scoped) {
		return scoped.scope, true
	}
	return "", false
}

// limitScopeHeaderValue is the header value for err. A refusal that names no
// scope is reported as budget: it is a gateway-wide refusal, not a provider's.
func limitScopeHeaderValue(err error) string {
	if scope, ok := LimitScopeOf(err); ok {
		return string(scope)
	}
	return string(ScopeBudget)
}

// SetLimitScopeHeader writes the scope header for a gateway 429.
func SetLimitScopeHeader(w http.ResponseWriter, scope LimitScope) {
	w.Header().Set(LimitScopeHeader, string(scope))
}
