// Package auth provides authentication and authorization middleware for the Paprika API.
package auth

import (
	"context"
	"fmt"
)

// Principal represents an authenticated user.
type Principal struct {
	Subject string
	Email   string
	Name    string
	Groups  []string
	Claims  map[string]interface{}
}

// IsInGroup returns true if the principal belongs to the given group.
func (p *Principal) IsInGroup(group string) bool {
	for _, g := range p.Groups {
		if g == group {
			return true
		}
	}
	return false
}

// HasScope returns true if the principal has the given claim value.
func (p *Principal) HasScope(key, value string) bool {
	if p.Claims == nil {
		return false
	}
	v, ok := p.Claims[key]
	if !ok {
		return false
	}
	switch val := v.(type) {
	case string:
		return val == value
	case []string:
		for _, s := range val {
			if s == value {
				return true
			}
		}
	case []interface{}:
		for _, s := range val {
			if fmt.Sprintf("%v", s) == value {
				return true
			}
		}
	}
	return false
}

// principalKey is the context key for the authenticated principal.
type principalKey struct{}

// WithPrincipal injects a principal into the context.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFromContext extracts the principal from context.
func PrincipalFromContext(ctx context.Context) *Principal {
	if p, ok := ctx.Value(principalKey{}).(*Principal); ok {
		return p
	}
	return nil
}
